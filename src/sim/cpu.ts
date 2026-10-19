import { decode } from "@/isa/encoding";
import { hex32 } from "@/lib/format";
import { alu, compare } from "./alu";
import { controlFor } from "./control";
import { Memory } from "./memory";
import type { HaltInfo, MicroEvent, StepRecord } from "./trace";
import { EXCEPTION_NAMES } from "./trace";

export interface CpuState {
  regs: Int32Array;
  pc: number;
  instret: number;
  output: string;
  halted?: HaltInfo;
}

/** Default memory map (matches RARS "compact, text at 0"). */
export const TEXT_BASE = 0x00000000;
export const DATA_BASE = 0x00010000;
export const STACK_TOP = 0x0003fff0;

/**
 * Single-cycle RV32IM core. `step()` executes one instruction and returns
 * a full micro-event trace plus undo information; `undo()` reverses it.
 */
export class Cpu {
  regs = new Int32Array(32);
  pc = TEXT_BASE;
  mem = new Memory();
  instret = 0;
  output = "";
  halted: HaltInfo | undefined;
  /** First address past the program's text; reaching it ends the run cleanly. */
  textEnd = TEXT_BASE;

  reset(entry = TEXT_BASE): void {
    this.regs.fill(0);
    this.regs[2] = STACK_TOP;
    this.regs[3] = DATA_BASE + 0x800;
    this.pc = entry;
    this.mem.clear();
    this.instret = 0;
    this.output = "";
    this.halted = undefined;
  }

  snapshot(): CpuState {
    return { regs: this.regs.slice(), pc: this.pc, instret: this.instret, output: this.output, halted: this.halted };
  }

  private writeReg(events: MicroEvent[], rec: StepRecord, reg: number, value: number): void {
    const old = this.regs[reg];
    const ignored = reg === 0;
    events.push({ kind: "REG_WRITE", reg, old, value: value | 0, ignored });
    if (!ignored) {
      rec.regUndo = { reg, old };
      this.regs[reg] = value | 0;
    }
  }

  private trap(rec: StepRecord, cause: number, tval: number, message: string): StepRecord {
    rec.events.push({ kind: "TRAP", cause, name: EXCEPTION_NAMES[cause] ?? `cause ${cause}`, tval, message });
    rec.halted = { reason: "trap", message };
    rec.nextPc = this.pc;
    this.halted = rec.halted;
    return rec;
  }

