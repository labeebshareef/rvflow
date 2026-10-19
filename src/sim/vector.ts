/**
 * Vector unit: a teaching subset of RVV 1.0 with VLEN = 128 and ELEN = 32.
 * Supports SEW 8/16/32, LMUL 1/4…8, masking with v0.t, unit-stride and
 * strided memory, integer arithmetic, compares, reductions, slides and moves.
 * Tail and masked-off elements are left undisturbed (a legal policy for both
 * "agnostic" and "undisturbed" settings).
 */
import type { Decoded } from "@/isa/encoding";
import { hex32 } from "@/lib/format";
import type { Cpu } from "./cpu";
import type { MicroEvent, VecLane } from "./trace";
import { Trap } from "./trap";

export const VLEN = 128;
export const VLENB = VLEN / 8;
export const ELEN = 32;
/** Lanes recorded per instruction for the animation (all of them for VLEN = 128 at e8 m1). */
const MAX_LANES = 32;

export interface VtypeInfo {
  vill: boolean;
  sew: number;
  /** LMUL as a fraction num/den. */
  lmulNum: number;
  lmulDen: number;
  lmulName: string;
  vlmax: number;
  ta: boolean;
  ma: boolean;
}

export function vtypeInfo(vtype: number, reservedBits = 0): VtypeInfo {
  const vlmul = vtype & 7;
  const vsew = (vtype >>> 3) & 7;
  const bad: VtypeInfo = { vill: true, sew: 0, lmulNum: 1, lmulDen: 1, lmulName: "-", vlmax: 0, ta: false, ma: false };
  if (vtype >>> 31 || reservedBits || vlmul === 4 || vsew > 2) return bad;
  const sew = 8 << vsew;
  const [num, den] = vlmul < 4 ? [1 << vlmul, 1] : [1, 1 << (8 - vlmul)];
  if (sew * den > num * ELEN) return bad; // need SEW ≤ LMUL × ELEN
  return {
    vill: false, sew, lmulNum: num, lmulDen: den, lmulName: den === 1 ? `m${num}` : `mf${den}`,
    vlmax: (num * VLEN) / (den * sew), ta: !!(vtype & 0x40), ma: !!(vtype & 0x80),
  };
}

const mask = (sew: number) => (sew === 32 ? 0xffffffff : (1 << sew) - 1);
const sext = (v: number, sew: number) => (sew === 32 ? v | 0 : (v << (32 - sew)) >> (32 - sew));

function readElem(v: Uint8Array, reg: number, i: number, eewBytes: number): number {
  const o = reg * VLENB + i * eewBytes;
  let x = 0;
  for (let b = eewBytes - 1; b >= 0; b--) x = x * 256 + v[o + b];
  return x >>> 0;
}

function writeElem(v: Uint8Array, base: number, i: number, eewBytes: number, x: number): void {
  const o = base + i * eewBytes;
  for (let b = 0; b < eewBytes; b++) v[o + b] = (x >>> (8 * b)) & 0xff;
}

const maskBit = (v: Uint8Array, reg: number, i: number) => (v[reg * VLENB + (i >> 3)] >> (i & 7)) & 1;

