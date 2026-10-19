/**
 * Data-driven RV32I + M instruction table.
 *
 * Adding an instruction means adding a row here: the assembler, decoder,
 * executor, encoding visualizer and animation choreography all read from it.
 * Encodings follow riscv-opcodes (match/mask) and are verified in tests
 * against words produced by GNU as.
 */

export type Format = "R" | "I" | "S" | "B" | "U" | "J";

/** Operand syntax, used by the assembler parser and tooltips. */
export type Syntax =
  | "rd,rs1,rs2"
  | "rd,rs1,imm"
  | "rd,rs1,shamt"
  | "rd,imm(rs1)"
  | "rs2,imm(rs1)"
  | "rs1,rs2,label"
  | "rd,imm20"
  | "rd,label"
  | "fence"
  | "none";

/** Choreography class: every instruction in a class animates the same way. */
export type AnimClass =
  | "R"
  | "I_ALU"
  | "LOAD"
  | "STORE"
  | "BRANCH"
  | "JAL"
  | "JALR"
  | "LUI"
  | "AUIPC"
  | "SYSTEM"
  | "FENCE";

export type AluOp =
  | "ADD" | "SUB" | "SLL" | "SLT" | "SLTU" | "XOR" | "SRL" | "SRA" | "OR" | "AND"
  | "MUL" | "MULH" | "MULHSU" | "MULHU" | "DIV" | "DIVU" | "REM" | "REMU"
  | "PASS_B";

export type BranchOp = "EQ" | "NE" | "LT" | "GE" | "LTU" | "GEU";

export type MemWidth = 1 | 2 | 4;

export interface InstrDef {
  mnemonic: string;
  ext: "I" | "M";
  format: Format;
  opcode: number;
  funct3?: number;
  funct7?: number;
  /** For ECALL/EBREAK the full immediate is fixed. */
  fixedImm?: number;
  match: number;
  mask: number;
  syntax: Syntax;
  animClass: AnimClass;
  aluOp?: AluOp;
  branchOp?: BranchOp;
  memWidth?: MemWidth;
  memUnsigned?: boolean;
  /** Short one-line semantics, e.g. "rd ← rs1 + imm". */
  semantics: string;
  summary: string;
}

export const OPCODES = {
  LUI: 0b0110111,
  AUIPC: 0b0010111,
  JAL: 0b1101111,
  JALR: 0b1100111,
  BRANCH: 0b1100011,
  LOAD: 0b0000011,
  STORE: 0b0100011,
  OP_IMM: 0b0010011,
  OP: 0b0110011,
  MISC_MEM: 0b0001111,
  SYSTEM: 0b1110011,
} as const;

export const OPCODE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(OPCODES).map(([k, v]) => [v, k.replace("_", "-")]),
);

type Row = Omit<InstrDef, "match" | "mask">;

