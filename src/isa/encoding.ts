import { layoutOf, lookup, type InstrDef } from "./instructions";
import { fieldKind, type FieldKind, type LayoutField } from "./layouts";

export type { FieldKind } from "./layouts";

/** A layout field resolved for display: colour group plus label. */
export interface BitField extends LayoutField {
  kind: FieldKind;
  label: string;
}

export const bits = (w: number, hi: number, lo: number): number =>
  hi - lo === 31 ? w >>> 0 : (w >>> lo) & ((2 ** (hi - lo + 1)) - 1);

/** Fields of an instruction's layout, most significant first, ready for the bit strip. */
export function layoutFor(def: InstrDef): BitField[] {
  return layoutOf(def).map((f) => ({ ...f, kind: fieldKind(f.name), label: f.label ?? f.name }));
}

export interface Decoded {
  word: number;
  def: InstrDef;
  /** Every layout field by name (immediate pieces are combined into `imm`). */
  f: Record<string, number>;
  opcode: number;
  rd: number;
  funct3: number;
  rs1: number;
  rs2: number;
  rs3: number;
  funct7: number;
  /** Sign-extended immediate (shamt for shift-immediates, 0 when there is none). */
  imm: number;
  /** Set when this instruction was fetched as a 16-bit compressed instruction. */
  compressed?: { half: number; mnemonic: string; asm?: string };
}

/** Decode a 32-bit word. Returns undefined for an illegal or unsupported encoding. */
export function decode(word: number): Decoded | undefined {
  const w = word >>> 0;
  const def = lookup(w);
  if (!def) return undefined;
  const f: Record<string, number> = {};
  let imm = 0;
  let immTop = -1;
  for (const fl of layoutOf(def)) {
    const v = bits(w, fl.hi, fl.lo);
    if (fl.immLo !== undefined) {
      imm |= v << fl.immLo;
      immTop = Math.max(immTop, fl.immHi!);
    } else f[fl.name] = v;
  }
  if (immTop >= 0) {
    const shift = 31 - immTop;
    imm = (imm << shift) >> shift;
    f.imm = imm;
  } else if (f.shamt !== undefined) imm = f.shamt;
  if (f.simm5 !== undefined) f.simm5 = (f.simm5 << 27) >> 27;
  // Scalar results of vector instructions (vmv.x.s, vcpop.m) sit in the vd slot.
  if (f.rd === undefined && f.vd !== undefined) f.rd = f.vd;
  return {
    word: w,
    def,
    f,
    opcode: w & 0x7f,
    rd: bits(w, 11, 7),
    funct3: bits(w, 14, 12),
    rs1: bits(w, 19, 15),
    rs2: bits(w, 24, 20),
    rs3: bits(w, 31, 27),
    funct7: bits(w, 31, 25),
    imm,
  };
}

/** Operand values by field name (rd, rs1, rs2, rs3, imm, shamt, csr, zimm, rm, vm, aq, rl, vd, vs1…). */
export type EncodeOperands = Record<string, number | undefined>;

/** Field each assembly operand token is stored in. */
export const TOKEN_FIELD: Record<string, string> = {
  fd: "rd", fs1: "rs1", fs2: "rs2", fs3: "rs3", offB: "imm", offJ: "imm", uimm20: "imm", rm: "funct3",
};

/** Encode an instruction. Range checks are the assembler's job; here values are masked to their fields. */
export function encode(def: InstrDef, ops: EncodeOperands): number {
  let w = 0;
  for (const fl of layoutOf(def)) {
    const width = fl.hi - fl.lo + 1;
    const m = width === 32 ? 0xffffffff : (1 << width) - 1;
    let v: number;
    if (fl.immLo !== undefined) {
      v = ((def.fixed.imm ?? ops.imm ?? 0) >> fl.immLo) & m;
    } else {
      v = (def.fixed[fl.name] ?? ops[fl.name] ?? (fl.name === "vd" ? ops.rd : undefined) ?? defaultField(fl.name, def)) & m;
    }
    w |= v << fl.lo;
  }
  return w >>> 0;
}

function defaultField(name: string, def: InstrDef): number {
  if (name === "funct3" && def.defaultRm !== undefined) return def.defaultRm;
  if (name === "vm") return 1;
  return 0;
}