export function execVector(cpu: Cpu, d: Decoded, ev: MicroEvent[]): void {
  const def = d.def;
  const f = d.f;
  const ill = (why: string): never => {
    throw new Trap(2, d.word, `Illegal vector instruction: ${why}.`);
  };

  if (def.animClass === "VSET") {
    let vtype: number;
    let avl: number;
    let reserved = 0;
    if (def.op === "vsetvl") {
      const t = cpu.regs[d.rs2] >>> 0;
      ev.push({ kind: "REG_READ", port: 2, reg: d.rs2, value: t | 0 });
      vtype = t & 0xff;
      reserved = (t >>> 8) & 0x7fffff;
      if (t >>> 31) reserved = 1;
    } else {
      vtype = f.vtypei & 0xff;
      reserved = f.vtypei >>> 8;
    }
    const info = vtypeInfo(vtype, reserved);
    if (def.op === "vsetivli") avl = f.uimm5;
    else if (d.rs1 !== 0) {
      avl = cpu.regs[d.rs1] >>> 0;
      ev.push({ kind: "REG_READ", port: 1, reg: d.rs1, value: avl | 0 });
    } else avl = d.rd !== 0 ? 0xffffffff : cpu.vl;
    const vl = info.vill ? 0 : Math.min(avl, info.vlmax);
    const vt = info.vill ? 0x80000000 : vtype;
    cpu.setVState(vl, vt);
    ev.push({ kind: "VSET", avl, vl, vtype: vt >>> 0, vlmax: info.vlmax, sew: info.sew, lmul: info.lmulName, vill: info.vill });
    cpu.setX(d.rd, vl);
    return;
  }

  const info = vtypeInfo(cpu.vtype);
  if (info.vill) ill("vtype is invalid (vill = 1); run vsetvli first");
  const vl = cpu.vl;
  const sew = info.sew;
  const sb = sew / 8;
  const vm = f.vm ?? 1;
  const active = (i: number) => vm === 1 || maskBit(cpu.vregs, 0, i) === 1;
  const lmul = Math.max(1, info.lmulNum / info.lmulDen);
  const aligned = (r: number, group: number, what: string) => {
    if (group > 1 && r % group !== 0) ill(`${what} v${r} must be a multiple of LMUL = ${group}`);
  };
  const lanes: VecLane[] = [];
  const lane = (l: VecLane) => {
    if (lanes.length < MAX_LANES) lanes.push(l);
  };

  // ───── memory ─────
  if (def.animClass === "V_LOAD" || def.animClass === "V_STORE") {
    const eew = def.memWidth! * 8;
    const eb = eew / 8;
    const emulNum = eew * info.lmulNum;
    const emulDen = sew * info.lmulDen;
    if (emulNum * 8 < emulDen || emulNum > 8 * emulDen) ill("EMUL = EEW/SEW × LMUL is out of range");
    const emul = Math.max(1, emulNum / emulDen);
    const reg = def.animClass === "V_LOAD" ? f.vd : f.vs3;
    aligned(reg, emul, "register group");
    if (vm === 0 && def.animClass === "V_LOAD" && reg === 0) ill("a masked load cannot overwrite the mask register v0");
    const base = cpu.regs[d.rs1];
    ev.push({ kind: "REG_READ", port: 1, reg: d.rs1, value: base });
    let stride = eb;
    if (def.op === "strided") {
      stride = cpu.regs[d.rs2];
      ev.push({ kind: "REG_READ", port: 2, reg: d.rs2, value: stride });
    }
    const addrs: number[] = [];
    const values: number[] = [];
    if (def.animClass === "V_LOAD") {
      const buf = cpu.vregs.slice(reg * VLENB, (reg + emul) * VLENB);
      for (let i = 0; i < vl; i++) {
        if (!active(i)) continue;
        const addr = (base + i * stride) >>> 0;
        const v = cpu.load(addr, eb as 1 | 2 | 4);
        writeElem(buf, 0, i, eb, v);
        addrs.push(addr);
        values.push(v);
      }
      cpu.setVBytes(reg * VLENB, buf);
      ev.push({ kind: "VMEM", write: false, base: base >>> 0, stride, sew: eew, addrs, values });
      ev.push({ kind: "VREG_WRITE", reg, regs: emul });
    } else {
      for (let i = 0; i < vl; i++) {
        if (!active(i)) continue;
        const addr = (base + i * stride) >>> 0;
        const v = readElem(cpu.vregs, reg, i, eb);
        cpu.store(addr, eb as 1 | 2 | 4, v);
        addrs.push(addr);
        values.push(v);
      }
      ev.push({ kind: "VMEM", write: true, base: base >>> 0, stride, sew: eew, addrs, values });
    }
    return;
  }

  // ───── arithmetic ─────
  const op = def.op!;
  const vs2 = f.vs2;
  let scalar: number | undefined;
  if (f.rs1 !== undefined && def.layout === "OPVX") {
    scalar = cpu.regs[f.rs1];
    ev.push({ kind: "REG_READ", port: 1, reg: f.rs1, value: scalar });
  }
  const operandB = (i: number): number => {
    if (def.layout === "OPVV") return readElem(cpu.vregs, f.vs1, i, sb);
    if (def.layout === "OPVX") return (scalar! >>> 0) & mask(sew);
    if (def.layout === "OPVI") return f.simm5 & mask(sew);
    return f.uimm5;
  };

  // Mask-register logic and scalar-result instructions work on whole registers.
  if (def.mnemonic.endsWith(".mm")) {
    const buf = cpu.vregs.slice(f.vd * VLENB, (f.vd + 1) * VLENB);
    const fn: Record<string, (a: number, b: number) => number> = {
      MANDN: (a, b) => a & ~b, MAND: (a, b) => a & b, MOR: (a, b) => a | b, MXOR: (a, b) => a ^ b,
      MORN: (a, b) => a | ~b, MNAND: (a, b) => ~(a & b), MNOR: (a, b) => ~(a | b), MXNOR: (a, b) => ~(a ^ b),
    };
    for (let i = 0; i < vl; i++) {
      const a = maskBit(cpu.vregs, vs2, i);
      const b = maskBit(cpu.vregs, f.vs1, i);
      const r = fn[op](a, b) & 1;
      buf[i >> 3] = (buf[i >> 3] & ~(1 << (i & 7))) | (r << (i & 7));
      lane({ i, a, b, out: r, active: true });
    }
    cpu.setVBytes(f.vd * VLENB, buf);
    ev.push({ kind: "VEC", op, sew: 1, vl, lanes, maskOut: true });
    ev.push({ kind: "VREG_WRITE", reg: f.vd, regs: 1 });
    return;
  }

  if (op === "MVXS") {
    const v = sext(readElem(cpu.vregs, vs2, 0, sb), sew);
    ev.push({ kind: "VEC", op, sew, vl, lanes: [{ i: 0, a: v, b: 0, out: v, active: true }] });
    cpu.setX(d.rd, v);
    return;
  }
  if (op === "CPOP" || op === "FIRST") {
    let count = 0;
    let first = -1;
    for (let i = 0; i < vl; i++) {
      if (!active(i)) continue;
      if (maskBit(cpu.vregs, vs2, i)) {
        count++;
        if (first < 0) first = i;
      }
    }
    const v = op === "CPOP" ? count : first;
    ev.push({ kind: "VEC", op, sew: 1, vl, lanes: [], scalar: v });
    cpu.setX(d.rd, v);
    return;
  }

  const isCompare = def.mnemonic.startsWith("vms");
  const isRed = def.mnemonic.startsWith("vred");
  const dGroup = isCompare || isRed || op === "MVSX" ? 1 : lmul;
  aligned(f.vd, dGroup, "destination");
  const toks = def.syntax.split(",");
  if (toks.includes("vs2")) aligned(vs2, lmul, "source");
  if (toks.includes("vs1") && !isRed) aligned(f.vs1, lmul, "source");
  if (vm === 0 && f.vd === 0 && !isCompare && op !== "MERGE") ill("a masked instruction cannot write the mask register v0");
  if (op === "SLIDEUP" && f.vd === vs2) ill("vslideup destination must not overlap the source");

  const buf = cpu.vregs.slice(f.vd * VLENB, (f.vd + dGroup) * VLENB);
  const signedA = (i: number) => sext(readElem(cpu.vregs, vs2, i, sb), sew);

  if (op === "MVSX") {
    if (vl > 0) writeElem(buf, 0, 0, sb, scalar! >>> 0);
    ev.push({ kind: "VEC", op, sew, vl, lanes: [{ i: 0, a: scalar!, b: 0, out: scalar!, active: true }] });
  } else if (isRed) {
    if (vl > 0) {
      let acc = readElem(cpu.vregs, f.vs1, 0, sb);
      for (let i = 0; i < vl; i++) {
        if (!active(i)) continue;
        const x = readElem(cpu.vregs, vs2, i, sb);
        const before = acc;
        acc = reduce(op, acc, x, sew);
        lane({ i, a: before, b: x, out: acc, active: true });
      }
      writeElem(buf, 0, 0, sb, acc);
    }
    ev.push({ kind: "VEC", op, sew, vl, lanes });
  } else if (isCompare) {
    for (let i = 0; i < vl; i++) {
      if (!active(i)) continue;
      const a = readElem(cpu.vregs, vs2, i, sb);
      const b = operandB(i);
      const r = vcompare(op, a, b, sew) ? 1 : 0;
      buf[i >> 3] = (buf[i >> 3] & ~(1 << (i & 7))) | (r << (i & 7));
      lane({ i, a, b, out: r, active: true });
    }
    ev.push({ kind: "VEC", op, sew, vl, lanes, maskOut: true });
  } else if (op === "SLIDEUP" || op === "SLIDEDOWN") {
    const off = def.layout === "OPVX" ? scalar! >>> 0 : f.uimm5;
    for (let i = 0; i < vl; i++) {
      if (!active(i)) continue;
      if (op === "SLIDEUP") {
        if (i < off) continue;
        const v = readElem(cpu.vregs, vs2, i - off, sb);
        writeElem(buf, 0, i, sb, v);
        lane({ i, a: v, b: off, out: v, active: true });
      } else {
        const j = i + off;
        const v = j < info.vlmax ? readElem(cpu.vregs, vs2, j, sb) : 0;
        writeElem(buf, 0, i, sb, v);
        lane({ i, a: v, b: off, out: v, active: true });
      }
    }
    ev.push({ kind: "VEC", op, sew, vl, lanes, scalar });
  } else {
    for (let i = 0; i < vl; i++) {
      if (op === "MERGE") {
        const sel = maskBit(cpu.vregs, 0, i);
        const v = sel ? operandB(i) : readElem(cpu.vregs, vs2, i, sb);
        writeElem(buf, 0, i, sb, v);
        lane({ i, a: readElem(cpu.vregs, vs2, i, sb), b: operandB(i), out: v, active: true });
        continue;
      }
      if (op === "MV") {
        const v = operandB(i);
        writeElem(buf, 0, i, sb, v);
        lane({ i, a: v, b: v, out: v, active: true });
        continue;
      }
      if (!active(i)) {
        lane({ i, a: 0, b: 0, out: readElem(buf, 0, i, sb), active: false });
        continue;
      }
      if (op === "ID") {
        writeElem(buf, 0, i, sb, i);
        lane({ i, a: i, b: 0, out: i, active: true });
        continue;
      }
      const a = readElem(cpu.vregs, vs2, i, sb);
      const b = operandB(i);
      const acc = op === "MACC" || op === "NMSAC" ? readElem(cpu.vregs, f.vd, i, sb) : 0;
      const r = varith(op, a, b, acc, sew, signedA(i)) & mask(sew);
      writeElem(buf, 0, i, sb, r >>> 0);
      lane({ i, a, b, out: r >>> 0, active: true });
    }
    ev.push({ kind: "VEC", op, sew, vl, lanes, scalar });
  }
  cpu.setVBytes(f.vd * VLENB, buf);
  ev.push({ kind: "VREG_WRITE", reg: f.vd, regs: dGroup });
}

