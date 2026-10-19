/**
 * C extension (RV32C, including the F/D load/stores): 16-bit instructions.
 *
 * Every compressed instruction expands 1:1 to a 32-bit instruction; the core
 * executes the expansion, and the UI animates the "expand" step. The same
 * bit-placement tables drive decoding, encoding and auto-compression.
 */
import { BY_MNEMONIC, type InstrDef } from "./instructions";
import { encode, type EncodeOperands } from "./encoding";

/** [instruction bit, immediate bit] pairs. */
type BitMap = [number, number][];

const MAPS = {
  addi4spn: [[12, 5], [11, 4], [10, 9], [9, 8], [8, 7], [7, 6], [6, 2], [5, 3]],
  memW: [[12, 5], [11, 4], [10, 3], [6, 2], [5, 6]],
  memD: [[12, 5], [11, 4], [10, 3], [6, 7], [5, 6]],
  ci: [[12, 5], [6, 4], [5, 3], [4, 2], [3, 1], [2, 0]],
  addi16sp: [[12, 9], [6, 4], [5, 6], [4, 8], [3, 7], [2, 5]],
  lui: [[12, 17], [6, 16], [5, 15], [4, 14], [3, 13], [2, 12]],
  j: [[12, 11], [11, 4], [10, 9], [9, 8], [8, 10], [7, 6], [6, 7], [5, 3], [4, 2], [3, 1], [2, 5]],
  b: [[12, 8], [11, 4], [10, 3], [6, 7], [5, 6], [4, 2], [3, 1], [2, 5]],
  lwsp: [[12, 5], [6, 4], [5, 3], [4, 2], [3, 7], [2, 6]],
  ldsp: [[12, 5], [6, 4], [5, 3], [4, 8], [3, 7], [2, 6]],
  swsp: [[12, 5], [11, 4], [10, 3], [9, 2], [8, 7], [7, 6]],
  sdsp: [[12, 5], [11, 4], [10, 3], [9, 8], [8, 7], [7, 6]],
} satisfies Record<string, BitMap>;

type MapId = keyof typeof MAPS;

function getImm(h: number, map: BitMap, signBit?: number): number {
  let v = 0;
  for (const [ib, mb] of map) v |= ((h >>> ib) & 1) << mb;
  if (signBit !== undefined) {
    const s = 31 - signBit;
    v = (v << s) >> s;
  }
  return v;
}

function putImm(v: number, map: BitMap): number {
  let h = 0;
  for (const [ib, mb] of map) h |= ((v >>> mb) & 1) << ib;
  return h;
}

/** The immediate bits a map can represent, as a mask. */
function mapMask(map: BitMap): number {
  return map.reduce((m, [, b]) => m | (1 << b), 0);
}

const rp = (h: number, lo: number) => 8 + ((h >>> lo) & 7);
const r5 = (h: number, lo: number) => (h >>> lo) & 31;

/** Compressed instruction kinds, with their operand syntax for the assembler. */
export interface CDef {
  mnemonic: string;
  /** Tokens: rd rs1 rs2 (any x), rd' rs1' rs2' (x8–x15), fd' fs2' fd fs2, imm, uimm, mem, memsp, offB, offJ, nzimm. */
  syntax: string;
  summary: string;
}