  step(): StepRecord {
    const pc = this.pc >>> 0;
    const events: MicroEvent[] = [];
    const rec: StepRecord = { index: this.instret, pc, word: 0, events, nextPc: pc, outputBefore: this.output.length };
    if (this.halted) return rec;

    if (pc === this.textEnd) {
      rec.halted = { reason: "end", message: "Reached the end of the program." };
      this.halted = rec.halted;
      return rec;
    }
    if (pc & 3) {
      return this.trap(rec, 0, pc, `PC ${hex32(pc)} is not 4-byte aligned.`);
    }

    const word = this.mem.read(pc, 4);
    rec.word = word;
    events.push({ kind: "FETCH", pc, word });

    const d = decode(word);
    if (!d) {
      const hint = word === 0 ? " (0x00000000 is deliberately illegal — did execution run into data or past the end?)" : "";
      return this.trap(rec, 2, word, `Illegal instruction ${hex32(word)} at ${hex32(pc)}${hint}.`);
    }
    const def = d.def;
    const ctrl = controlFor(def);
    rec.decoded = d;
    rec.ctrl = ctrl;
    events.push({ kind: "DECODE", decoded: d, ctrl });

    const pc4 = (pc + 4) | 0;
    let nextPc = pc4;
    let pcSource: "pc4" | "branch" | "jal" | "jalr" = "pc4";

    const readRs1 = () => {
      const v = this.regs[d.rs1];
      events.push({ kind: "REG_READ", port: 1, reg: d.rs1, value: v });
      return v;
    };
    const readRs2 = () => {
      const v = this.regs[d.rs2];
      events.push({ kind: "REG_READ", port: 2, reg: d.rs2, value: v });
      return v;
    };
    const imm = () => {
      events.push({ kind: "IMM", format: def.format, value: d.imm, shamt: def.syntax === "rd,rs1,shamt" });
      return d.imm;
    };
    const runAlu = (a: number, b: number) => {
      const out = alu(def.aluOp!, a, b);
      events.push({ kind: "ALU", op: def.aluOp!, a, b, out });
      return out;
    };

    switch (def.animClass) {
      case "R": {
        const a = readRs1();
        const b = readRs2();
        events.push({ kind: "MUX", id: "aluSrcA", sel: "rs1", value: a });
        events.push({ kind: "MUX", id: "aluSrcB", sel: "rs2", value: b });
        const out = runAlu(a, b);
        events.push({ kind: "MUX", id: "wbSel", sel: "alu", value: out });
        this.writeReg(events, rec, d.rd, out);
        break;
      }
      case "I_ALU": {
        const a = readRs1();
        const b = imm();
        events.push({ kind: "MUX", id: "aluSrcA", sel: "rs1", value: a });
        events.push({ kind: "MUX", id: "aluSrcB", sel: "imm", value: b });
        const out = runAlu(a, b);
        events.push({ kind: "MUX", id: "wbSel", sel: "alu", value: out });
        this.writeReg(events, rec, d.rd, out);
        break;
      }
      case "LOAD": {
        const a = readRs1();
        const b = imm();
        events.push({ kind: "MUX", id: "aluSrcA", sel: "rs1", value: a });
        events.push({ kind: "MUX", id: "aluSrcB", sel: "imm", value: b });
        const addr = runAlu(a, b) >>> 0;
        const size = def.memWidth!;
        if (addr % size !== 0) {
          return this.trap(rec, 4, addr, `Misaligned ${size}-byte load from ${hex32(addr)}.`);
        }
        const raw = this.mem.read(addr, size);
        const bytes = this.mem.readBytes(addr, size);
        const shift = 32 - size * 8;
        const value = size === 4 ? raw | 0 : def.memUnsigned ? raw : (raw << shift) >> shift;
        events.push({ kind: "MEM_READ", addr, size, raw, value, bytes, unsigned: !!def.memUnsigned });
        events.push({ kind: "MUX", id: "wbSel", sel: "mem", value });
        this.writeReg(events, rec, d.rd, value);
        break;
      }
      case "STORE": {
        const a = readRs1();
        const v = readRs2();
        const b = imm();
        events.push({ kind: "MUX", id: "aluSrcA", sel: "rs1", value: a });
        events.push({ kind: "MUX", id: "aluSrcB", sel: "imm", value: b });
        const addr = runAlu(a, b) >>> 0;
        const size = def.memWidth!;
        if (addr % size !== 0) {
          return this.trap(rec, 6, addr, `Misaligned ${size}-byte store to ${hex32(addr)}.`);
        }
        const oldBytes = this.mem.readBytes(addr, size);
        this.mem.write(addr, size, v);
        const bytes = this.mem.readBytes(addr, size);
        rec.memUndo = { addr, oldBytes };
        events.push({ kind: "MEM_WRITE", addr, size, value: size === 4 ? v : v & (size === 1 ? 0xff : 0xffff), oldBytes, bytes });
        break;
      }
      case "BRANCH": {
        const a = readRs1();
        const b = readRs2();
        const off = imm();
        const target = (pc + off) | 0;
        events.push({ kind: "TARGET", base: pc, offset: off, target });
        const taken = compare(def.branchOp!, a, b);
        events.push({ kind: "BRANCH", op: def.branchOp!, a, b, taken, target });
        if (taken) {
          nextPc = target;
          pcSource = "branch";
        }
        break;
      }
      case "JAL": {
        const off = imm();
        const target = (pc + off) | 0;
        events.push({ kind: "TARGET", base: pc, offset: off, target });
        events.push({ kind: "MUX", id: "wbSel", sel: "pc4", value: pc4 });
        this.writeReg(events, rec, d.rd, pc4);
        nextPc = target;
        pcSource = "jal";
        break;
      }
      case "JALR": {
        const a = readRs1();
        const b = imm();
        events.push({ kind: "MUX", id: "aluSrcA", sel: "rs1", value: a });
        events.push({ kind: "MUX", id: "aluSrcB", sel: "imm", value: b });
        const sum = runAlu(a, b);
        events.push({ kind: "MUX", id: "wbSel", sel: "pc4", value: pc4 });
        this.writeReg(events, rec, d.rd, pc4);
        nextPc = sum & ~1;
        pcSource = "jalr";
        break;
      }
      case "LUI": {
        const b = imm();
        events.push({ kind: "MUX", id: "aluSrcA", sel: "zero", value: 0 });
        events.push({ kind: "MUX", id: "aluSrcB", sel: "imm", value: b });
        const out = runAlu(0, b);
        events.push({ kind: "MUX", id: "wbSel", sel: "alu", value: out });
        this.writeReg(events, rec, d.rd, out);
        break;
      }
      case "AUIPC": {
        const b = imm();
        events.push({ kind: "MUX", id: "aluSrcA", sel: "pc", value: pc });
        events.push({ kind: "MUX", id: "aluSrcB", sel: "imm", value: b });
        const out = runAlu(pc, b);
        events.push({ kind: "MUX", id: "wbSel", sel: "alu", value: out });
        this.writeReg(events, rec, d.rd, out);
        break;
      }
      case "FENCE":
        break;
      case "SYSTEM": {
        if (def.mnemonic === "ebreak") {
          events.push({ kind: "TRAP", cause: 3, name: EXCEPTION_NAMES[3], tval: pc, message: "ebreak: breakpoint hit." });
          rec.halted = { reason: "ebreak", message: "Stopped at ebreak." };
          break;
        }
        const halt = this.syscall(events);
        if (halt) rec.halted = halt;
        break;
      }
    }

    if (nextPc & 3 && !rec.halted) {
      // Without the C extension, jump targets must be 4-byte aligned. The jump does not retire.
      if (rec.regUndo) this.regs[rec.regUndo.reg] = rec.regUndo.old;
      rec.regUndo = undefined;
      return this.trap(rec, 0, nextPc >>> 0, `Jump target ${hex32(nextPc)} is not 4-byte aligned.`);
    }

    events.push({ kind: "MUX", id: "pcSel", sel: pcSource, value: nextPc });
    events.push({ kind: "PC", old: pc, next: nextPc >>> 0, source: pcSource });
    rec.nextPc = nextPc >>> 0;
    this.pc = nextPc >>> 0;
    this.instret++;
    if (rec.halted) this.halted = rec.halted;
    return rec;
  }

