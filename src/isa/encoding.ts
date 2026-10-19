import type { Format, InstrDef } from "./instructions";
import { lookup } from "./instructions";

/** Semantic kinds of bit fields, used for colors in the encoding view. */
export type FieldKind = "opcode" | "rd" | "funct3" | "rs1" | "rs2" | "funct7" | "imm" | "shamt";

export interface BitField {
  kind: FieldKind;
  /** Inclusive instruction bit positions, hi ≥ lo. */
  hi: number;
  lo: number;
  /** Label shown in the bit strip, e.g. "imm[10:5]". */
  label: string;
  /** For immediate pieces: which immediate bits this field holds. */
  immHi?: number;
  immLo?: number;
}

const f = (kind: FieldKind, hi: number, lo: number, label?: string, immHi?: number, immLo?: number): BitField => ({
  kind, hi, lo, label: label ?? kind, immHi, immLo,
});

const BASE = {
  opcode: f("opcode", 6, 0),
  rd: f("rd", 11, 7),
  funct3: f("funct3", 14, 12),
  rs1: f("rs1", 19, 15),
  rs2: f("rs2", 24, 20),
  funct7: f("funct7", 31, 25),
};

/** Field layouts, most-significant first, exactly as in the ISA manual. */
export const LAYOUTS: Record<Format | "I_SHIFT", BitField[]> = {
  R: [BASE.funct7, BASE.rs2, BASE.rs1, BASE.funct3, BASE.rd, BASE.opcode],
  I: [f("imm", 31, 20, "imm[11:0]", 11, 0), BASE.rs1, BASE.funct3, BASE.rd, BASE.opcode],
  I_SHIFT: [f("funct7", 31, 25, "imm[11:5]"), f("shamt", 24, 20, "shamt"), BASE.rs1, BASE.funct3, BASE.rd, BASE.opcode],
  S: [f("imm", 31, 25, "imm[11:5]", 11, 5), BASE.rs2, BASE.rs1, BASE.funct3, f("imm", 11, 7, "imm[4:0]", 4, 0), BASE.opcode],
  B: [
    f("imm", 31, 31, "imm[12]", 12, 12), f("imm", 30, 25, "imm[10:5]", 10, 5), BASE.rs2, BASE.rs1, BASE.funct3,
    f("imm", 11, 8, "imm[4:1]", 4, 1), f("imm", 7, 7, "imm[11]", 11, 11), BASE.opcode,
  ],
  U: [f("imm", 31, 12, "imm[31:12]", 31, 12), BASE.rd, BASE.opcode],
  J: [
    f("imm", 31, 31, "imm[20]", 20, 20), f("imm", 30, 21, "imm[10:1]", 10, 1), f("imm", 20, 20, "imm[11]", 11, 11),
    f("imm", 19, 12, "imm[19:12]", 19, 12), BASE.rd, BASE.opcode,
  ],
};

export function layoutFor(def: InstrDef): BitField[] {
  if (def.syntax === "rd,rs1,shamt") return LAYOUTS.I_SHIFT;
  return LAYOUTS[def.format];
}

export const bits = (w: number, hi: number, lo: number): number => (w >>> lo) & ((2 ** (hi - lo + 1)) - 1);

/** Immediate decoders. `w | 0` makes `>>` sign-extend from bit 31. */
export const IMM = {
  I: (word: number) => (word | 0) >> 20,
  S: (word: number) => (((word | 0) >> 25) << 5) | ((word >>> 7) & 0x1f),
  B: (word: number) =>
    (((word | 0) >> 31) << 12) | (((word >>> 7) & 1) << 11) | (((word >>> 25) & 0x3f) << 5) | (((word >>> 8) & 0xf) << 1),
  U: (word: number) => (word & 0xfffff000) | 0,
  J: (word: number) =>
    (((word | 0) >> 31) << 20) | (((word >>> 12) & 0xff) << 12) | (((word >>> 20) & 1) << 11) | (((word >>> 21) & 0x3ff) << 1),
  R: () => 0,
} satisfies Record<Format, (w: number) => number>;

export interface Decoded {
  word: number;
  def: InstrDef;
  opcode: number;
  rd: number;
  funct3: number;
  rs1: number;
  rs2: number;
  funct7: number;
  /** Sign-extended immediate (shamt for shift-immediates, 0 for R-type). */
  imm: number;
}

export function decode(word: number): Decoded | undefined {
  const w = word >>> 0;
  const def = lookup(w);
  if (!def) return undefined;
  let imm = IMM[def.format](w);
  if (def.syntax === "rd,rs1,shamt") imm = bits(w, 24, 20);
  return {
    word: w,
    def,
    opcode: w & 0x7f,
    rd: bits(w, 11, 7),
    funct3: bits(w, 14, 12),
    rs1: bits(w, 19, 15),
    rs2: bits(w, 24, 20),
    funct7: bits(w, 31, 25),
    imm,
  };
}

export interface EncodeOperands {
  rd?: number;
  rs1?: number;
  rs2?: number;
  imm?: number;
}

/** Encode an instruction. Range checks are the assembler's job; here bits are masked. */
export function encode(def: InstrDef, ops: EncodeOperands): number {
  const rd = (ops.rd ?? 0) & 31;
  const rs1 = (ops.rs1 ?? 0) & 31;
  const rs2 = (ops.rs2 ?? 0) & 31;
  const imm = ops.imm ?? 0;
  const op = def.opcode;
  const f3 = (def.funct3 ?? 0) << 12;
  let w: number;
  switch (def.format) {
    case "R":
      w = ((def.funct7 ?? 0) << 25) | (rs2 << 20) | (rs1 << 15) | f3 | (rd << 7) | op;
      break;
    case "I":
      if (def.fixedImm !== undefined) {
        w = def.match;
      } else if (def.syntax === "rd,rs1,shamt") {
        w = ((def.funct7 ?? 0) << 25) | ((imm & 31) << 20) | (rs1 << 15) | f3 | (rd << 7) | op;
      } else {
        w = ((imm & 0xfff) << 20) | (rs1 << 15) | f3 | (rd << 7) | op;
      }
      break;
    case "S":
      w = (((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | f3 | ((imm & 0x1f) << 7) | op;
      break;
    case "B":
      w = (((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | f3 |
        (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | op;
      break;
    case "U":
      w = (imm & 0xfffff000) | (rd << 7) | op;
      break;
    case "J":
      w = (((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20) |
        (((imm >> 12) & 0xff) << 12) | (rd << 7) | op;
      break;
  }
  return w >>> 0;
}