export const C_DEFS: CDef[] = [
  { mnemonic: "c.addi4spn", syntax: "rd',sp,uimm", summary: "rd' ← sp + nzuimm×4 (stack addresses)" },
  { mnemonic: "c.fld", syntax: "fd',mem'", summary: "fld with a 3-bit register field" },
  { mnemonic: "c.lw", syntax: "rd',mem'", summary: "lw rd', uimm(rs1')" },
  { mnemonic: "c.flw", syntax: "fd',mem'", summary: "flw with a 3-bit register field" },
  { mnemonic: "c.fsd", syntax: "fs2',mem'", summary: "fsd with a 3-bit register field" },
  { mnemonic: "c.sw", syntax: "rs2',mem'", summary: "sw rs2', uimm(rs1')" },
  { mnemonic: "c.fsw", syntax: "fs2',mem'", summary: "fsw with a 3-bit register field" },
  { mnemonic: "c.nop", syntax: "", summary: "addi x0, x0, 0" },
  { mnemonic: "c.addi", syntax: "rd,imm", summary: "addi rd, rd, nzimm" },
  { mnemonic: "c.jal", syntax: "offJ", summary: "jal ra, offset (±2 KiB)" },
  { mnemonic: "c.li", syntax: "rd,imm", summary: "addi rd, x0, imm" },
  { mnemonic: "c.addi16sp", syntax: "sp,imm", summary: "addi sp, sp, nzimm×16" },
  { mnemonic: "c.lui", syntax: "rd,uimm20", summary: "lui rd, nzimm (6 bits, sign-extended)" },
  { mnemonic: "c.srli", syntax: "rd',uimm", summary: "srli rd', rd', shamt" },
  { mnemonic: "c.srai", syntax: "rd',uimm", summary: "srai rd', rd', shamt" },
  { mnemonic: "c.andi", syntax: "rd',imm", summary: "andi rd', rd', imm" },
  { mnemonic: "c.sub", syntax: "rd',rs2'", summary: "sub rd', rd', rs2'" },
  { mnemonic: "c.xor", syntax: "rd',rs2'", summary: "xor rd', rd', rs2'" },
  { mnemonic: "c.or", syntax: "rd',rs2'", summary: "or rd', rd', rs2'" },
  { mnemonic: "c.and", syntax: "rd',rs2'", summary: "and rd', rd', rs2'" },
  { mnemonic: "c.j", syntax: "offJ", summary: "jal x0, offset (±2 KiB)" },
  { mnemonic: "c.beqz", syntax: "rs1',offB", summary: "beq rs1', x0, offset (±256 B)" },
  { mnemonic: "c.bnez", syntax: "rs1',offB", summary: "bne rs1', x0, offset (±256 B)" },
  { mnemonic: "c.slli", syntax: "rd,uimm", summary: "slli rd, rd, shamt" },
  { mnemonic: "c.fldsp", syntax: "fd,memsp", summary: "fld fd, uimm(sp)" },
  { mnemonic: "c.lwsp", syntax: "rd,memsp", summary: "lw rd, uimm(sp)" },
  { mnemonic: "c.flwsp", syntax: "fd,memsp", summary: "flw fd, uimm(sp)" },
  { mnemonic: "c.jr", syntax: "rs1", summary: "jalr x0, 0(rs1)" },
  { mnemonic: "c.mv", syntax: "rd,rs2", summary: "add rd, x0, rs2" },
  { mnemonic: "c.ebreak", syntax: "", summary: "ebreak" },
  { mnemonic: "c.jalr", syntax: "rs1", summary: "jalr ra, 0(rs1)" },
  { mnemonic: "c.add", syntax: "rd,rs2", summary: "add rd, rd, rs2" },
  { mnemonic: "c.fsdsp", syntax: "fs2,memsp", summary: "fsd fs2, uimm(sp)" },
  { mnemonic: "c.swsp", syntax: "rs2,memsp", summary: "sw rs2, uimm(sp)" },
  { mnemonic: "c.fswsp", syntax: "fs2,memsp", summary: "fsw fs2, uimm(sp)" },
];

export const C_BY_MNEMONIC = new Map(C_DEFS.map((d) => [d.mnemonic, d]));

/** A compressed instruction in "32-bit terms": the base mnemonic and its operand fields. */
export interface CExpansion {
  mnemonic: string;
  base: InstrDef;
  ops: EncodeOperands;
  word: number;
}

const X = (mnemonic: string, base: string, ops: EncodeOperands): CExpansion => {
  const def = BY_MNEMONIC.get(base)!;
  return { mnemonic, base: def, ops, word: encode(def, ops) };
};

