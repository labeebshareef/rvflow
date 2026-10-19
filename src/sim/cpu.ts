import { decode, type Decoded } from "@/isa/encoding";
import { CAUSES, CSR_BY_ADDR, INTERRUPTS, MSTATUS as MS, csrName, type Priv } from "@/isa/csr";
import { expandC } from "@/isa/rvc";
import { hex32 } from "@/lib/format";
import { alu, compare } from "./alu";
import { controlFor } from "./control";
import * as fpu from "./fpu";
import { CLINT, DATA_BASE, STACK_TOP, TEXT_BASE } from "./memmap";
import { Memory } from "./memory";
import type { HaltInfo, MicroEvent, StepRecord } from "./trace";
import { Trap } from "./trap";
import { execVector, VLENB } from "./vector";

export { Trap } from "./trap";

export { DATA_BASE, STACK_TOP, TEXT_BASE } from "./memmap";

/**
 * What the program runs on top of:
 * - "rars": programs written in the app. Without a trap handler (mtvec = 0),
 *   ecall provides RARS-style services and other traps stop the run.
 * - "bare": a bare-metal ELF such as riscv-tests: every trap goes to mtvec;
 *   writes to `tohost` end the run.
 * - "linux": a static Linux user-mode ELF (as run by qemu-riscv32): ecall is
 *   a Linux system call (write, exit).
 */
export type Env = "rars" | "bare" | "linux";

export interface CpuOptions {
  env: Env;
  /** Allow misaligned loads and stores in hardware instead of trapping. */
  misaligned: boolean;
  /** Address of the HTIF `tohost` word (bare env). */
  tohost?: number;
}


const MSTATUS_WMASK = MS.SIE | MS.MIE | MS.SPIE | MS.MPIE | MS.SPP | MS.MPP | MS.FS | MS.VS | MS.MPRV | MS.SUM | MS.MXR | MS.TVM | MS.TW | MS.TSR;
const SSTATUS_MASK = MS.SIE | MS.SPIE | MS.SPP | MS.FS | MS.VS | MS.SUM | MS.MXR | MS.SD;
const MEDELEG_MASK = 0xb3ff;
const MIDELEG_MASK = 0x222;
const MIE_MASK = 0xaaa;
/** misa: MXL = 1 (32-bit) and A, B, C, D, F, I, M, S, U, V. */
export const MISA = ((1 << 30) | [0, 1, 2, 3, 5, 8, 12, 18, 20, 21].reduce((m, b) => m | (1 << b), 0)) >>> 0;
const INT_PRIORITY = [11, 3, 7, 9, 1, 5];
const BOX = 0xffffffff00000000n;
const M64 = 0xffffffffffffffffn;

/**
 * RV32IMAFDCBV core with M/S/U privilege modes. `step()` executes one
 * instruction and returns a full micro-event trace plus an undo journal;
 * `undo()` reverses it exactly.
 */
export class Cpu {
  regs = new Int32Array(32);
  fregs = new BigUint64Array(32);
  vregs = new Uint8Array(32 * VLENB);
  pc = TEXT_BASE;
  priv: Priv = 3;
  mem = new Memory();
  output = "";
  halted: HaltInfo | undefined;
  /** First address past the program's text; reaching it ends the run cleanly (rars env). */
  textEnd = TEXT_BASE;
  opts: CpuOptions = { env: "rars", misaligned: false };

  /** Simple CSRs stored by address. */
  csr = new Map<number, number>();
  cycle = 0n;
  instretC = 0n;
  mtime = 0n;
  mtimecmp = M64;
  msip = 0;
  vl = 0;
  vtype = 0x80000000;
  reservation: number | null = null;

  private journal: (() => void)[] = [];
  private events: MicroEvent[] = [];
  private wroteMinstret = false;
  private wroteMcycle = false;

  /** Instructions retired (for display). */
  get instret(): number {
    return Number(this.instretC);
  }

  reset(entry = TEXT_BASE, opts?: Partial<CpuOptions>): void {
    if (opts) this.opts = { ...this.opts, ...opts };
    this.regs.fill(0);
    this.fregs.fill(0n);
    this.vregs.fill(0);
    if (this.opts.env === "rars") {
      this.regs[2] = STACK_TOP;
      this.regs[3] = DATA_BASE + 0x800;
    }
    this.pc = entry >>> 0;
    this.priv = 3;
    this.mem.clear();
    this.output = "";
    this.halted = undefined;
    this.csr.clear();
    // FP and vector units start "initial" so programs can use them without setup (bare tests enable them explicitly).
    this.csr.set(0x300, this.opts.env === "bare" ? 0 : (1 << 13) | (1 << 9));
    this.cycle = 0n;
    this.instretC = 0n;
    this.mtime = 0n;
    this.mtimecmp = M64;
    this.msip = 0;
    this.vl = 0;
    this.vtype = 0x80000000;
    this.reservation = null;
  }

  // ───────────── journaled state changes ─────────────

  private log(fn: () => void) {
    this.journal.push(fn);
  }

  setX(reg: number, value: number): void {
    const old = this.regs[reg];
    this.events.push({ kind: "REG_WRITE", reg, old, value: value | 0, ignored: reg === 0 });
    if (reg === 0) return;
    this.regs[reg] = value | 0;
    this.log(() => (this.regs[reg] = old));
  }

  setFRaw(reg: number, bits: bigint, fmt: "S" | "D"): void {
    const old = this.fregs[reg];
    this.fregs[reg] = bits & M64;
    this.events.push({ kind: "FREG_WRITE", reg, fmt, old, bits: bits & M64 });
    this.log(() => (this.fregs[reg] = old));
    this.markFsDirty();
  }

  /** Write a single-precision value, NaN-boxed into the 64-bit register. */
  setS(reg: number, bits32: bigint): void {
    this.setFRaw(reg, BOX | (bits32 & 0xffffffffn), "S");
  }

  /** Read a single-precision value; an improperly NaN-boxed register reads as the canonical NaN. */
  getS(reg: number): bigint {
    const v = this.fregs[reg];
    return (v & BOX) === BOX ? v & 0xffffffffn : fpu.CANONICAL_NAN.S;
  }

  setVBytes(offset: number, bytes: Uint8Array): void {
    const old = this.vregs.slice(offset, offset + bytes.length);
    this.vregs.set(bytes, offset);
    this.log(() => this.vregs.set(old, offset));
    this.markVsDirty();
  }

