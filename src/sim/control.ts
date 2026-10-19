import type { AnimClass, Format, InstrDef } from "@/isa/instructions";

/**
 * The single-cycle control vector — "a classic textbook implementation"
 * (signal names follow the app's RV32I table, close to Harris & Harris).
 */
export interface Control {
  RegWrite: boolean;
  ImmSel: Format | null;
  ALUSrcA: "rs1" | "pc" | "zero" | null;
  ALUSrcB: "rs2" | "imm" | null;
  ALUOp: string | null;
  MemRead: boolean;
  MemWrite: boolean;
  WBSel: "alu" | "mem" | "pc4" | "csr" | "fpu" | null;
  /** Static PC source; branches resolve at run time. */
  PCSel: "pc4" | "branch" | "jal" | "jalr" | "trap" | "xret";
  Branch: boolean;
  /** Writes the FP register file. */
  FPWrite: boolean;
}

const C = (c: Partial<Control>): Control => ({
  RegWrite: false, ImmSel: null, ALUSrcA: null, ALUSrcB: null, ALUOp: null,
  MemRead: false, MemWrite: false, WBSel: null, PCSel: "pc4", Branch: false, FPWrite: false, ...c,
});

const BY_CLASS: Record<AnimClass, (d: InstrDef) => Control> = {
  R: (d) => C({ RegWrite: true, ALUSrcA: "rs1", ALUSrcB: "rs2", ALUOp: d.aluOp!, WBSel: "alu" }),
  I_ALU: (d) => C({ RegWrite: true, ImmSel: "I", ALUSrcA: "rs1", ALUSrcB: "imm", ALUOp: d.aluOp!, WBSel: "alu" }),
  LOAD: () => C({ RegWrite: true, ImmSel: "I", ALUSrcA: "rs1", ALUSrcB: "imm", ALUOp: "ADD", MemRead: true, WBSel: "mem" }),
  STORE: () => C({ ImmSel: "S", ALUSrcA: "rs1", ALUSrcB: "imm", ALUOp: "ADD", MemWrite: true }),
  // Branches compare rs1/rs2 in the comparator; the target adder computes PC + imm.
  BRANCH: (d) => C({ ImmSel: "B", ALUOp: `CMP.${d.branchOp}`, PCSel: "branch", Branch: true }),
  // jal's target also comes from the target adder; the ALU sits idle.
  JAL: () => C({ RegWrite: true, ImmSel: "J", WBSel: "pc4", PCSel: "jal" }),
  JALR: () => C({ RegWrite: true, ImmSel: "I", ALUSrcA: "rs1", ALUSrcB: "imm", ALUOp: "ADD", WBSel: "pc4", PCSel: "jalr" }),
  LUI: () => C({ RegWrite: true, ImmSel: "U", ALUSrcA: "zero", ALUSrcB: "imm", ALUOp: "ADD", WBSel: "alu" }),
  AUIPC: () => C({ RegWrite: true, ImmSel: "U", ALUSrcA: "pc", ALUSrcB: "imm", ALUOp: "ADD", WBSel: "alu" }),
  SYSTEM: () => C({ PCSel: "trap" }),
  FENCE: () => C({}),
  CSR: () => C({ RegWrite: true, ALUSrcA: "rs1", ALUOp: "CSR", WBSel: "csr" }),
  PRIV: (d) => C({ PCSel: d.op === "mret" || d.op === "sret" ? "xret" : "pc4" }),
  AMO: (d) => C({ RegWrite: true, ALUSrcA: "rs1", ALUOp: `AMO.${d.op}`, MemRead: true, MemWrite: true, WBSel: "mem" }),
  LR: () => C({ RegWrite: true, ALUSrcA: "rs1", ALUOp: "ADD", MemRead: true, WBSel: "mem" }),
  SC: () => C({ RegWrite: true, ALUSrcA: "rs1", ALUOp: "ADD", MemWrite: true, WBSel: "mem" }),
  FP_LOAD: () => C({ ImmSel: "I", ALUSrcA: "rs1", ALUSrcB: "imm", ALUOp: "ADD", MemRead: true, WBSel: "mem", FPWrite: true }),
  FP_STORE: () => C({ ImmSel: "S", ALUSrcA: "rs1", ALUSrcB: "imm", ALUOp: "ADD", MemWrite: true }),
  FP_OP: (d) => C({ ALUOp: `FPU.${d.op}`, FPWrite: true }),
  FP_FMA: (d) => C({ ALUOp: `FPU.${d.mnemonic.split(".")[0].toUpperCase()}`, FPWrite: true }),
  FP_CMP: (d) => C({ RegWrite: true, ALUOp: `FPU.${d.op}`, WBSel: "fpu" }),
  FP_TO_INT: (d) => C({ RegWrite: true, ALUOp: `FPU.${d.op}`, WBSel: "fpu" }),
  INT_TO_FP: (d) => C({ ALUOp: `FPU.${d.op}`, FPWrite: true }),
  VSET: () => C({ RegWrite: true, ALUOp: "VSET", WBSel: "alu" }),
  V_LOAD: () => C({ ALUOp: "VLSU", MemRead: true }),
  V_STORE: () => C({ ALUOp: "VLSU", MemWrite: true }),
  V_ARITH: (d) => C({ ALUOp: `VEC.${d.op}`, RegWrite: d.syntax.startsWith("rd") }),
};

export function controlFor(def: InstrDef): Control {
  return BY_CLASS[def.animClass](def);
}

/** Ordered list of the signals shown in the Control panel. */
export const CONTROL_SIGNALS: (keyof Control)[] = [
  "RegWrite", "ImmSel", "ALUSrcA", "ALUSrcB", "ALUOp", "MemRead", "MemWrite", "WBSel", "PCSel", "Branch", "FPWrite",
];

export const CONTROL_HELP: Record<keyof Control, string> = {
  RegWrite: "Enables the register file write port at the end of the cycle.",
  ImmSel: "Which instruction format the immediate generator decodes (I, S, B, U, J).",
  ALUSrcA: "First ALU operand: rs1, the PC (auipc, jal) or zero (lui).",
  ALUSrcB: "Second ALU operand: rs2 or the sign-extended immediate.",
  ALUOp: "Operation the ALU (or branch comparator) performs.",
  MemRead: "Data memory read enable (loads).",
  MemWrite: "Data memory write enable (stores).",
  WBSel: "What is written back to rd: ALU result, loaded data, PC+4, a CSR value or an FPU result.",
  PCSel: "Where the next PC comes from: PC+4, branch target, jump target, trap vector or mepc/sepc (xret).",
  Branch: "The comparator decides whether the branch is taken.",
  FPWrite: "Enables the FP register file write port (F/D instructions).",
};