  /** Educational syscalls (RARS heritage). Simulator environment — not part of the ISA. */
  private syscall(events: MicroEvent[]): HaltInfo | undefined {
    const a7 = this.regs[17];
    const a0 = this.regs[10];
    const emit = (name: string, output?: string, exit?: number) => {
      events.push({ kind: "SYSCALL", service: a7, name, output, exit });
      if (output) this.output += output;
    };
    switch (a7) {
      case 1: emit("PrintInt", String(a0)); return;
      case 4: {
        let s = "";
        for (let addr = a0 >>> 0, n = 0; n < 4096; n++, addr++) {
          const c = this.mem.readByte(addr);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        emit("PrintString", s);
        return;
      }
      case 11: emit("PrintChar", String.fromCharCode(a0 & 0xff)); return;
      case 34: emit("PrintIntHex", hex32(a0)); return;
      case 35: emit("PrintIntBinary", (a0 >>> 0).toString(2).padStart(32, "0")); return;
      case 36: emit("PrintIntUnsigned", String(a0 >>> 0)); return;
      case 10: emit("Exit", undefined, 0); return { reason: "exit", message: "Program exited.", code: 0 };
      case 93: emit("Exit2", undefined, a0); return { reason: "exit", message: `Program exited with code ${a0}.`, code: a0 };
      default:
        emit(`Unknown service ${a7}`);
        return { reason: "trap", message: `Unknown ecall service a7 = ${a7}. Try 1 (print int), 4 (print string), 10 (exit).` };
    }
  }

  /** Reverse a step produced by `step()` (must be the most recent one). */
  undo(rec: StepRecord): void {
    if (rec.regUndo) this.regs[rec.regUndo.reg] = rec.regUndo.old;
    if (rec.memUndo) this.mem.load(rec.memUndo.addr, rec.memUndo.oldBytes);
    this.output = this.output.slice(0, rec.outputBefore);
    this.pc = rec.pc;
    this.instret = rec.index;
    this.halted = undefined;
  }
}