  setVState(vl: number, vtype: number): void {
    const [ol, ot] = [this.vl, this.vtype];
    this.vl = vl;
    this.vtype = vtype;
    this.log(() => {
      this.vl = ol;
      this.vtype = ot;
    });
    this.markVsDirty();
  }

  private setCsrRaw(addr: number, value: number): void {
    const had = this.csr.has(addr);
    const old = this.csr.get(addr) ?? 0;
    this.csr.set(addr, value >>> 0);
    this.log(() => (had ? this.csr.set(addr, old) : this.csr.delete(addr)));
  }

  private raw(addr: number): number {
    return this.csr.get(addr) ?? 0;
  }

  private setPriv(p: Priv): void {
    const old = this.priv;
    this.priv = p;
    this.log(() => (this.priv = old));
  }

  private setReservation(r: number | null): void {
    const old = this.reservation;
    this.reservation = r;
    this.log(() => (this.reservation = old));
  }

  private appendOutput(s: string): void {
    const len = this.output.length;
    this.output += s;
    this.log(() => (this.output = this.output.slice(0, len)));
  }

  private markFsDirty(): void {
    const ms = this.raw(0x300);
    if ((ms & MS.FS) !== MS.FS) this.setCsrRaw(0x300, ms | MS.FS);
  }

  private markVsDirty(): void {
    const ms = this.raw(0x300);
    if ((ms & MS.VS) !== MS.VS) this.setCsrRaw(0x300, ms | MS.VS);
  }

  // ───────────── memory with CLINT and tohost ─────────────

  private mmio(addr: number): boolean {
    return addr >= CLINT.BASE && addr < CLINT.END;
  }

  private clintRead(addr: number, size: number): number {
    const word = (a: number): number => {
      if (a === CLINT.MSIP) return this.msip;
      if (a === CLINT.MTIMECMP) return Number(this.mtimecmp & 0xffffffffn);
      if (a === CLINT.MTIMECMP + 4) return Number(this.mtimecmp >> 32n);
      if (a === CLINT.MTIME) return Number(this.mtime & 0xffffffffn);
      if (a === CLINT.MTIME + 4) return Number(this.mtime >> 32n);
      return 0;
    };
    const w = word(addr & ~3) >>> 0;
    return size === 4 ? w : (w >>> ((addr & 3) * 8)) & (size === 1 ? 0xff : 0xffff);
  }

  private clintWrite(addr: number, value: number): void {
    const a = addr & ~3;
    const v = BigInt(value >>> 0);
    if (a === CLINT.MSIP) {
      const old = this.msip;
      this.msip = value & 1;
      this.log(() => (this.msip = old));
    } else if (a === CLINT.MTIMECMP || a === CLINT.MTIMECMP + 4) {
      const old = this.mtimecmp;
      this.mtimecmp = a === CLINT.MTIMECMP ? (old & ~0xffffffffn) | v : (old & 0xffffffffn) | (v << 32n);
      this.log(() => (this.mtimecmp = old));
    } else if (a === CLINT.MTIME || a === CLINT.MTIME + 4) {
      const old = this.mtime;
      this.mtime = a === CLINT.MTIME ? (old & ~0xffffffffn) | v : (old & 0xffffffffn) | (v << 32n);
      this.log(() => (this.mtime = old));
    }
  }

  private checkAlign(addr: number, size: number, store: boolean, amo = false): void {
    if (addr % size === 0) return;
    if (this.opts.misaligned && !amo) return;
    throw new Trap(store ? 6 : 4, addr, `Misaligned ${size}-byte ${store ? "store" : "load"} at ${hex32(addr)}.`);
  }

  load(addr: number, size: 1 | 2 | 4, amo = false): number {
    addr >>>= 0;
    this.checkAlign(addr, size, false, amo);
    if (this.mmio(addr)) return this.clintRead(addr, size);
    return this.mem.read(addr, size);
  }

  store(addr: number, size: 1 | 2 | 4 | 8, value: number | bigint, amo = false): { oldBytes: number[]; bytes: number[] } {
    addr >>>= 0;
    this.checkAlign(addr, size, true, amo);
    if (this.mmio(addr)) {
      this.clintWrite(addr, Number(BigInt.asUintN(32, BigInt(value))));
      if (size === 8) this.clintWrite(addr + 4, Number(BigInt(value) >> 32n));
      return { oldBytes: [], bytes: [] };
    }
    const oldBytes = this.mem.readBytes(addr, size);
    const big = BigInt.asUintN(64, BigInt(value));
    const bytes: number[] = [];
    for (let i = 0; i < size; i++) bytes.push(Number((big >> BigInt(8 * i)) & 0xffn));
    this.mem.load(addr, bytes);
    this.log(() => this.mem.load(addr, oldBytes));
    if (this.reservation !== null && addr <= this.reservation + 3 && addr + size > this.reservation) this.setReservation(null);
    if (this.opts.tohost !== undefined && addr === this.opts.tohost && size >= 4) {
      const v = Number(big & 0xffffffffn);
      if (v !== 0) this.haltPending = v === 1
        ? { reason: "pass", message: "riscv-tests: PASS (tohost = 1)." }
        : { reason: "fail", message: `riscv-tests: FAIL in test ${v >>> 1} (tohost = ${v}).`, code: v >>> 1 };
    }
    return { oldBytes, bytes };
  }

  private haltPending: HaltInfo | undefined;

  // ───────────── CSRs ─────────────

  /** CSR read with privilege checks. */
  readCsr(addr: number): number {
    this.checkCsrAccess(addr, false);
    return this.csrValue(addr);
  }

  private csrValue(addr: number): number {
    const ms = this.raw(0x300);
    switch (addr) {
      case 0x001: return this.raw(0x003) & 0x1f;
      case 0x002: return (this.raw(0x003) >>> 5) & 7;
      case 0x003: return this.raw(0x003) & 0xff;
      case 0x008: return this.raw(0x008);
      case 0x009: return this.raw(0x00f) & 1;
      case 0x00a: return (this.raw(0x00f) >>> 1) & 3;
      case 0x00f: return this.raw(0x00f) & 7;
      case 0xc00: case 0xb00: return Number(this.cycle & 0xffffffffn);
      case 0xc80: case 0xb80: return Number(this.cycle >> 32n);
      case 0xc01: return Number(this.mtime & 0xffffffffn);
      case 0xc81: return Number(this.mtime >> 32n);
      case 0xc02: case 0xb02: return Number(this.instretC & 0xffffffffn);
      case 0xc82: case 0xb82: return Number(this.instretC >> 32n);
      case 0xc20: return this.vl;
      case 0xc21: return this.vtype >>> 0;
      case 0xc22: return VLENB;
      case 0x300: return this.withSd(ms);
      case 0x100: return this.withSd(ms) & SSTATUS_MASK;
      case 0x301: return MISA;
      case 0x344: return this.mip();
      case 0x144: return this.mip() & this.raw(0x303);
      case 0x104: return this.raw(0x304) & this.raw(0x303);
      case 0x180: return 0;
      case 0x7a1: case 0x7a2: case 0x7a3: return 0;
      case 0x7a4: return 1; // tinfo: no trigger types
      default: return this.raw(addr);
    }
  }

