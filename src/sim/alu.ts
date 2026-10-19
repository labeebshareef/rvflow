import type { AluOp, BranchOp } from "@/isa/instructions";

/** 32-bit ALU. Inputs and output are treated as raw 32-bit patterns; output is signed (|0). */
export function alu(op: AluOp, a: number, b: number): number {
  a |= 0;
  b |= 0;
  switch (op) {
    case "ADD": return (a + b) | 0;
    case "SUB": return (a - b) | 0;
    case "SLL": return a << (b & 31);
    case "SLT": return a < b ? 1 : 0;
    case "SLTU": return (a >>> 0) < (b >>> 0) ? 1 : 0;
    case "XOR": return a ^ b;
    case "SRL": return (a >>> (b & 31)) | 0;
    case "SRA": return a >> (b & 31);
    case "OR": return a | b;
    case "AND": return a & b;
    case "PASS_B": return b;
    case "MUL": return Math.imul(a, b);
    case "MULH": return Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 32n));
    case "MULHSU": return Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b >>> 0)) >> 32n));
    case "MULHU": return Number(BigInt.asIntN(32, (BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n));
    case "DIV":
      if (b === 0) return -1;
      if (a === -0x80000000 && b === -1) return a;
      return (a / b) | 0;
    case "DIVU":
      if (b === 0) return -1;
      return ((a >>> 0) / (b >>> 0)) | 0;
    case "REM":
      if (b === 0) return a;
      if (a === -0x80000000 && b === -1) return 0;
      return a % b | 0;
    case "REMU":
      if (b === 0) return a;
      return ((a >>> 0) % (b >>> 0)) | 0;
    case "ANDN": return a & ~b;
    case "ORN": return a | ~b;
    case "XNOR": return ~(a ^ b);
    case "CLZ": return Math.clz32(a);
    case "CTZ": return a === 0 ? 32 : 31 - Math.clz32(a & -a);
    case "CPOP": return popcount(a);
    case "MAX": return a > b ? a : b;
    case "MAXU": return (a >>> 0) > (b >>> 0) ? a : b;
    case "MIN": return a < b ? a : b;
    case "MINU": return (a >>> 0) < (b >>> 0) ? a : b;
    case "SEXTB": return (a << 24) >> 24;
    case "SEXTH": return (a << 16) >> 16;
    case "ZEXTH": return a & 0xffff;
    case "ROL": return (a << (b & 31)) | (a >>> (32 - (b & 31)) & (b & 31 ? -1 : 0));
    case "ROR": return (a >>> (b & 31)) | (b & 31 ? a << (32 - (b & 31)) : 0);
    case "ORCB": {
      let r = 0;
      for (let i = 0; i < 32; i += 8) if ((a >>> i) & 0xff) r |= 0xff << i;
      return r;
    }
    case "REV8": return ((a & 0xff) << 24) | ((a & 0xff00) << 8) | ((a >>> 8) & 0xff00) | (a >>> 24);
    case "SH1ADD": return ((a << 1) + b) | 0;
    case "SH2ADD": return ((a << 2) + b) | 0;
    case "SH3ADD": return ((a << 3) + b) | 0;
    case "BCLR": return a & ~(1 << (b & 31));
    case "BEXT": return (a >>> (b & 31)) & 1;
    case "BINV": return a ^ (1 << (b & 31));
    case "BSET": return a | (1 << (b & 31));
    case "CLMUL": return clmul(a, b, "low");
    case "CLMULH": return clmul(a, b, "high");
    case "CLMULR": return clmul(a, b, "rev");
  }
}

function popcount(x: number): number {
  let n = 0;
  for (let v = x >>> 0; v; v &= v - 1) n++;
  return n;
}

/** Carry-less multiply (Zbc): XOR partial products instead of adding them. */
function clmul(a: number, b: number, part: "low" | "high" | "rev"): number {
  let r = 0;
  for (let i = 0; i < 32; i++) {
    if (!((b >>> i) & 1)) continue;
    if (part === "low") r ^= a << i;
    else if (part === "high") r ^= i === 0 ? 0 : a >>> (32 - i);
    else r ^= a >>> (31 - i);
  }
  return r | 0;
}

/** Symbol used when narrating an ALU operation, e.g. "32 + 10". */
export const ALU_SYMBOL: Record<AluOp, string> = {
  ADD: "+", SUB: "−", SLL: "<<", SLT: "<ₛ", SLTU: "<ᵤ", XOR: "^", SRL: ">>ᵤ", SRA: ">>ₛ", OR: "|", AND: "&",
  ANDN: "&~", ORN: "|~", XNOR: "^~", CLZ: "clz", CTZ: "ctz", CPOP: "cpop", MAX: "max", MAXU: "maxu", MIN: "min",
  MINU: "minu", SEXTB: "sext.b", SEXTH: "sext.h", ZEXTH: "zext.h", ROL: "rol", ROR: "ror", ORCB: "orc.b", REV8: "rev8",
  SH1ADD: "sh1add", SH2ADD: "sh2add", SH3ADD: "sh3add", BCLR: "bclr", BEXT: "bext", BINV: "binv", BSET: "bset",
  CLMUL: "clmul", CLMULH: "clmulh", CLMULR: "clmulr",
  PASS_B: "→", MUL: "×", MULH: "×ʜ", MULHSU: "×ʜsu", MULHU: "×ʜu", DIV: "÷", DIVU: "÷ᵤ", REM: "mod", REMU: "modᵤ",
};

export function compare(op: BranchOp, a: number, b: number): boolean {
  a |= 0;
  b |= 0;
  switch (op) {
    case "EQ": return a === b;
    case "NE": return a !== b;
    case "LT": return a < b;
    case "GE": return a >= b;
    case "LTU": return (a >>> 0) < (b >>> 0);
    case "GEU": return (a >>> 0) >= (b >>> 0);
  }
}

export const BRANCH_SYMBOL: Record<BranchOp, string> = {
  EQ: "==", NE: "≠", LT: "<", GE: "≥", LTU: "<ᵤ", GEU: "≥ᵤ",
};
