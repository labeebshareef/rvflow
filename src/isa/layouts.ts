/**
 * Bit layouts of every 32-bit instruction shape, most-significant field first,
 * exactly as drawn in the ISA manual. An instruction definition names a layout
 * and gives values for its fixed fields; the remaining fields are operands.
 *
 * Immediate pieces carry `immHi/immLo`: the immediate bits they hold. Encoding
 * and decoding are generic over these tables.
 */

export interface LayoutField {
  /** Field name; operand fields share their operand's name (rd, rs1, imm, csr, vm…). */
  name: string;
  hi: number;
  lo: number;
  /** Label for the bit strip, e.g. "imm[10:5]". Defaults to the name. */
  label?: string;
  immHi?: number;
  immLo?: number;
}

const F = (name: string, hi: number, lo: number, label?: string, immHi?: number, immLo?: number): LayoutField => ({
  name, hi, lo, label, immHi, immLo,
});

const OPCODE = F("opcode", 6, 0);
const RD = F("rd", 11, 7);
const FUNCT3 = F("funct3", 14, 12);
const RS1 = F("rs1", 19, 15);
const RS2 = F("rs2", 24, 20);
const FUNCT7 = F("funct7", 31, 25);

export type LayoutId =
  | "R" | "R4" | "I" | "ISH" | "IFIX" | "S" | "B" | "U" | "J" | "CSR" | "CSRI" | "AMO" | "FENCE"
  | "OPVV" | "OPVX" | "OPVI" | "OPVIU" | "VL" | "VLS" | "VS" | "VSS" | "VSETVLI" | "VSETIVLI" | "VSETVL";

export const LAYOUTS: Record<LayoutId, LayoutField[]> = {
  R: [FUNCT7, RS2, RS1, FUNCT3, RD, OPCODE],
  // Fused multiply-add: rs3 lives in the funct7 slot; funct3 is the rounding mode.
  R4: [F("rs3", 31, 27), F("funct2", 26, 25, "fmt"), RS2, RS1, F("funct3", 14, 12, "rm"), RD, OPCODE],
  I: [F("imm", 31, 20, "imm[11:0]", 11, 0), RS1, FUNCT3, RD, OPCODE],
  ISH: [F("funct7", 31, 25, "imm[11:5]"), F("shamt", 24, 20), RS1, FUNCT3, RD, OPCODE],
  /** I-type whose whole immediate is a fixed sub-opcode (clz, rev8, ecall…). */
  IFIX: [F("funct12", 31, 20), RS1, FUNCT3, RD, OPCODE],
  S: [F("imm", 31, 25, "imm[11:5]", 11, 5), RS2, RS1, FUNCT3, F("imm", 11, 7, "imm[4:0]", 4, 0), OPCODE],
  B: [
    F("imm", 31, 31, "imm[12]", 12, 12), F("imm", 30, 25, "imm[10:5]", 10, 5), RS2, RS1, FUNCT3,
    F("imm", 11, 8, "imm[4:1]", 4, 1), F("imm", 7, 7, "imm[11]", 11, 11), OPCODE,
  ],
  U: [F("imm", 31, 12, "imm[31:12]", 31, 12), RD, OPCODE],
  J: [
    F("imm", 31, 31, "imm[20]", 20, 20), F("imm", 30, 21, "imm[10:1]", 10, 1), F("imm", 20, 20, "imm[11]", 11, 11),
    F("imm", 19, 12, "imm[19:12]", 19, 12), RD, OPCODE,
  ],
  CSR: [F("csr", 31, 20), RS1, FUNCT3, RD, OPCODE],
  CSRI: [F("csr", 31, 20), F("zimm", 19, 15, "uimm[4:0]"), FUNCT3, RD, OPCODE],
  AMO: [F("funct5", 31, 27), F("aq", 26, 26), F("rl", 25, 25), RS2, RS1, FUNCT3, RD, OPCODE],
  FENCE: [F("fm", 31, 28), F("pred", 27, 24), F("succ", 23, 20), RS1, FUNCT3, RD, OPCODE],
  OPVV: [F("funct6", 31, 26), F("vm", 25, 25), F("vs2", 24, 20), F("vs1", 19, 15), FUNCT3, F("vd", 11, 7), OPCODE],
  OPVX: [F("funct6", 31, 26), F("vm", 25, 25), F("vs2", 24, 20), RS1, FUNCT3, F("vd", 11, 7), OPCODE],
  OPVI: [F("funct6", 31, 26), F("vm", 25, 25), F("vs2", 24, 20), F("simm5", 19, 15, "simm5"), FUNCT3, F("vd", 11, 7), OPCODE],
  OPVIU: [F("funct6", 31, 26), F("vm", 25, 25), F("vs2", 24, 20), F("uimm5", 19, 15, "uimm5"), FUNCT3, F("vd", 11, 7), OPCODE],
  VL: [F("nf", 31, 29), F("mew", 28, 28), F("mop", 27, 26), F("vm", 25, 25), F("lumop", 24, 20), RS1, F("width", 14, 12), F("vd", 11, 7), OPCODE],
  VLS: [F("nf", 31, 29), F("mew", 28, 28), F("mop", 27, 26), F("vm", 25, 25), RS2, RS1, F("width", 14, 12), F("vd", 11, 7), OPCODE],
  VS: [F("nf", 31, 29), F("mew", 28, 28), F("mop", 27, 26), F("vm", 25, 25), F("sumop", 24, 20), RS1, F("width", 14, 12), F("vs3", 11, 7), OPCODE],
  VSS: [F("nf", 31, 29), F("mew", 28, 28), F("mop", 27, 26), F("vm", 25, 25), RS2, RS1, F("width", 14, 12), F("vs3", 11, 7), OPCODE],
  VSETVLI: [F("vbit31", 31, 31, "0"), F("vtypei", 30, 20, "vtypei[10:0]"), RS1, FUNCT3, RD, OPCODE],
  VSETIVLI: [F("vbits", 31, 30, "11"), F("vtypei", 29, 20, "vtypei[9:0]"), F("uimm5", 19, 15, "avl"), FUNCT3, RD, OPCODE],
  VSETVL: [FUNCT7, RS2, RS1, FUNCT3, RD, OPCODE],
};

/** Colour group for each field name, shared by the bit strip and the editor palette. */
export type FieldKind =
  | "opcode" | "rd" | "funct3" | "rs1" | "rs2" | "rs3" | "funct7" | "imm" | "shamt" | "csr" | "rm" | "aqrl" | "vm";

export function fieldKind(name: string): FieldKind {
  switch (name) {
    case "opcode": return "opcode";
    case "rd": case "vd": case "vs3": return "rd";
    case "rs1": case "vs1": return "rs1";
    case "zimm": case "uimm5": case "simm5": return "imm";
    case "rs2": case "vs2": return "rs2";
    case "rs3": return "rs3";
    case "funct3": case "width": return "funct3";
    case "rm": return "rm";
    case "imm": case "vtypei": return "imm";
    case "shamt": return "shamt";
    case "csr": return "csr";
    case "aq": case "rl": return "aqrl";
    case "vm": return "vm";
    default: return "funct7";
  }
}