  private withSd(ms: number): number {
    const dirty = (ms & MS.FS) === MS.FS || (ms & MS.VS) === MS.VS;
    return (dirty ? ms | MS.SD : ms & ~MS.SD) >>> 0;
  }

  private mip(): number {
    let v = this.raw(0x344) & 0x222;
    if (this.mtime >= this.mtimecmp) v |= 1 << 7;
    if (this.msip & 1) v |= 1 << 3;
    return v;
  }

  private checkCsrAccess(addr: number, write: boolean): void {
    const illegal = (why: string) => new Trap(2, 0, `Illegal CSR access to ${csrName(addr)}: ${why}.`);
    const known = CSR_BY_ADDR.has(addr) || (addr >= 0x3a0 && addr <= 0x3ef);
    if (!known) throw illegal("no such CSR");
    const need = (addr >>> 8) & 3;
    if (this.priv < need) throw illegal(`needs ${["U", "S", "H", "M"][need]}-mode, running in ${["U", "S", "H", "M"][this.priv]}-mode`);
    if (write && ((addr >>> 10) & 3) === 3) throw illegal("it is read-only");
    const ms = this.raw(0x300);
    if (addr <= 0x003 && (ms & MS.FS) === 0) throw illegal("the FP unit is off (mstatus.FS = 0)");
    if (((addr >= 0x008 && addr <= 0x00f) || (addr >= 0xc20 && addr <= 0xc22)) && (ms & MS.VS) === 0) throw illegal("the vector unit is off (mstatus.VS = 0)");
    if ((addr >= 0xc00 && addr <= 0xc1f) || (addr >= 0xc80 && addr <= 0xc9f)) {
      const bit = 1 << (addr & 31);
      if (this.priv < 3 && !(this.raw(0x306) & bit)) throw illegal("not enabled in mcounteren");
      if (this.priv < 1 && !(this.raw(0x106) & bit)) throw illegal("not enabled in scounteren");
    }
    if (addr === 0x180 && this.priv === 1 && ms & MS.TVM) throw illegal("mstatus.TVM traps satp in S-mode");
  }

  /** CSR write with WARL behaviour. Logs a CSR_WRITE event. */
  writeCsr(addr: number, value: number): void {
    this.checkCsrAccess(addr, true);
    const old = this.csrValue(addr);
    value >>>= 0;
    const ms = this.raw(0x300);
    const set = (a: number, v: number) => this.setCsrRaw(a, v);
    switch (addr) {
      case 0x001: set(0x003, (this.raw(0x003) & ~0x1f) | (value & 0x1f)); this.markFsDirty(); break;
      case 0x002: set(0x003, (this.raw(0x003) & 0x1f) | ((value & 7) << 5)); this.markFsDirty(); break;
      case 0x003: set(0x003, value & 0xff); this.markFsDirty(); break;
      case 0x008: set(0x008, value & (VLENB * 8 - 1)); this.markVsDirty(); break;
      case 0x009: set(0x00f, (this.raw(0x00f) & ~1) | (value & 1)); this.markVsDirty(); break;
      case 0x00a: set(0x00f, (this.raw(0x00f) & 1) | ((value & 3) << 1)); this.markVsDirty(); break;
      case 0x00f: set(0x00f, value & 7); this.markVsDirty(); break;
      case 0x300: case 0x100: {
        const mask = addr === 0x300 ? MSTATUS_WMASK : SSTATUS_MASK & ~MS.SD;
        let next = (ms & ~mask) | (value & mask);
        // MPP is WARL: H-mode (2) is not supported, keep the old value.
        if (((next & MS.MPP) >>> 11) === 2) next = (next & ~MS.MPP) | (ms & MS.MPP);
        set(0x300, next >>> 0);
        break;
      }
      case 0x302: set(addr, value & MEDELEG_MASK); break;
      case 0x303: set(addr, value & MIDELEG_MASK); break;
      case 0x304: set(addr, value & MIE_MASK); break;
      case 0x104: { const d = this.raw(0x303); set(0x304, (this.raw(0x304) & ~d) | (value & d)); break; }
      case 0x344: set(addr, value & 0x222); break;
      case 0x144: { const d = this.raw(0x303) & 0x2; set(0x344, (this.raw(0x344) & ~d) | (value & d)); break; }
      case 0x305: case 0x105: set(addr, (value & 3) < 2 ? value : value & ~3); break;
      case 0x341: case 0x141: set(addr, value & ~1); break;
      case 0x320: set(addr, value & ~2); break;
      case 0xb00: this.setCounter("cycle", value, false); this.wroteMcycle = true; break;
      case 0xb80: this.setCounter("cycle", value, true); this.wroteMcycle = true; break;
      case 0xb02: this.setCounter("instretC", value, false); this.wroteMinstret = true; break;
      case 0xb82: this.setCounter("instretC", value, true); this.wroteMinstret = true; break;
      case 0x301: case 0x180: case 0x30a: case 0x31a: case 0x10a: case 0x310: case 0x7a1: case 0x7a2: case 0x7a3: case 0x7a4: break;
      default:
        if ((addr >= 0xb03 && addr <= 0xb1f) || (addr >= 0xb83 && addr <= 0xb9f) || (addr >= 0x323 && addr <= 0x33f)) break;
        if (addr >= 0x3a0 && addr <= 0x3ef) {
          set(addr, value);
          break;
        }
        set(addr, value);
    }
    this.events.push({ kind: "CSR_WRITE", csr: addr, name: csrName(addr), old, value: this.csrValue(addr) });
  }

  private setCounter(which: "cycle" | "instretC", value: number, hi: boolean): void {
    const old = this[which];
    const v = BigInt(value >>> 0);
    this[which] = hi ? (old & 0xffffffffn) | (v << 32n) : (old & ~0xffffffffn) | v;
    this.log(() => (this[which] = old));
  }

  // ───────────── traps ─────────────