/** Decode a 16-bit compressed instruction into its 32-bit expansion. Undefined = illegal/reserved. */
export function expandC(h: number): CExpansion | undefined {
  h &= 0xffff;
  if (h === 0) return undefined; // defined illegal
  const q = h & 3;
  const f3 = (h >>> 13) & 7;
  const b12 = (h >>> 12) & 1;
  if (q === 0) {
    switch (f3) {
      case 0: {
        const imm = getImm(h, MAPS.addi4spn);
        if (imm === 0) return undefined;
        return X("c.addi4spn", "addi", { rd: rp(h, 2), rs1: 2, imm });
      }
      case 1: return X("c.fld", "fld", { rd: rp(h, 2), rs1: rp(h, 7), imm: getImm(h, MAPS.memD) });
      case 2: return X("c.lw", "lw", { rd: rp(h, 2), rs1: rp(h, 7), imm: getImm(h, MAPS.memW) });
      case 3: return X("c.flw", "flw", { rd: rp(h, 2), rs1: rp(h, 7), imm: getImm(h, MAPS.memW) });
      case 5: return X("c.fsd", "fsd", { rs2: rp(h, 2), rs1: rp(h, 7), imm: getImm(h, MAPS.memD) });
      case 6: return X("c.sw", "sw", { rs2: rp(h, 2), rs1: rp(h, 7), imm: getImm(h, MAPS.memW) });
      case 7: return X("c.fsw", "fsw", { rs2: rp(h, 2), rs1: rp(h, 7), imm: getImm(h, MAPS.memW) });
      default: return undefined;
    }
  }
  if (q === 1) {
    const rd = r5(h, 7);
    switch (f3) {
      case 0: {
        const imm = getImm(h, MAPS.ci, 5);
        return X(rd === 0 && imm === 0 ? "c.nop" : "c.addi", "addi", { rd, rs1: rd, imm });
      }
      case 1: return X("c.jal", "jal", { rd: 1, imm: getImm(h, MAPS.j, 11) });
      case 2: return X("c.li", "addi", { rd, rs1: 0, imm: getImm(h, MAPS.ci, 5) });
      case 3: {
        if (rd === 2) {
          const imm = getImm(h, MAPS.addi16sp, 9);
          if (imm === 0) return undefined;
          return X("c.addi16sp", "addi", { rd: 2, rs1: 2, imm });
        }
        const imm = getImm(h, MAPS.lui, 17);
        if (imm === 0) return undefined;
        return X("c.lui", "lui", { rd, imm });
      }
      case 4: {
        const rdp = rp(h, 7);
        const sub = (h >>> 10) & 3;
        if (sub === 0 || sub === 1) {
          if (b12) return undefined; // shamt[5] = 1 is reserved on RV32
          return X(sub === 0 ? "c.srli" : "c.srai", sub === 0 ? "srli" : "srai", { rd: rdp, rs1: rdp, shamt: getImm(h, MAPS.ci) });
        }
        if (sub === 2) return X("c.andi", "andi", { rd: rdp, rs1: rdp, imm: getImm(h, MAPS.ci, 5) });
        if (b12) return undefined; // c.subw / c.addw are RV64 only
        const op = ["sub", "xor", "or", "and"][(h >>> 5) & 3];
        return X(`c.${op}`, op, { rd: rdp, rs1: rdp, rs2: rp(h, 2) });
      }
      case 5: return X("c.j", "jal", { rd: 0, imm: getImm(h, MAPS.j, 11) });
      case 6: return X("c.beqz", "beq", { rs1: rp(h, 7), rs2: 0, imm: getImm(h, MAPS.b, 8) });
      case 7: return X("c.bnez", "bne", { rs1: rp(h, 7), rs2: 0, imm: getImm(h, MAPS.b, 8) });
    }
  }
  if (q === 2) {
    const rd = r5(h, 7);
    const rs2 = r5(h, 2);
    switch (f3) {
      case 0:
        if (b12) return undefined;
        return X("c.slli", "slli", { rd, rs1: rd, shamt: getImm(h, MAPS.ci) });
      case 1: return X("c.fldsp", "fld", { rd, rs1: 2, imm: getImm(h, MAPS.ldsp) });
      case 2:
        if (rd === 0) return undefined;
        return X("c.lwsp", "lw", { rd, rs1: 2, imm: getImm(h, MAPS.lwsp) });
      case 3: return X("c.flwsp", "flw", { rd, rs1: 2, imm: getImm(h, MAPS.lwsp) });
      case 4:
        if (!b12) {
          if (rs2 === 0) return rd === 0 ? undefined : X("c.jr", "jalr", { rd: 0, rs1: rd, imm: 0 });
          return X("c.mv", "add", { rd, rs1: 0, rs2 });
        }
        if (rs2 === 0) return rd === 0 ? X("c.ebreak", "ebreak", {}) : X("c.jalr", "jalr", { rd: 1, rs1: rd, imm: 0 });
        return X("c.add", "add", { rd, rs1: rd, rs2 });
      case 5: return X("c.fsdsp", "fsd", { rs2, rs1: 2, imm: getImm(h, MAPS.sdsp) });
      case 6: return X("c.swsp", "sw", { rs2, rs1: 2, imm: getImm(h, MAPS.swsp) });
      case 7: return X("c.fswsp", "fsw", { rs2, rs1: 2, imm: getImm(h, MAPS.swsp) });
    }
  }
  return undefined;
}