function varith(op: string, a: number, b: number, acc: number, sew: number, sa: number): number {
  const sb = sext(b, sew);
  const ua = a >>> 0;
  const ub = b >>> 0;
  const sh = b & (sew - 1);
  switch (op) {
    case "VADD": return a + b;
    case "VSUB": return a - b;
    case "VRSUB": return b - a;
    case "VAND": return a & b;
    case "VOR": return a | b;
    case "VXOR": return a ^ b;
    case "VMINU": return ua < ub ? a : b;
    case "VMIN": return sa < sb ? a : b;
    case "VMAXU": return ua > ub ? a : b;
    case "VMAX": return sa > sb ? a : b;
    case "SLL": return a << sh;
    case "SRL": return ua >>> sh;
    case "SRA": return sa >> sh;
    case "VMUL": return Math.imul(a, b);
    case "VMULH": return Number((BigInt(sa) * BigInt(sb)) >> BigInt(sew)) | 0;
    case "VMULHU": return Number((BigInt(ua) * BigInt(ub)) >> BigInt(sew));
    case "VDIVU": return ub === 0 ? -1 : Math.floor(ua / ub);
    case "VDIV":
      if (sb === 0) return -1;
      if (sa === -(2 ** (sew - 1)) && sb === -1) return sa;
      return Math.trunc(sa / sb);
    case "VREMU": return ub === 0 ? a : ua % ub;
    case "VREM":
      if (sb === 0) return a;
      if (sa === -(2 ** (sew - 1)) && sb === -1) return 0;
      return sa % sb;
    case "MACC": return Math.imul(b, a) + acc;
    case "NMSAC": return acc - Math.imul(b, a);
  }
  throw new Trap(2, 0, `vector operation ${op} not implemented`);
}