  /** Deliver a trap. Returns false if there is no handler (rars env with mtvec = 0). */
  private takeTrap(cause: number, interrupt: boolean, tval: number, message: string, epc: number): boolean {
    const deleg = this.raw(interrupt ? 0x303 : 0x302);
    const toS = this.priv <= 1 && ((deleg >>> cause) & 1) === 1;
    const tvec = this.raw(toS ? 0x105 : 0x305);
    const name = interrupt ? INTERRUPTS[cause] ?? `interrupt ${cause}` : CAUSES[cause] ?? `cause ${cause}`;
    // Linux user mode has no trap handler (the kernel would send a signal); rars without mtvec has none either.
    if (this.opts.env === "linux" || (this.opts.env === "rars" && !toS && (tvec & ~3) === 0)) {
      this.events.push({ kind: "TRAP", cause, interrupt, name, tval, message });
      return false;
    }
    const from = this.priv;
    const handler = ((tvec & ~3) + ((tvec & 3) === 1 && interrupt ? 4 * cause : 0)) >>> 0;
    const causeVal = ((interrupt ? 0x80000000 : 0) | cause) >>> 0;
    const ms = this.raw(0x300);
    if (toS) {
      this.setCsrRaw(0x141, epc & ~1);
      this.setCsrRaw(0x142, causeVal);
      this.setCsrRaw(0x143, tval >>> 0);
      let n = ms & ~(MS.SPIE | MS.SIE | MS.SPP);
      if (ms & MS.SIE) n |= MS.SPIE;
      if (from === 1) n |= MS.SPP;
      this.setCsrRaw(0x300, n >>> 0);
      this.setPriv(1);
    } else {
      this.setCsrRaw(0x341, epc & ~1);
      this.setCsrRaw(0x342, causeVal);
      this.setCsrRaw(0x343, tval >>> 0);
      let n = ms & ~(MS.MPIE | MS.MIE | MS.MPP);
      if (ms & MS.MIE) n |= MS.MPIE;
      n |= from << 11;
      this.setCsrRaw(0x300, n >>> 0);
      this.setPriv(3);
    }
    this.events.push({ kind: "TRAP", cause, interrupt, name, tval, message, handler, to: toS ? 1 : 3, from });
    this.pc = handler;
    return true;
  }

  /** The highest-priority interrupt that is pending and enabled, if any. */
  pendingInterrupt(): number | undefined {
    const pend = this.mip() & this.raw(0x304);
    if (!pend) return undefined;
    const ms = this.raw(0x300);
    const deleg = this.raw(0x303);
    const mOn = this.priv < 3 || (ms & MS.MIE) !== 0;
    const sOn = this.priv < 1 || (this.priv === 1 && (ms & MS.SIE) !== 0);
    for (const c of INT_PRIORITY) {
      if (!((pend >>> c) & 1)) continue;
      if ((deleg >>> c) & 1) {
        if (sOn) return c;
      } else if (mOn) return c;
    }
    return undefined;
  }

  // ───────────── stepping ─────────────

  step(): StepRecord {
    const pc = this.pc >>> 0;
    this.journal = [];
    this.events = [];
    this.wroteMcycle = this.wroteMinstret = false;
    const rec: StepRecord = {
      index: this.instret, pc, word: 0, events: this.events, nextPc: pc, priv: this.priv, journal: this.journal, retired: false,
    };
    if (this.halted) return rec;
    const startPc = this.pc;
    const savedTime = this.mtime;
    const savedCycle = this.cycle;
    const savedInstret = this.instretC;
    this.log(() => {
      this.pc = startPc;
      this.mtime = savedTime;
      this.cycle = savedCycle;
      this.instretC = savedInstret;
      this.halted = undefined;
      this.haltPending = undefined;
    });

    if (this.opts.env === "rars" && pc === this.textEnd && this.textEnd !== 0) {
      return this.finish(rec, { reason: "end", message: "Reached the end of the program." });
    }

    // Interrupts are checked between instructions.
    const irq = this.pendingInterrupt();
    if (irq !== undefined) {
      if (!this.takeTrap(irq, true, 0, `${INTERRUPTS[irq]} taken`, pc)) {
        return this.finish(rec, { reason: "trap", message: `${INTERRUPTS[irq]} with no handler (mtvec = 0).` });
      }
      rec.nextPc = this.pc;
      this.events.push({ kind: "PC", old: pc, next: this.pc, source: "trap" });
      this.mtime += 1n;
      return rec;
    }

    try {
      this.execute(rec, pc);
      rec.retired = true;
    } catch (e) {
      if (!(e instanceof Trap)) throw e;
      // A faulting instruction has no architectural effect: roll back everything it changed.
      const keep = this.journal.splice(1);
      for (let i = keep.length - 1; i >= 0; i--) keep[i]();
      const pre = this.events.filter((x) => x.kind === "FETCH" || x.kind === "EXPAND" || x.kind === "DECODE");
      this.events.length = 0;
      this.events.push(...pre);
      this.pc = pc;
      if (!this.takeTrap(e.cause, false, e.tval, e.message, pc)) {
        const reason = e.cause === 3 ? "ebreak" : "trap";
        return this.finish(rec, { reason, message: e.cause === 3 ? "Stopped at ebreak." : e.message });
      }
      this.events.push({ kind: "PC", old: pc, next: this.pc, source: "trap" });
    }
    rec.nextPc = this.pc;
    this.mtime += 1n;
    if (this.haltPending) return this.finish(rec, this.haltPending);
    return rec;
  }

  private finish(rec: StepRecord, h: HaltInfo): StepRecord {
    rec.halted = h;
    this.halted = h;
    rec.nextPc = this.pc;
    return rec;
  }