// ───────────────────────── encoding ─────────────────────────

export class CEncodeError extends Error {}
const bad = (msg: string): never => {
  throw new CEncodeError(msg);
};

const isP = (r: number) => r >= 8 && r <= 15;
const needP = (r: number, what: string) => (isP(r) ? r - 8 : bad(`${what} must be one of x8–x15 (s0, s1, a0–a5) in a compressed instruction`));

function fitsImm(v: number, id: MapId, signed: boolean, signBit: number, what: string): number {
  const mask = mapMask(MAPS[id]);
  const lo = signed ? -(2 ** signBit) : 0;
  const hi = signed ? 2 ** signBit - 1 : mask;
  if (v < lo || v > hi || ((v & ~mask) & ((1 << (signBit + 1)) - 1)) !== 0) {
    const step = mask & -mask;
    bad(`${what} ${v} does not fit (${lo}…${hi}${step > 1 ? `, multiple of ${step}` : ""})`);
  }
  return putImm(v, MAPS[id]);
}

/** Operand values gathered by the assembler for a c.* mnemonic. */
export interface COperands {
  rd?: number;
  rs1?: number;
  rs2?: number;
  imm?: number;
}

/** Encode an explicit c.* instruction. Throws CEncodeError with a learner-friendly message. */
export function encodeC(mnemonic: string, o: COperands): number {
  const rd = o.rd ?? 0;
  const rs1 = o.rs1 ?? 0;
  const rs2 = o.rs2 ?? 0;
  const imm = o.imm ?? 0;
  const q0 = (f3: number) => (f3 << 13);
  const q1 = (f3: number) => (f3 << 13) | 1;
  const q2 = (f3: number) => (f3 << 13) | 2;
  switch (mnemonic) {
    case "c.addi4spn":
      if (imm === 0) bad("c.addi4spn needs a non-zero offset");
      return q0(0) | fitsImm(imm, "addi4spn", false, 9, "offset") | (needP(rd, "rd") << 2);
    case "c.fld": return q0(1) | fitsImm(imm, "memD", false, 7, "offset") | (needP(rs1, "base") << 7) | (needP(rd, "fd") << 2);
    case "c.lw": return q0(2) | fitsImm(imm, "memW", false, 6, "offset") | (needP(rs1, "base") << 7) | (needP(rd, "rd") << 2);
    case "c.flw": return q0(3) | fitsImm(imm, "memW", false, 6, "offset") | (needP(rs1, "base") << 7) | (needP(rd, "fd") << 2);
    case "c.fsd": return q0(5) | fitsImm(imm, "memD", false, 7, "offset") | (needP(rs1, "base") << 7) | (needP(rs2, "fs2") << 2);
    case "c.sw": return q0(6) | fitsImm(imm, "memW", false, 6, "offset") | (needP(rs1, "base") << 7) | (needP(rs2, "rs2") << 2);
    case "c.fsw": return q0(7) | fitsImm(imm, "memW", false, 6, "offset") | (needP(rs1, "base") << 7) | (needP(rs2, "fs2") << 2);
    case "c.nop": return q1(0);
    case "c.addi":
      if (rd === 0) bad("c.addi needs rd ≠ x0");
      return q1(0) | fitsImm(imm, "ci", true, 5, "immediate") | (rd << 7);
    case "c.jal": return q1(1) | fitsImm(imm, "j", true, 11, "jump offset");
    case "c.li":
      if (rd === 0) bad("c.li needs rd ≠ x0");
      return q1(2) | fitsImm(imm, "ci", true, 5, "immediate") | (rd << 7);
    case "c.addi16sp":
      if (imm === 0) bad("c.addi16sp needs a non-zero immediate");
      return q1(3) | fitsImm(imm, "addi16sp", true, 9, "immediate") | (2 << 7);
    case "c.lui": {
      if (rd === 0 || rd === 2) bad("c.lui needs rd ≠ x0, x2");
      const v = (imm << 12) >> 12; // accept 0xFFFFF-style 20-bit values for negative immediates
      if (v === 0) bad("c.lui needs a non-zero immediate");
      return q1(3) | fitsImm(v << 12, "lui", true, 17, "upper immediate") | (rd << 7);
    }
    case "c.srli": case "c.srai": {
      if (imm < 1 || imm > 31) bad("shift amount must be 1…31");
      return q1(4) | ((mnemonic === "c.srli" ? 0 : 1) << 10) | (needP(rd, "rd") << 7) | putImm(imm, MAPS.ci);
    }
    case "c.andi": return q1(4) | (2 << 10) | (needP(rd, "rd") << 7) | fitsImm(imm, "ci", true, 5, "immediate");
    case "c.sub": case "c.xor": case "c.or": case "c.and": {
      const k = ["c.sub", "c.xor", "c.or", "c.and"].indexOf(mnemonic);
      return q1(4) | (3 << 10) | (needP(rd, "rd") << 7) | (k << 5) | (needP(rs2, "rs2") << 2);
    }
    case "c.j": return q1(5) | fitsImm(imm, "j", true, 11, "jump offset");
    case "c.beqz": return q1(6) | (needP(rs1, "rs1") << 7) | fitsImm(imm, "b", true, 8, "branch offset");
    case "c.bnez": return q1(7) | (needP(rs1, "rs1") << 7) | fitsImm(imm, "b", true, 8, "branch offset");
    case "c.slli":
      if (rd === 0) bad("c.slli needs rd ≠ x0");
      if (imm < 1 || imm > 31) bad("shift amount must be 1…31");
      return q2(0) | (rd << 7) | putImm(imm, MAPS.ci);
    case "c.fldsp": return q2(1) | (rd << 7) | fitsImm(imm, "ldsp", false, 8, "offset");
    case "c.lwsp":
      if (rd === 0) bad("c.lwsp needs rd ≠ x0");
      return q2(2) | (rd << 7) | fitsImm(imm, "lwsp", false, 7, "offset");
    case "c.flwsp": return q2(3) | (rd << 7) | fitsImm(imm, "lwsp", false, 7, "offset");
    case "c.jr":
      if (rs1 === 0) bad("c.jr needs rs1 ≠ x0");
      return q2(4) | (rs1 << 7);
    case "c.mv":
      if (rd === 0 || rs2 === 0) bad("c.mv needs rd ≠ x0 and rs2 ≠ x0");
      return q2(4) | (rd << 7) | (rs2 << 2);
    case "c.ebreak": return q2(4) | (1 << 12);
    case "c.jalr":
      if (rs1 === 0) bad("c.jalr needs rs1 ≠ x0");
      return q2(4) | (1 << 12) | (rs1 << 7);
    case "c.add":
      if (rd === 0 || rs2 === 0) bad("c.add needs rd ≠ x0 and rs2 ≠ x0");
      return q2(4) | (1 << 12) | (rd << 7) | (rs2 << 2);
    case "c.fsdsp": return q2(5) | (rs2 << 2) | fitsImm(imm, "sdsp", false, 8, "offset");
    case "c.swsp": return q2(6) | (rs2 << 2) | fitsImm(imm, "swsp", false, 7, "offset");
    case "c.fswsp": return q2(7) | (rs2 << 2) | fitsImm(imm, "swsp", false, 7, "offset");
  }
  return bad(`unknown compressed instruction ${mnemonic}`);
}