const rows: Row[] = [
  // U-type
  { mnemonic: "lui", ext: "I", format: "U", opcode: OPCODES.LUI, syntax: "rd,imm20", animClass: "LUI", aluOp: "PASS_B",
    semantics: "rd ← imm << 12", summary: "Load upper immediate: place a 20-bit constant in the top bits of rd." },
  { mnemonic: "auipc", ext: "I", format: "U", opcode: OPCODES.AUIPC, syntax: "rd,imm20", animClass: "AUIPC", aluOp: "ADD",
    semantics: "rd ← PC + (imm << 12)", summary: "Add upper immediate to PC: the first half of PC-relative addressing (la, call)." },
  // Jumps
  { mnemonic: "jal", ext: "I", format: "J", opcode: OPCODES.JAL, syntax: "rd,label", animClass: "JAL", aluOp: "ADD",
    semantics: "rd ← PC + 4; PC ← PC + off", summary: "Jump and link: jump PC-relative, saving the return address in rd." },
  { mnemonic: "jalr", ext: "I", format: "I", opcode: OPCODES.JALR, funct3: 0, syntax: "rd,imm(rs1)", animClass: "JALR", aluOp: "ADD",
    semantics: "rd ← PC + 4; PC ← (rs1 + imm) & ~1", summary: "Jump and link register: indirect jump used by ret and function pointers." },
  // Branches
  ...([
    ["beq", 0b000, "EQ", "=="], ["bne", 0b001, "NE", "≠"], ["blt", 0b100, "LT", "< (signed)"],
    ["bge", 0b101, "GE", "≥ (signed)"], ["bltu", 0b110, "LTU", "< (unsigned)"], ["bgeu", 0b111, "GEU", "≥ (unsigned)"],
  ] as const).map(([m, f3, op, rel]): Row => ({
    mnemonic: m, ext: "I", format: "B", opcode: OPCODES.BRANCH, funct3: f3, syntax: "rs1,rs2,label", animClass: "BRANCH",
    branchOp: op, aluOp: "ADD", semantics: `if rs1 ${rel} rs2: PC ← PC + off`, summary: `Branch if rs1 ${rel} rs2.`,
  })),
  // Loads
  ...([
    ["lb", 0b000, 1, false], ["lh", 0b001, 2, false], ["lw", 0b010, 4, false],
    ["lbu", 0b100, 1, true], ["lhu", 0b101, 2, true],
  ] as const).map(([m, f3, w, u]): Row => ({
    mnemonic: m, ext: "I", format: "I", opcode: OPCODES.LOAD, funct3: f3, syntax: "rd,imm(rs1)", animClass: "LOAD", aluOp: "ADD",
    memWidth: w, memUnsigned: u,
    semantics: `rd ← ${w === 4 ? "" : u ? "zext" : "sext"}(M${w * 8}[rs1 + imm])`,
    summary: `Load ${w === 1 ? "a byte" : w === 2 ? "a halfword" : "a word"}${w < 4 ? (u ? ", zero-extended" : ", sign-extended") : ""}.`,
  })),
  // Stores
  ...([["sb", 0b000, 1], ["sh", 0b001, 2], ["sw", 0b010, 4]] as const).map(([m, f3, w]): Row => ({
    mnemonic: m, ext: "I", format: "S", opcode: OPCODES.STORE, funct3: f3, syntax: "rs2,imm(rs1)", animClass: "STORE", aluOp: "ADD",
    memWidth: w, semantics: `M${w * 8}[rs1 + imm] ← rs2${w < 4 ? `[${w * 8 - 1}:0]` : ""}`,
    summary: `Store the low ${w * 8} bits of rs2 to memory.`,
  })),
  // OP-IMM
  ...([
    ["addi", 0b000, "ADD", "rs1 + imm"], ["slti", 0b010, "SLT", "(rs1 <s imm) ? 1 : 0"],
    ["sltiu", 0b011, "SLTU", "(rs1 <u imm) ? 1 : 0"], ["xori", 0b100, "XOR", "rs1 ^ imm"],
    ["ori", 0b110, "OR", "rs1 | imm"], ["andi", 0b111, "AND", "rs1 & imm"],
  ] as const).map(([m, f3, op, sem]): Row => ({
    mnemonic: m, ext: "I", format: "I", opcode: OPCODES.OP_IMM, funct3: f3, syntax: "rd,rs1,imm", animClass: "I_ALU", aluOp: op,
    semantics: `rd ← ${sem}`, summary: `Register–immediate ${op.toLowerCase()} with a 12-bit sign-extended immediate.`,
  })),
  ...([
    ["slli", 0b001, 0b0000000, "SLL", "rs1 << shamt"], ["srli", 0b101, 0b0000000, "SRL", "rs1 >>u shamt"],
    ["srai", 0b101, 0b0100000, "SRA", "rs1 >>s shamt"],
  ] as const).map(([m, f3, f7, op, sem]): Row => ({
    mnemonic: m, ext: "I", format: "I", opcode: OPCODES.OP_IMM, funct3: f3, funct7: f7, syntax: "rd,rs1,shamt", animClass: "I_ALU",
    aluOp: op, semantics: `rd ← ${sem}`, summary: "Shift by a 5-bit immediate; imm[11:5] acts as funct7.",
  })),
  // OP
  ...([
    ["add", 0b000, 0b0000000, "ADD", "rs1 + rs2"], ["sub", 0b000, 0b0100000, "SUB", "rs1 − rs2"],
    ["sll", 0b001, 0b0000000, "SLL", "rs1 << rs2[4:0]"], ["slt", 0b010, 0b0000000, "SLT", "(rs1 <s rs2) ? 1 : 0"],
    ["sltu", 0b011, 0b0000000, "SLTU", "(rs1 <u rs2) ? 1 : 0"], ["xor", 0b100, 0b0000000, "XOR", "rs1 ^ rs2"],
    ["srl", 0b101, 0b0000000, "SRL", "rs1 >>u rs2[4:0]"], ["sra", 0b101, 0b0100000, "SRA", "rs1 >>s rs2[4:0]"],
    ["or", 0b110, 0b0000000, "OR", "rs1 | rs2"], ["and", 0b111, 0b0000000, "AND", "rs1 & rs2"],
  ] as const).map(([m, f3, f7, op, sem]): Row => ({
    mnemonic: m, ext: "I", format: "R", opcode: OPCODES.OP, funct3: f3, funct7: f7, syntax: "rd,rs1,rs2", animClass: "R", aluOp: op,
    semantics: `rd ← ${sem}`, summary: `Register–register ${op.toLowerCase()}.`,
  })),
  // M extension
  ...([
    ["mul", 0b000, "MUL", "low 32 bits of rs1 × rs2"], ["mulh", 0b001, "MULH", "high 32 bits of signed × signed"],
    ["mulhsu", 0b010, "MULHSU", "high 32 bits of signed × unsigned"], ["mulhu", 0b011, "MULHU", "high 32 bits of unsigned × unsigned"],
    ["div", 0b100, "DIV", "rs1 ÷ rs2 (signed)"], ["divu", 0b101, "DIVU", "rs1 ÷ rs2 (unsigned)"],
    ["rem", 0b110, "REM", "rs1 mod rs2 (signed)"], ["remu", 0b111, "REMU", "rs1 mod rs2 (unsigned)"],
  ] as const).map(([m, f3, op, sem]): Row => ({
    mnemonic: m, ext: "M", format: "R", opcode: OPCODES.OP, funct3: f3, funct7: 0b0000001, syntax: "rd,rs1,rs2", animClass: "R",
    aluOp: op, semantics: `rd ← ${sem}`,
    summary: op.startsWith("DIV") || op.startsWith("REM")
      ? "Division never traps: x/0 gives −1 (quotient) or x (remainder)."
      : "Multiply (M extension).",
  })),
  // MISC-MEM / SYSTEM
  { mnemonic: "fence", ext: "I", format: "I", opcode: OPCODES.MISC_MEM, funct3: 0, syntax: "fence", animClass: "FENCE",
    semantics: "order memory accesses", summary: "Memory-ordering fence. A no-op on this single-hart, in-order core." },
  { mnemonic: "ecall", ext: "I", format: "I", opcode: OPCODES.SYSTEM, funct3: 0, fixedImm: 0, syntax: "none", animClass: "SYSTEM",
    semantics: "environment call (a7 = service)", summary: "Ask the environment for a service. Here: a7 picks a simulator syscall." },
  { mnemonic: "ebreak", ext: "I", format: "I", opcode: OPCODES.SYSTEM, funct3: 0, fixedImm: 1, syntax: "none", animClass: "SYSTEM",
    semantics: "breakpoint", summary: "Breakpoint: stops the simulation." },
];

function matchMask(r: Row): { match: number; mask: number } {
  let match = r.opcode;
  let mask = 0x7f;
  if (r.fixedImm !== undefined) {
    // ECALL/EBREAK: every bit is fixed.
    return { match: ((r.fixedImm << 20) | (r.funct3! << 12) | r.opcode) >>> 0, mask: 0xffffffff };
  }
  if (r.funct3 !== undefined) {
    match |= r.funct3 << 12;
    mask |= 0x7 << 12;
  }
  if (r.funct7 !== undefined) {
    match |= r.funct7 << 25;
    mask |= 0x7f << 25;
  }
  return { match: match >>> 0, mask: mask >>> 0 };
}

export const INSTRUCTIONS: InstrDef[] = rows.map((r) => ({ ...r, ...matchMask(r) }));

export const BY_MNEMONIC = new Map(INSTRUCTIONS.map((d) => [d.mnemonic, d]));

/** Find the instruction definition for a 32-bit word, or undefined if illegal. */
export function lookup(word: number): InstrDef | undefined {
  const w = word >>> 0;
  for (const d of INSTRUCTIONS) {
    if (((w & d.mask) >>> 0) === d.match) return d;
  }
  return undefined;
}