  /** Fetch, decode and execute one instruction. Throws Trap on exceptions. */
  private execute(rec: StepRecord, pc: number): void {
    const ev = this.events;
    if (pc & 1) throw new Trap(0, pc, `PC ${hex32(pc)} is not 2-byte aligned.`);
    const lo = this.mem.read(pc, 2);
    let d: Decoded | undefined;
    let size: 2 | 4 = 4;
    if ((lo & 3) !== 3) {
      size = 2;
      rec.word = lo;
      ev.push({ kind: "FETCH", pc, word: lo, size: 2 });
      const ex = expandC(lo);
      if (!ex) throw new Trap(2, lo, `Illegal compressed instruction 0x${lo.toString(16).padStart(4, "0")} at ${hex32(pc)}${lo === 0 ? " (0x0000 is deliberately illegal — did execution run into data or past the end?)" : ""}.`);
      ev.push({ kind: "EXPAND", half: lo, word: ex.word, mnemonic: ex.mnemonic });
      d = decode(ex.word);
      if (d) d.compressed = { half: lo, mnemonic: ex.mnemonic };
    } else {
      const word = this.mem.read(pc, 4);
      rec.word = word;
      ev.push({ kind: "FETCH", pc, word, size: 4 });
      d = decode(word);
      if (!d) {
        const hint = word === 0 ? " (0x00000000 is deliberately illegal — did execution run into data or past the end?)" : "";
        throw new Trap(2, word, `Illegal instruction ${hex32(word)} at ${hex32(pc)}${hint}.`);
      }
    }
    if (!d) throw new Trap(2, rec.word, `Illegal instruction at ${hex32(pc)}.`);
    const def = d.def;
    const ctrl = controlFor(def);
    rec.decoded = d;
    rec.ctrl = ctrl;
    ev.push({ kind: "DECODE", decoded: d, ctrl });

    const ms = this.raw(0x300);
    if ((def.ext === "F" || def.ext === "D") && (ms & MS.FS) === 0) {
      throw new Trap(2, d.word, "FP instruction while the FP unit is off (mstatus.FS = 0).");
    }

    const next = (pc + size) | 0;
    let nextPc = next;
    let pcSource: "pc4" | "branch" | "jal" | "jalr" | "xret" = "pc4";
    const f = d.f;

    const readRs1 = () => {
      const v = this.regs[d.rs1];
      ev.push({ kind: "REG_READ", port: 1, reg: d.rs1, value: v });
      return v;
    };
    const readRs2 = () => {
      const v = this.regs[d.rs2];
      ev.push({ kind: "REG_READ", port: 2, reg: d.rs2, value: v });
      return v;
    };
    const imm = () => {
      ev.push({ kind: "IMM", format: def.format, value: d.imm, shamt: def.syntax.includes("shamt") });
      return d.imm;
    };
    const runAlu = (a: number, b: number) => {
      const out = alu(def.aluOp!, a, b);
      ev.push({ kind: "ALU", op: def.aluOp!, a, b, out });
      return out;
    };
    const mux = (id: "aluSrcA" | "aluSrcB" | "wbSel", sel: string, value: number) => ev.push({ kind: "MUX", id, sel, value });

    switch (def.animClass) {
      case "R": {
        const a = readRs1();
        const b = readRs2();
        mux("aluSrcA", "rs1", a);
        mux("aluSrcB", "rs2", b);
        const out = runAlu(a, b);
        mux("wbSel", "alu", out);
        this.setX(d.rd, out);
        break;
      }
      case "I_ALU": {
        const a = readRs1();
        const unaryOp = def.layout === "IFIX";
        const b = unaryOp ? 0 : imm();
        mux("aluSrcA", "rs1", a);
        mux("aluSrcB", "imm", b);
        const out = runAlu(a, b);
        mux("wbSel", "alu", out);
        this.setX(d.rd, out);
        break;
      }
      case "LOAD": {
        const a = readRs1();
        const b = imm();
        mux("aluSrcA", "rs1", a);
        mux("aluSrcB", "imm", b);
        const addr = runAlu(a, b) >>> 0;
        const sz = def.memWidth as 1 | 2 | 4;
        const raw = this.load(addr, sz);
        const bytes = this.mmio(addr) ? [] : this.mem.readBytes(addr, sz);
        const shift = 32 - sz * 8;
        const value = sz === 4 ? raw | 0 : def.memUnsigned ? raw : (raw << shift) >> shift;
        ev.push({ kind: "MEM_READ", addr, size: sz, raw, value, bytes, unsigned: !!def.memUnsigned });
        mux("wbSel", "mem", value);
        this.setX(d.rd, value);
        break;
      }
      case "STORE": {
        const a = readRs1();
        const v = readRs2();
        const b = imm();
        mux("aluSrcA", "rs1", a);
        mux("aluSrcB", "imm", b);
        const addr = runAlu(a, b) >>> 0;
        const sz = def.memWidth as 1 | 2 | 4;
        const { oldBytes, bytes } = this.store(addr, sz, v >>> 0);
        ev.push({ kind: "MEM_WRITE", addr, size: sz, value: sz === 4 ? v : v & (sz === 1 ? 0xff : 0xffff), oldBytes, bytes });
        break;
      }
      case "BRANCH": {
        const a = readRs1();
        const b = readRs2();
        const off = imm();
        const target = (pc + off) | 0;
        ev.push({ kind: "TARGET", base: pc, offset: off, target });
        const taken = compare(def.branchOp!, a, b);
        ev.push({ kind: "BRANCH", op: def.branchOp!, a, b, taken, target });
        if (taken) {
          nextPc = target;
          pcSource = "branch";
        }
        break;
      }
      case "JAL": {
        const off = imm();
        const target = (pc + off) | 0;
        ev.push({ kind: "TARGET", base: pc, offset: off, target });
        mux("wbSel", "pc4", next);
        nextPc = target;
        pcSource = "jal";
        if (target & 1) throw new Trap(0, target >>> 0, `Jump target ${hex32(target)} is not 2-byte aligned.`);
        this.setX(d.rd, next);
        break;
      }
      case "JALR": {
        const a = readRs1();
        const b = imm();
        mux("aluSrcA", "rs1", a);
        mux("aluSrcB", "imm", b);
        const sum = runAlu(a, b);
        mux("wbSel", "pc4", next);
        nextPc = sum & ~1;
        pcSource = "jalr";
        this.setX(d.rd, next);
        break;
      }
      case "LUI": {
        const b = imm();
        mux("aluSrcA", "zero", 0);
        mux("aluSrcB", "imm", b);
        const out = runAlu(0, b);
        mux("wbSel", "alu", out);
        this.setX(d.rd, out);
        break;
      }
      case "AUIPC": {
        const b = imm();
        mux("aluSrcA", "pc", pc);
        mux("aluSrcB", "imm", b);
        const out = runAlu(pc, b);
        mux("wbSel", "alu", out);
        this.setX(d.rd, out);
        break;
      }
      case "FENCE":
        break;
      case "SYSTEM": {
        if (def.mnemonic === "ebreak") throw new Trap(3, pc, "ebreak: breakpoint.");
        const handled = this.environmentCall(d);
        if (!handled) {
          const cause = this.priv === 3 ? 11 : this.priv === 1 ? 9 : 8;
          throw new Trap(cause, 0, `ecall from ${["U", "S", "", "M"][this.priv]}-mode.`);
        }
        break;
      }
      case "CSR": {
        const isImm = def.layout === "CSRI";
        const src = isImm ? f.zimm : readRs1();
        if (!isImm) ev.push({ kind: "MUX", id: "aluSrcA", sel: "rs1", value: src });
        const op = def.op!; // RW, RS, RC
        const writes = op === "RW" || (isImm ? f.zimm !== 0 : d.rs1 !== 0);
        const reads = op !== "RW" || d.rd !== 0;
        this.checkCsrAccess(f.csr, writes);
        const old = reads || writes ? this.csrValue(f.csr) : 0;
        ev.push({ kind: "CSR_READ", csr: f.csr, name: csrName(f.csr), value: old });
        if (writes) {
          const val = op === "RW" ? src : op === "RS" ? old | src : old & ~src;
          this.writeCsr(f.csr, val);
        }
        mux("wbSel", "csr", old);
        this.setX(d.rd, old);
        break;
      }
      case "PRIV": {
        const op = def.op!;
        const ms0 = this.raw(0x300);
        if (op === "mret") {
          if (this.priv < 3) throw new Trap(2, d.word, "mret outside M-mode is illegal.");
          const mpp = ((ms0 & MS.MPP) >>> 11) as Priv;
          let n = (ms0 & ~(MS.MIE | MS.MPP)) | MS.MPIE;
          if (ms0 & MS.MPIE) n |= MS.MIE;
          if (mpp !== 3) n &= ~MS.MPRV;
          this.setCsrRaw(0x300, n >>> 0);
          nextPc = this.raw(0x341);
          ev.push({ kind: "PRIV", op, from: this.priv, to: mpp, target: nextPc >>> 0 });
          this.setPriv(mpp);
          pcSource = "xret";
        } else if (op === "sret") {
          if (this.priv < 1 || (this.priv === 1 && ms0 & MS.TSR)) throw new Trap(2, d.word, "sret is illegal here (needs S-mode or above, and TSR = 0 in S-mode).");
          const spp = (ms0 & MS.SPP ? 1 : 0) as Priv;
          let n = (ms0 & ~(MS.SIE | MS.SPP)) | MS.SPIE;
          if (ms0 & MS.SPIE) n |= MS.SIE;
          if (spp !== 3) n &= ~MS.MPRV;
          this.setCsrRaw(0x300, n >>> 0);
          nextPc = this.raw(0x141);
          ev.push({ kind: "PRIV", op, from: this.priv, to: spp, target: nextPc >>> 0 });
          this.setPriv(spp);
          pcSource = "xret";
        } else if (op === "wfi") {
          if ((this.priv < 3 && ms0 & MS.TW) || (this.priv === 0 && this.raw(0x180))) throw new Trap(2, d.word, "wfi trapped by mstatus.TW.");
          // Nothing pending: let time pass until the timer would fire.
          if (!(this.mip() & this.raw(0x304)) && this.raw(0x304) & (1 << 7) && this.mtimecmp > this.mtime && this.mtimecmp !== M64) {
            const oldT = this.mtime;
            this.mtime = this.mtimecmp - 1n;
            this.log(() => (this.mtime = oldT));
          }
          ev.push({ kind: "PRIV", op, from: this.priv, to: this.priv, target: next >>> 0 });
        } else if (op === "sfence.vma") {
          if (this.priv < 1 || (this.priv === 1 && ms0 & MS.TVM)) throw new Trap(2, d.word, "sfence.vma is illegal here.");
          ev.push({ kind: "PRIV", op, from: this.priv, to: this.priv, target: next >>> 0 });
        }
        break;
      }
      case "LR": {
        const addr = readRs1() >>> 0;
        if (addr & 3) throw new Trap(4, addr, `Misaligned lr.w at ${hex32(addr)}.`);
        const v = this.load(addr, 4, true) | 0;
        ev.push({ kind: "MEM_READ", addr, size: 4, raw: v >>> 0, value: v, bytes: this.mem.readBytes(addr, 4), unsigned: false });
        this.setReservation(addr);
        ev.push({ kind: "AMO", op: "LR", addr, memOld: v, operand: 0, memNew: v });
        this.setX(d.rd, v);
        break;
      }
      case "SC": {
        const addr = readRs1() >>> 0;
        const v = readRs2();
        if (addr & 3) throw new Trap(6, addr, `Misaligned sc.w at ${hex32(addr)}.`);
        const ok = this.reservation === addr;
        const memOld = this.mem.read(addr, 4) | 0;
        if (ok) {
          const { oldBytes, bytes } = this.store(addr, 4, v >>> 0, true);
          ev.push({ kind: "MEM_WRITE", addr, size: 4, value: v, oldBytes, bytes });
        }
        this.setReservation(null);
        ev.push({ kind: "AMO", op: "SC", addr, memOld, operand: v, memNew: ok ? v : memOld, success: ok });
        this.setX(d.rd, ok ? 0 : 1);
        break;
      }
      case "AMO": {
        const addr = readRs1() >>> 0;
        const v = readRs2();
        if (addr & 3) throw new Trap(6, addr, `Misaligned AMO at ${hex32(addr)}.`);
        const old = this.load(addr, 4, true) | 0;
        ev.push({ kind: "MEM_READ", addr, size: 4, raw: old >>> 0, value: old, bytes: this.mem.readBytes(addr, 4), unsigned: false });
        const nv = amoOp(def.op!, old, v);
        const { oldBytes, bytes } = this.store(addr, 4, nv >>> 0, true);
        ev.push({ kind: "MEM_WRITE", addr, size: 4, value: nv, oldBytes, bytes });
        ev.push({ kind: "AMO", op: def.op!, addr, memOld: old, operand: v, memNew: nv });
        this.setX(d.rd, old);
        break;
      }
      case "FP_LOAD": case "FP_STORE": case "FP_OP": case "FP_FMA": case "FP_CMP": case "FP_TO_INT": case "INT_TO_FP":
        this.execFp(d);
        break;
      case "VSET": case "V_LOAD": case "V_STORE": case "V_ARITH":
        if ((ms & MS.VS) === 0) throw new Trap(2, d.word, "Vector instruction while the vector unit is off (mstatus.VS = 0).");
        execVector(this, d, ev);
        break;
    }

    if (nextPc & 1) throw new Trap(0, nextPc >>> 0, `Jump target ${hex32(nextPc)} is not 2-byte aligned.`);
    ev.push({ kind: "MUX", id: "pcSel", sel: pcSource, value: nextPc });
    ev.push({ kind: "PC", old: pc, next: nextPc >>> 0, source: pcSource });
    this.pc = nextPc >>> 0;
    const inhibit = this.raw(0x320);
    if (!this.wroteMcycle && !(inhibit & 1)) this.cycle = (this.cycle + 1n) & M64;
    if (!this.wroteMinstret && !(inhibit & 4)) this.instretC = (this.instretC + 1n) & M64;
  }