/**
 * Try to compress a 32-bit instruction (".option rvc"). PC-relative
 * branches and jumps are left alone so instruction sizes stay stable.
 */
export function tryCompress(def: InstrDef, o: EncodeOperands): number | null {
  const rd = o.rd ?? 0;
  const rs1 = o.rs1 ?? 0;
  const rs2 = o.rs2 ?? 0;
  const imm = o.imm ?? 0;
  const t = (m: string, ops: COperands) => {
    try {
      return encodeC(m, ops);
    } catch {
      return null;
    }
  };
  switch (def.mnemonic) {
    case "addi":
      if (rd === 0 && rs1 === 0 && imm === 0) return t("c.nop", {});
      if (rd === 2 && rs1 === 2 && imm !== 0) return t("c.addi16sp", { imm });
      if (rs1 === 2 && isP(rd) && imm > 0) return t("c.addi4spn", { rd, imm });
      if (rs1 === 0 && rd !== 0) return t("c.li", { rd, imm });
      if (rd === rs1 && rd !== 0 && imm !== 0) return t("c.addi", { rd, imm });
      if (imm === 0 && rd !== 0 && rs1 !== 0) return t("c.mv", { rd, rs2: rs1 });
      return null;
    case "add":
      if (rs1 === 0) return t("c.mv", { rd, rs2 });
      if (rd === rs1) return t("c.add", { rd, rs2 });
      if (rd === rs2) return t("c.add", { rd, rs2: rs1 });
      return null;
    case "lui": return t("c.lui", { rd, imm: (imm >>> 12) & 0xfffff });
    case "lw": return rs1 === 2 ? t("c.lwsp", { rd, imm }) : t("c.lw", { rd, rs1, imm });
    case "sw": return rs1 === 2 ? t("c.swsp", { rs2, imm }) : t("c.sw", { rs2, rs1, imm });
    case "flw": return rs1 === 2 ? t("c.flwsp", { rd, imm }) : t("c.flw", { rd, rs1, imm });
    case "fsw": return rs1 === 2 ? t("c.fswsp", { rs2, imm }) : t("c.fsw", { rs2, rs1, imm });
    case "fld": return rs1 === 2 ? t("c.fldsp", { rd, imm }) : t("c.fld", { rd, rs1, imm });
    case "fsd": return rs1 === 2 ? t("c.fsdsp", { rs2, imm }) : t("c.fsd", { rs2, rs1, imm });
    case "slli": return rd === rs1 ? t("c.slli", { rd, imm: o.shamt ?? 0 }) : null;
    case "srli": case "srai": return rd === rs1 ? t(`c.${def.mnemonic}`, { rd, imm: o.shamt ?? 0 }) : null;
    case "andi": return rd === rs1 ? t("c.andi", { rd, imm }) : null;
    case "sub": case "xor": case "or": case "and": return rd === rs1 ? t(`c.${def.mnemonic}`, { rd, rs2 }) : null;
    case "jalr":
      if (imm !== 0) return null;
      if (rd === 0) return t("c.jr", { rs1 });
      if (rd === 1) return t("c.jalr", { rs1 });
      return null;
    case "ebreak": return t("c.ebreak", {});
    default: return null;
  }
}