function vcompare(op: string, a: number, b: number, sew: number): boolean {
  const sa = sext(a, sew);
  const sb = sext(b, sew);
  const ua = a >>> 0;
  const ub = b >>> 0;
  switch (op) {
    case "SEQ": return ua === ub;
    case "SNE": return ua !== ub;
    case "SLTU": return ua < ub;
    case "SLT": return sa < sb;
    case "SLEU": return ua <= ub;
    case "SLE": return sa <= sb;
    case "SGTU": return ua > ub;
    case "SGT": return sa > sb;
  }
  return false;
}

function reduce(op: string, acc: number, x: number, sew: number): number {
  const m = mask(sew);
  switch (op) {
    case "SUM": return (acc + x) & m;
    case "AND": return acc & x;
    case "OR": return acc | x;
    case "XOR": return acc ^ x;
    case "MINU": return (acc >>> 0) < (x >>> 0) ? acc : x;
    case "MAXU": return (acc >>> 0) > (x >>> 0) ? acc : x;
    case "MIN": return sext(acc, sew) < sext(x, sew) ? acc : x;
    case "MAX": return sext(acc, sew) > sext(x, sew) ? acc : x;
  }
  return acc;
}

/** Human-readable element list for panels: "[1, 2, 3, …]". */
export function formatVreg(v: Uint8Array, reg: number, sew: number, count: number): string {
  const sb = sew / 8;
  const out: string[] = [];
  for (let i = 0; i < Math.min(count, VLENB / sb); i++) out.push(hex32(readElem(v, reg, i, sb)).slice(10 - sb * 2));
  return out.join(" ");
}

export { readElem as readVElem, maskBit as readMaskBit };
