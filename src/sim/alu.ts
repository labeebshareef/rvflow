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
  }
}

/** Symbol used when narrating an ALU operation, e.g. "32 + 10". */
export const ALU_SYMBOL: Record<AluOp, string> = {
  ADD: "+", SUB: "−", SLL: "<<", SLT: "<ₛ", SLTU: "<ᵤ", XOR: "^", SRL: ">>ᵤ", SRA: ">>ₛ", OR: "|", AND: "&",
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