  /** Simulator / Linux services for ecall. Returns false when ecall should trap normally. */
  private environmentCall(d: Decoded): boolean {
    const env = this.opts.env;
    if (env === "bare") return false;
    if (env === "rars" && (this.raw(0x305) & ~3) !== 0) return false;
    const a7 = this.regs[17];
    const a0 = this.regs[10];
    const ev = this.events;
    const emit = (name: string, output?: string, exit?: number) => {
      ev.push({ kind: "SYSCALL", service: a7, name, output, exit });
      if (output) this.appendOutput(output);
    };
    const readStr = (addr: number, max: number, nul: boolean) => {
      let s = "";
      for (let a = addr >>> 0, n = 0; n < max; n++, a++) {
        const c = this.mem.readByte(a);
        if (nul && c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    };
    void d;
    if (env === "linux") {
      switch (a7) {
        case 64: { // write(fd, buf, len)
          const len = this.regs[12] >>> 0;
          emit("write", readStr(this.regs[11], Math.min(len, 1 << 20), false));
          this.setX(10, len);
          return true;
        }
        case 93: case 94:
          emit("exit", undefined, a0);
          this.haltPending = { reason: "exit", message: `Program exited with code ${a0}.`, code: a0 };
          return true;
        default:
          throw new Trap(2, 0, `Unsupported Linux system call ${a7}.`);
      }
    }
    switch (a7) {
      case 1: emit("PrintInt", String(a0)); return true;
      case 2: emit("PrintFloat", String(fpu.toNumber("S", this.getS(12)))); return true;
      case 3: emit("PrintDouble", String(fpu.toNumber("D", this.fregs[12]))); return true;
      case 4: emit("PrintString", readStr(a0, 4096, true)); return true;
      case 11: emit("PrintChar", String.fromCharCode(a0 & 0xff)); return true;
      case 34: emit("PrintIntHex", hex32(a0)); return true;
      case 35: emit("PrintIntBinary", (a0 >>> 0).toString(2).padStart(32, "0")); return true;
      case 36: emit("PrintIntUnsigned", String(a0 >>> 0)); return true;
      case 10:
        emit("Exit", undefined, 0);
        this.haltPending = { reason: "exit", message: "Program exited.", code: 0 };
        return true;
      case 93:
        emit("Exit2", undefined, a0);
        this.haltPending = { reason: "exit", message: `Program exited with code ${a0}.`, code: a0 };
        return true;
      default:
        emit(`Unknown service ${a7}`);
        this.haltPending = { reason: "trap", message: `Unknown ecall service a7 = ${a7}. Try 1 (print int), 4 (print string), 10 (exit).` };
        return true;
    }
  }

  // ───────────── F / D ─────────────

  private resolveRm(rm: number, word: number): number {
    const r = rm === 7 ? (this.raw(0x003) >>> 5) & 7 : rm;
    if (r > 4) throw new Trap(2, word, `Invalid rounding mode ${r}${rm === 7 ? " in frm" : ""}.`);
    return r;
  }

  private accrue(flags: number): void {
    if (!flags) return;
    const old = this.raw(0x003);
    if ((old | flags) !== old) this.setCsrRaw(0x003, old | flags);
  }

  private getF(reg: number, fmt: "S" | "D", port: 1 | 2 | 3): bigint {
    const bits = fmt === "S" ? this.getS(reg) : this.fregs[reg];
    this.events.push({ kind: "FREG_READ", port, reg, fmt, bits });
    return bits;
  }

  private putF(reg: number, fmt: "S" | "D", bits: bigint): void {
    if (fmt === "S") this.setS(reg, bits);
    else this.setFRaw(reg, bits, "D");
  }

  private execFp(d: Decoded): void {
    const def = d.def;
    const fmt = def.fp!;
    const ev = this.events;
    const f = d.f;
    const fpuEv = (op: string, inputs: bigint[], out: bigint | number, flags: number, rm: number, toInt = false) =>
      ev.push({ kind: "FPU", op, fmt, inputs, out, flags, rm, toInt });
    switch (def.animClass) {
      case "FP_LOAD": {
        const base = this.regs[d.rs1];
        ev.push({ kind: "REG_READ", port: 1, reg: d.rs1, value: base });
        ev.push({ kind: "IMM", format: "I", value: d.imm });
        const addr = (base + d.imm) >>> 0;
        ev.push({ kind: "ALU", op: "ADD", a: base, b: d.imm, out: addr | 0 });
        if (fmt === "S") {
          const v = this.load(addr, 4);
          ev.push({ kind: "MEM_READ", addr, size: 4, raw: v, value: v | 0, bytes: this.mem.readBytes(addr, 4), unsigned: false });
          this.setS(d.rd, BigInt(v));
        } else {
          this.checkAlign(addr, 8, false);
          const lo = BigInt(this.mem.read(addr, 4));
          const hi = BigInt(this.mem.read(addr + 4, 4));
          ev.push({ kind: "MEM_READ", addr, size: 8, raw: Number(lo), value: Number(lo) | 0, bytes: this.mem.readBytes(addr, 8), unsigned: false });
          this.setFRaw(d.rd, (hi << 32n) | lo, "D");
        }
        return;
      }
      case "FP_STORE": {
        const base = this.regs[d.rs1];
        ev.push({ kind: "REG_READ", port: 1, reg: d.rs1, value: base });
        ev.push({ kind: "IMM", format: "S", value: d.imm });
        const addr = (base + d.imm) >>> 0;
        ev.push({ kind: "ALU", op: "ADD", a: base, b: d.imm, out: addr | 0 });
        const bits = fmt === "S" ? this.fregs[d.rs2] & 0xffffffffn : this.fregs[d.rs2];
        ev.push({ kind: "FREG_READ", port: 2, reg: d.rs2, fmt, bits });
        const { oldBytes, bytes } = this.store(addr, fmt === "S" ? 4 : 8, bits);
        ev.push({ kind: "MEM_WRITE", addr, size: fmt === "S" ? 4 : 8, value: Number(bits & 0xffffffffn) | 0, oldBytes, bytes });
        return;
      }
      case "FP_FMA": {
        const rm = this.resolveRm(f.funct3, d.word);
        const a = this.getF(d.rs1, fmt, 1);
        const b = this.getF(d.rs2, fmt, 2);
        const c = this.getF(d.rs3, fmt, 3);
        const r = fpu.ffma(fmt, a, b, c, rm, def.op![0] === "1", def.op![1] === "1");
        fpuEv(def.mnemonic.split(".")[0].toUpperCase(), [a, b, c], r.bits, r.flags, rm);
        this.accrue(r.flags);
        this.putF(d.rd, fmt, r.bits);
        return;
      }
      case "FP_OP": {
        const op = def.op!;
        if (op === "CVT_S_D" || op === "CVT_D_S") {
          const rm = this.resolveRm(f.funct3, d.word);
          const from = op === "CVT_S_D" ? "D" : "S";
          const a = this.getF(d.rs1, from, 1);
          const r = fpu.fcvtFmt(from, fmt, a, rm);
          fpuEv(op, [a], r.bits, r.flags, rm);
          this.accrue(r.flags);
          this.putF(d.rd, fmt, r.bits);
          return;
        }
        if (op === "SGNJ" || op === "SGNJN" || op === "SGNJX") {
          const a = this.getF(d.rs1, fmt, 1);
          const b = this.getF(d.rs2, fmt, 2);
          const bits = fpu.fsgnj(fmt, a, b, op === "SGNJ" ? "j" : op === "SGNJN" ? "n" : "x");
          fpuEv(op, [a, b], bits, 0, 0);
          this.putF(d.rd, fmt, bits);
          return;
        }
        if (op === "MIN" || op === "MAX") {
          const a = this.getF(d.rs1, fmt, 1);
          const b = this.getF(d.rs2, fmt, 2);
          const r = op === "MIN" ? fpu.fmin(fmt, a, b) : fpu.fmax(fmt, a, b);
          fpuEv(op, [a, b], r.bits, r.flags, 0);
          this.accrue(r.flags);
          this.putF(d.rd, fmt, r.bits);
          return;
        }
        const rm = this.resolveRm(f.funct3, d.word);
        if (op === "SQRT") {
          const a = this.getF(d.rs1, fmt, 1);
          const r = fpu.fsqrt(fmt, a, rm);
          fpuEv(op, [a], r.bits, r.flags, rm);
          this.accrue(r.flags);
          this.putF(d.rd, fmt, r.bits);
          return;
        }
        const a = this.getF(d.rs1, fmt, 1);
        const b = this.getF(d.rs2, fmt, 2);
        const fn = { ADD: fpu.fadd, SUB: fpu.fsub, MUL: fpu.fmul, DIV: fpu.fdiv }[op as "ADD"];
        const r = fn(fmt, a, b, rm);
        fpuEv(op, [a, b], r.bits, r.flags, rm);
        this.accrue(r.flags);
        this.putF(d.rd, fmt, r.bits);
        return;
      }
      case "FP_CMP": {
        const op = def.op!;
        const a = this.getF(d.rs1, fmt, 1);
        if (op === "CLASS") {
          const v = fpu.fclass(fmt, a);
          fpuEv(op, [a], v, 0, 0, true);
          this.events.push({ kind: "MUX", id: "wbSel", sel: "fpu", value: v });
          this.setX(d.rd, v);
          return;
        }
        const b = this.getF(d.rs2, fmt, 2);
        const r = op === "EQ" ? fpu.feq(fmt, a, b) : op === "LT" ? fpu.flt(fmt, a, b) : fpu.fle(fmt, a, b);
        fpuEv(op, [a, b], r.value, r.flags, 0, true);
        this.accrue(r.flags);
        this.events.push({ kind: "MUX", id: "wbSel", sel: "fpu", value: r.value });
        this.setX(d.rd, r.value);
        return;
      }
      case "FP_TO_INT": {
        if (def.op === "MVXW") {
          const bits = this.fregs[d.rs1] & 0xffffffffn;
          ev.push({ kind: "FREG_READ", port: 1, reg: d.rs1, fmt: "S", bits });
          const v = Number(bits) | 0;
          fpuEv("MV", [bits], v, 0, 0, true);
          this.events.push({ kind: "MUX", id: "wbSel", sel: "fpu", value: v });
          this.setX(d.rd, v);
          return;
        }
        const rm = this.resolveRm(f.funct3, d.word);
        const a = this.getF(d.rs1, fmt, 1);
        const r = fpu.fcvtToInt(fmt, a, rm, def.op === "W");
        fpuEv(`CVT_${def.op}`, [a], r.value, r.flags, rm, true);
        this.accrue(r.flags);
        this.events.push({ kind: "MUX", id: "wbSel", sel: "fpu", value: r.value });
        this.setX(d.rd, r.value);
        return;
      }
      case "INT_TO_FP": {
        const x = this.regs[d.rs1];
        ev.push({ kind: "REG_READ", port: 1, reg: d.rs1, value: x });
        if (def.op === "MVWX") {
          const bits = BigInt(x >>> 0);
          fpuEv("MV", [bits], bits, 0, 0);
          this.setS(d.rd, bits);
          return;
        }
        const rm = this.resolveRm(f.funct3, d.word);
        const r = fpu.fcvtFromInt(fmt, x, def.op === "W", rm);
        fpuEv(`CVT_FROM_${def.op}`, [BigInt(x >>> 0)], r.bits, r.flags, rm);
        this.accrue(r.flags);
        this.putF(d.rd, fmt, r.bits);
        return;
      }
    }
  }

  /** Reverse a step produced by `step()` (must be the most recent one). */
  undo(rec: StepRecord): void {
    for (let i = rec.journal.length - 1; i >= 0; i--) rec.journal[i]();
    this.halted = undefined;
    this.haltPending = undefined;
  }
}

function amoOp(op: string, mem: number, v: number): number {
  switch (op) {
    case "SWAP": return v;
    case "ADD": return (mem + v) | 0;
    case "XOR": return mem ^ v;
    case "AND": return mem & v;
    case "OR": return mem | v;
    case "MIN": return Math.min(mem | 0, v | 0);
    case "MAX": return Math.max(mem | 0, v | 0);
    case "MINU": return (mem >>> 0) < (v >>> 0) ? mem : v;
    case "MAXU": return (mem >>> 0) > (v >>> 0) ? mem : v;
  }
  return v;
}
