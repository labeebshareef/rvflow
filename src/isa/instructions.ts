/**
 * Data-driven instruction table: RV32I, M, A, F, D, Zicsr, Zifencei, the
 * privileged instructions, B (Zba/Zbb/Zbc/Zbs) and a teaching subset of V.
 * C instructions are 16-bit and live in rvc.ts; they expand to rows here.
 *
 * Adding an instruction means adding a row: the assembler, decoder, executor,
 * encoding view and animation all read from it. match/mask are derived from
 * the fixed fields and are checked in tests against llvm-mc encodings.
 */
import { LAYOUTS, type LayoutField, type LayoutId } from "./layouts";

/** Coarse format shown in the UI ("I-type"). */
export type Format = "R" | "R4" | "I" | "S" | "B" | "U" | "J" | "V";

export type Ext = "I" | "M" | "A" | "F" | "D" | "Zicsr" | "Zifencei" | "Priv" | "Zba" | "Zbb" | "Zbc" | "Zbs" | "V";

/** Choreography class: every instruction in a class animates the same way. */
export type AnimClass =
  | "R" | "I_ALU" | "LOAD" | "STORE" | "BRANCH" | "JAL" | "JALR" | "LUI" | "AUIPC" | "SYSTEM" | "FENCE"
  | "CSR" | "PRIV" | "AMO" | "LR" | "SC"
  | "FP_LOAD" | "FP_STORE" | "FP_OP" | "FP_FMA" | "FP_CMP" | "FP_TO_INT" | "INT_TO_FP"
  | "VSET" | "V_LOAD" | "V_STORE" | "V_ARITH";

export type AluOp =
  | "ADD" | "SUB" | "SLL" | "SLT" | "SLTU" | "XOR" | "SRL" | "SRA" | "OR" | "AND"
  | "MUL" | "MULH" | "MULHSU" | "MULHU" | "DIV" | "DIVU" | "REM" | "REMU"
  | "ANDN" | "ORN" | "XNOR" | "CLZ" | "CTZ" | "CPOP" | "MAX" | "MAXU" | "MIN" | "MINU"
  | "SEXTB" | "SEXTH" | "ZEXTH" | "ROL" | "ROR" | "ORCB" | "REV8"
  | "SH1ADD" | "SH2ADD" | "SH3ADD" | "BCLR" | "BEXT" | "BINV" | "BSET" | "CLMUL" | "CLMULH" | "CLMULR"
  | "PASS_B";

export type BranchOp = "EQ" | "NE" | "LT" | "GE" | "LTU" | "GEU";
export type MemWidth = 1 | 2 | 4 | 8;

export interface InstrDef {
  mnemonic: string;
  ext: Ext;
  format: Format;
  layout: LayoutId;
  /** Values of the fields that identify the instruction. */
  fixed: Record<string, number>;
  /**
   * Assembly operands, comma separated. Register tokens: rd rs1 rs2 rs3 (x),
   * fd fs1 fs2 fs3 (f), vd vs1 vs2 vs3 (v). Others: imm, mem (imm(rs1)),
   * memS, (rs1), offB, offJ, uimm20, shamt, csr, zimm, simm5, uimm5, vtypei, pred, succ,
   * v0 (literal). A trailing "?" marks an optional operand (rm?, vm?).
   */
  syntax: string;
  animClass: AnimClass;
  aluOp?: AluOp;
  branchOp?: BranchOp;
  memWidth?: MemWidth;
  memUnsigned?: boolean;
  /** Rounding mode used when the rm operand is omitted (7 = dynamic). */
  defaultRm?: number;
  /** FP format of the operation, or "S→D" style for conversions. */
  fp?: "S" | "D";
  /** Free-form sub-operation for FP/AMO/vector/privileged rows. */
  op?: string;
  match: number;
  mask: number;
  semantics: string;
  summary: string;
}

export const OPCODES = {
  LOAD: 0x03, LOAD_FP: 0x07, MISC_MEM: 0x0f, OP_IMM: 0x13, AUIPC: 0x17, STORE: 0x23, STORE_FP: 0x27,
  AMO: 0x2f, OP: 0x33, LUI: 0x37, MADD: 0x43, MSUB: 0x47, NMSUB: 0x4b, NMADD: 0x4f, OP_FP: 0x53,
  OP_V: 0x57, BRANCH: 0x63, JALR: 0x67, JAL: 0x6f, SYSTEM: 0x73,
} as const;

export const OPCODE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(OPCODES).map(([k, v]) => [v, k.replace("_", "-")]),
);

type Row = Omit<InstrDef, "match" | "mask">;

const LAYOUT_FORMAT: Record<LayoutId, Format> = {
  R: "R", R4: "R4", I: "I", ISH: "I", IFIX: "I", S: "S", B: "B", U: "U", J: "J", CSR: "I", CSRI: "I", AMO: "R",
  FENCE: "I", OPVV: "V", OPVX: "V", OPVI: "V", OPVIU: "V", VL: "V", VLS: "V", VS: "V", VSS: "V",
  VSETVLI: "V", VSETIVLI: "V", VSETVL: "V",
};

function row(
  mnemonic: string, ext: Ext, layout: LayoutId, fixed: Record<string, number>, syntax: string, animClass: AnimClass,
  semantics: string, summary: string, extra: Partial<Row> = {},
): Row {
  return { mnemonic, ext, layout, format: LAYOUT_FORMAT[layout], fixed, syntax, animClass, semantics, summary, ...extra };
}

const O = OPCODES;
const rows: Row[] = [];
const add = (...r: Row[]) => rows.push(...r);

// ───────────── RV32I ─────────────
add(
  row("lui", "I", "U", { opcode: O.LUI }, "rd,uimm20", "LUI", "rd ← imm << 12",
    "Load upper immediate: place a 20-bit constant in the top bits of rd.", { aluOp: "PASS_B" }),
  row("auipc", "I", "U", { opcode: O.AUIPC }, "rd,uimm20", "AUIPC", "rd ← PC + (imm << 12)",
    "Add upper immediate to PC: the first half of PC-relative addressing (la, call).", { aluOp: "ADD" }),
  row("jal", "I", "J", { opcode: O.JAL }, "rd,offJ", "JAL", "rd ← PC + 4; PC ← PC + off",
    "Jump and link: jump PC-relative, saving the return address in rd.", { aluOp: "ADD" }),
  row("jalr", "I", "I", { opcode: O.JALR, funct3: 0 }, "rd,mem", "JALR", "rd ← PC + 4; PC ← (rs1 + imm) & ~1",
    "Jump and link register: indirect jump used by ret and function pointers.", { aluOp: "ADD" }),
);
for (const [m, f3, op, rel] of [
  ["beq", 0, "EQ", "=="], ["bne", 1, "NE", "≠"], ["blt", 4, "LT", "< (signed)"],
  ["bge", 5, "GE", "≥ (signed)"], ["bltu", 6, "LTU", "< (unsigned)"], ["bgeu", 7, "GEU", "≥ (unsigned)"],
] as const) {
  add(row(m, "I", "B", { opcode: O.BRANCH, funct3: f3 }, "rs1,rs2,offB", "BRANCH", `if rs1 ${rel} rs2: PC ← PC + off`,
    `Branch if rs1 ${rel} rs2.`, { branchOp: op, aluOp: "ADD" }));
}
for (const [m, f3, w, u] of [["lb", 0, 1, false], ["lh", 1, 2, false], ["lw", 2, 4, false], ["lbu", 4, 1, true], ["lhu", 5, 2, true]] as const) {
  add(row(m, "I", "I", { opcode: O.LOAD, funct3: f3 }, "rd,mem", "LOAD",
    `rd ← ${w === 4 ? "" : u ? "zext" : "sext"}(M${w * 8}[rs1 + imm])`,
    `Load ${w === 1 ? "a byte" : w === 2 ? "a halfword" : "a word"}${w < 4 ? (u ? ", zero-extended" : ", sign-extended") : ""}.`,
    { aluOp: "ADD", memWidth: w, memUnsigned: u }));
}
for (const [m, f3, w] of [["sb", 0, 1], ["sh", 1, 2], ["sw", 2, 4]] as const) {
  add(row(m, "I", "S", { opcode: O.STORE, funct3: f3 }, "rs2,memS", "STORE", `M${w * 8}[rs1 + imm] ← rs2${w < 4 ? `[${w * 8 - 1}:0]` : ""}`,
    `Store the low ${w * 8} bits of rs2 to memory.`, { aluOp: "ADD", memWidth: w }));
}
for (const [m, f3, op, sem] of [
  ["addi", 0, "ADD", "rs1 + imm"], ["slti", 2, "SLT", "(rs1 <s imm) ? 1 : 0"], ["sltiu", 3, "SLTU", "(rs1 <u imm) ? 1 : 0"],
  ["xori", 4, "XOR", "rs1 ^ imm"], ["ori", 6, "OR", "rs1 | imm"], ["andi", 7, "AND", "rs1 & imm"],
] as const) {
  add(row(m, "I", "I", { opcode: O.OP_IMM, funct3: f3 }, "rd,rs1,imm", "I_ALU", `rd ← ${sem}`,
    `Register–immediate ${op.toLowerCase()} with a 12-bit sign-extended immediate.`, { aluOp: op }));
}
const shiftI = (m: string, ext: Ext, f3: number, f7: number, op: AluOp, sem: string, summary: string) =>
  row(m, ext, "ISH", { opcode: O.OP_IMM, funct3: f3, funct7: f7 }, "rd,rs1,shamt", "I_ALU", `rd ← ${sem}`, summary, { aluOp: op });
add(
  shiftI("slli", "I", 1, 0x00, "SLL", "rs1 << shamt", "Shift left by a 5-bit immediate; imm[11:5] acts as funct7."),
  shiftI("srli", "I", 5, 0x00, "SRL", "rs1 >>u shamt", "Logical shift right by a 5-bit immediate."),
  shiftI("srai", "I", 5, 0x20, "SRA", "rs1 >>s shamt", "Arithmetic shift right: imm[11:5] = 0100000 selects it."),
);
const rr = (m: string, ext: Ext, f3: number, f7: number, op: AluOp, sem: string, summary?: string) =>
  row(m, ext, "R", { opcode: O.OP, funct3: f3, funct7: f7 }, "rd,rs1,rs2", "R", `rd ← ${sem}`, summary ?? `Register–register ${op.toLowerCase()}.`, { aluOp: op });
add(
  rr("add", "I", 0, 0x00, "ADD", "rs1 + rs2"), rr("sub", "I", 0, 0x20, "SUB", "rs1 − rs2"),
  rr("sll", "I", 1, 0x00, "SLL", "rs1 << rs2[4:0]"), rr("slt", "I", 2, 0x00, "SLT", "(rs1 <s rs2) ? 1 : 0"),
  rr("sltu", "I", 3, 0x00, "SLTU", "(rs1 <u rs2) ? 1 : 0"), rr("xor", "I", 4, 0x00, "XOR", "rs1 ^ rs2"),
  rr("srl", "I", 5, 0x00, "SRL", "rs1 >>u rs2[4:0]"), rr("sra", "I", 5, 0x20, "SRA", "rs1 >>s rs2[4:0]"),
  rr("or", "I", 6, 0x00, "OR", "rs1 | rs2"), rr("and", "I", 7, 0x00, "AND", "rs1 & rs2"),
);
add(
  row("fence", "I", "FENCE", { opcode: O.MISC_MEM, funct3: 0 }, "pred,succ", "FENCE", "order memory accesses",
    "Memory-ordering fence. A no-op on this single-hart, in-order core."),
  row("ecall", "I", "IFIX", { opcode: O.SYSTEM, funct3: 0, funct12: 0, rs1: 0, rd: 0 }, "", "SYSTEM", "environment call",
    "Trap to the execution environment. Without a trap handler (mtvec = 0) the simulator provides RARS-style services."),
  row("ebreak", "I", "IFIX", { opcode: O.SYSTEM, funct3: 0, funct12: 1, rs1: 0, rd: 0 }, "", "SYSTEM", "breakpoint",
    "Breakpoint exception (cause 3). Without a handler it stops the simulation."),
);

// ───────────── M ─────────────
for (const [m, f3, op, sem] of [
  ["mul", 0, "MUL", "low 32 bits of rs1 × rs2"], ["mulh", 1, "MULH", "high 32 bits of signed × signed"],
  ["mulhsu", 2, "MULHSU", "high 32 bits of signed × unsigned"], ["mulhu", 3, "MULHU", "high 32 bits of unsigned × unsigned"],
  ["div", 4, "DIV", "rs1 ÷ rs2 (signed)"], ["divu", 5, "DIVU", "rs1 ÷ rs2 (unsigned)"],
  ["rem", 6, "REM", "rs1 mod rs2 (signed)"], ["remu", 7, "REMU", "rs1 mod rs2 (unsigned)"],
] as const) {
  add(rr(m, "M", f3, 0x01, op, sem, op.startsWith("DIV") || op.startsWith("REM")
    ? "Division never traps: x/0 gives −1 (quotient) or x (remainder)." : "Multiply (M extension)."));
}

// ───────────── Zicsr, Zifencei, privileged ─────────────
for (const [m, f3, sem] of [["csrrw", 1, "t ← csr; csr ← rs1; rd ← t"], ["csrrs", 2, "t ← csr; csr ← t | rs1; rd ← t"], ["csrrc", 3, "t ← csr; csr ← t & ~rs1; rd ← t"]] as const) {
  add(row(m, "Zicsr", "CSR", { opcode: O.SYSTEM, funct3: f3 }, "rd,csr,rs1", "CSR", sem,
    "Atomic read-modify-write of a control and status register.", { op: m.slice(3, 5).toUpperCase() }));
}
for (const [m, f3, sem] of [["csrrwi", 5, "t ← csr; csr ← uimm; rd ← t"], ["csrrsi", 6, "t ← csr; csr ← t | uimm; rd ← t"], ["csrrci", 7, "t ← csr; csr ← t & ~uimm; rd ← t"]] as const) {
  add(row(m, "Zicsr", "CSRI", { opcode: O.SYSTEM, funct3: f3 }, "rd,csr,zimm", "CSR", sem,
    "CSR read-modify-write with a 5-bit zero-extended immediate.", { op: m.slice(3, 5).toUpperCase() }));
}
add(
  row("fence.i", "Zifencei", "I", { opcode: O.MISC_MEM, funct3: 1 }, "", "FENCE", "synchronise instruction fetch",
    "Makes earlier stores visible to instruction fetch (self-modifying code)."),
  row("mret", "Priv", "IFIX", { opcode: O.SYSTEM, funct3: 0, funct12: 0x302, rs1: 0, rd: 0 }, "", "PRIV",
    "mode ← MPP; MIE ← MPIE; PC ← mepc", "Return from a machine-mode trap handler.", { op: "mret" }),
  row("sret", "Priv", "IFIX", { opcode: O.SYSTEM, funct3: 0, funct12: 0x102, rs1: 0, rd: 0 }, "", "PRIV",
    "mode ← SPP; SIE ← SPIE; PC ← sepc", "Return from a supervisor-mode trap handler.", { op: "sret" }),
  row("wfi", "Priv", "IFIX", { opcode: O.SYSTEM, funct3: 0, funct12: 0x105, rs1: 0, rd: 0 }, "", "PRIV",
    "wait for interrupt", "Hint that the hart may sleep until an interrupt is pending. Here: time skips ahead to the next timer interrupt.", { op: "wfi" }),
  row("sfence.vma", "Priv", "R", { opcode: O.SYSTEM, funct3: 0, funct7: 0x09, rd: 0 }, "rs1?,rs2?", "PRIV",
    "flush address translation caches", "Orders page-table updates. No TLB here (bare mode), so it only checks privilege.", { op: "sfence.vma" }),
);

// ───────────── A ─────────────
const amo = (m: string, f5: number, sem: string, op: string) =>
  row(m, "A", "AMO", { opcode: O.AMO, funct3: 2, funct5: f5 }, "rd,rs2,(rs1)", "AMO", sem,
    "Atomic memory operation: read M[rs1] into rd and write back the combined value in one indivisible step.", { op, memWidth: 4 });
add(
  row("lr.w", "A", "AMO", { opcode: O.AMO, funct3: 2, funct5: 0x02, rs2: 0 }, "rd,(rs1)", "LR", "rd ← M32[rs1]; reserve rs1",
    "Load-reserved: load a word and register a reservation on its address.", { memWidth: 4 }),
  row("sc.w", "A", "AMO", { opcode: O.AMO, funct3: 2, funct5: 0x03 }, "rd,rs2,(rs1)", "SC", "if reserved: M32[rs1] ← rs2, rd ← 0 else rd ← 1",
    "Store-conditional: succeeds (rd = 0) only if the reservation from lr.w is still valid.", { memWidth: 4 }),
  amo("amoswap.w", 0x01, "rd ← M[rs1]; M[rs1] ← rs2", "SWAP"),
  amo("amoadd.w", 0x00, "rd ← M[rs1]; M[rs1] ← M[rs1] + rs2", "ADD"),
  amo("amoxor.w", 0x04, "rd ← M[rs1]; M[rs1] ← M[rs1] ^ rs2", "XOR"),
  amo("amoand.w", 0x0c, "rd ← M[rs1]; M[rs1] ← M[rs1] & rs2", "AND"),
  amo("amoor.w", 0x08, "rd ← M[rs1]; M[rs1] ← M[rs1] | rs2", "OR"),
  amo("amomin.w", 0x10, "rd ← M[rs1]; M[rs1] ← min(M[rs1], rs2)", "MIN"),
  amo("amomax.w", 0x14, "rd ← M[rs1]; M[rs1] ← max(M[rs1], rs2)", "MAX"),
  amo("amominu.w", 0x18, "rd ← M[rs1]; M[rs1] ← minu(M[rs1], rs2)", "MINU"),
  amo("amomaxu.w", 0x1c, "rd ← M[rs1]; M[rs1] ← maxu(M[rs1], rs2)", "MAXU"),
);

// ───────────── F and D ─────────────
for (const fp of ["S", "D"] as const) {
  const ext: Ext = fp === "S" ? "F" : "D";
  const s = fp.toLowerCase();
  const fmt = fp === "S" ? 0 : 1;
  const name = fp === "S" ? "single" : "double";
  const f7 = (f5: number) => (f5 << 2) | fmt;
  add(
    row(`fl${fp === "S" ? "w" : "d"}`, ext, "I", { opcode: O.LOAD_FP, funct3: fp === "S" ? 2 : 3 }, "fd,mem", "FP_LOAD",
      `fd ← M${fp === "S" ? 32 : 64}[rs1 + imm]`, `Load a ${name}-precision value into an FP register.`, { fp, memWidth: fp === "S" ? 4 : 8, aluOp: "ADD" }),
    row(`fs${fp === "S" ? "w" : "d"}`, ext, "S", { opcode: O.STORE_FP, funct3: fp === "S" ? 2 : 3 }, "fs2,memS", "FP_STORE",
      `M${fp === "S" ? 32 : 64}[rs1 + imm] ← fs2`, `Store a ${name}-precision FP register.`, { fp, memWidth: fp === "S" ? 4 : 8, aluOp: "ADD" }),
  );
  for (const [m, opc, nP, nA] of [["fmadd", O.MADD, 0, 0], ["fmsub", O.MSUB, 0, 1], ["fnmsub", O.NMSUB, 1, 0], ["fnmadd", O.NMADD, 1, 1]] as const) {
    add(row(`${m}.${s}`, ext, "R4", { opcode: opc, funct2: fmt }, "fd,fs1,fs2,fs3,rm?", "FP_FMA",
      `fd ← ${nP ? "−" : ""}(fs1 × fs2) ${nA ? "−" : "+"} fs3`, "Fused multiply-add: one rounding for the whole expression.",
      { fp, op: `${nP}${nA}`, defaultRm: 7 }));
  }
  for (const [m, f5, sem] of [["fadd", 0, "fs1 + fs2"], ["fsub", 1, "fs1 − fs2"], ["fmul", 2, "fs1 × fs2"], ["fdiv", 3, "fs1 ÷ fs2"]] as const) {
    add(row(`${m}.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(f5) }, "fd,fs1,fs2,rm?", "FP_OP", `fd ← ${sem}`,
      `IEEE-754 ${name}-precision ${m.slice(1)}, rounded by rm.`, { fp, op: m.slice(1).toUpperCase(), defaultRm: 7 }));
  }
  add(
    row(`fsqrt.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x0b), rs2: 0 }, "fd,fs1,rm?", "FP_OP", "fd ← √fs1",
      "Correctly rounded square root.", { fp, op: "SQRT", defaultRm: 7 }),
    row(`fsgnj.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x04), funct3: 0 }, "fd,fs1,fs2", "FP_OP", "fd ← |fs1| with sign of fs2",
      "Sign injection (fmv and fabs/fneg are built from these).", { fp, op: "SGNJ" }),
    row(`fsgnjn.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x04), funct3: 1 }, "fd,fs1,fs2", "FP_OP", "fd ← |fs1| with ¬sign of fs2",
      "Sign injection, negated.", { fp, op: "SGNJN" }),
    row(`fsgnjx.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x04), funct3: 2 }, "fd,fs1,fs2", "FP_OP", "fd ← fs1 with sign(fs1) ^ sign(fs2)",
      "Sign injection, xor.", { fp, op: "SGNJX" }),
    row(`fmin.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x05), funct3: 0 }, "fd,fs1,fs2", "FP_OP", "fd ← min(fs1, fs2)",
      "Minimum; −0 < +0 and a single NaN operand is ignored.", { fp, op: "MIN" }),
    row(`fmax.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x05), funct3: 1 }, "fd,fs1,fs2", "FP_OP", "fd ← max(fs1, fs2)",
      "Maximum; −0 < +0 and a single NaN operand is ignored.", { fp, op: "MAX" }),
    row(`feq.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x14), funct3: 2 }, "rd,fs1,fs2", "FP_CMP", "rd ← fs1 == fs2",
      "Quiet comparison: only signaling NaNs raise invalid.", { fp, op: "EQ" }),
    row(`flt.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x14), funct3: 1 }, "rd,fs1,fs2", "FP_CMP", "rd ← fs1 < fs2",
      "Signaling comparison: any NaN raises invalid.", { fp, op: "LT" }),
    row(`fle.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x14), funct3: 0 }, "rd,fs1,fs2", "FP_CMP", "rd ← fs1 ≤ fs2",
      "Signaling comparison: any NaN raises invalid.", { fp, op: "LE" }),
    row(`fclass.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x1c), funct3: 1, rs2: 0 }, "rd,fs1", "FP_CMP", "rd ← class mask of fs1",
      "One-hot class: −inf, −normal, −subnormal, −0, +0, +subnormal, +normal, +inf, sNaN, qNaN.", { fp, op: "CLASS" }),
    row(`fcvt.w.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x18), rs2: 0 }, "rd,fs1,rm?", "FP_TO_INT", "rd ← int32(fs1)",
      "Convert to signed integer; out-of-range values saturate and raise invalid.", { fp, op: "W", defaultRm: 7 }),
    row(`fcvt.wu.${s}`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x18), rs2: 1 }, "rd,fs1,rm?", "FP_TO_INT", "rd ← uint32(fs1)",
      "Convert to unsigned integer; out-of-range values saturate and raise invalid.", { fp, op: "WU", defaultRm: 7 }),
    row(`fcvt.${s}.w`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x1a), rs2: 0 }, "fd,rs1,rm?", "INT_TO_FP", "fd ← float(int32 rs1)",
      "Convert a signed integer to floating point.", { fp, op: "W", defaultRm: fp === "D" ? 0 : 7 }),
    row(`fcvt.${s}.wu`, ext, "R", { opcode: O.OP_FP, funct7: f7(0x1a), rs2: 1 }, "fd,rs1,rm?", "INT_TO_FP", "fd ← float(uint32 rs1)",
      "Convert an unsigned integer to floating point.", { fp, op: "WU", defaultRm: fp === "D" ? 0 : 7 }),
  );
}
add(
  row("fmv.x.w", "F", "R", { opcode: O.OP_FP, funct7: 0x70, funct3: 0, rs2: 0 }, "rd,fs1", "FP_TO_INT", "rd ← bits of fs1",
    "Move the raw 32 bits of a single-precision register to an integer register.", { fp: "S", op: "MVXW" }),
  row("fmv.w.x", "F", "R", { opcode: O.OP_FP, funct7: 0x78, funct3: 0, rs2: 0 }, "fd,rs1", "INT_TO_FP", "fd ← bits of rs1",
    "Move raw bits from an integer register into a single-precision register (NaN-boxed).", { fp: "S", op: "MVWX" }),
  row("fcvt.s.d", "D", "R", { opcode: O.OP_FP, funct7: 0x20, rs2: 1 }, "fd,fs1,rm?", "FP_OP", "fd ← single(fs1)",
    "Narrow a double to single precision, rounding by rm.", { fp: "S", op: "CVT_S_D", defaultRm: 7 }),
  row("fcvt.d.s", "D", "R", { opcode: O.OP_FP, funct7: 0x21, rs2: 0 }, "fd,fs1,rm?", "FP_OP", "fd ← double(fs1)",
    "Widen a single to double precision (always exact).", { fp: "D", op: "CVT_D_S", defaultRm: 0 }),
);

// ───────────── B: Zba, Zbb, Zbc, Zbs ─────────────
add(
  rr("sh1add", "Zba", 2, 0x10, "SH1ADD", "(rs1 << 1) + rs2", "Address generation: index × 2 + base."),
  rr("sh2add", "Zba", 4, 0x10, "SH2ADD", "(rs1 << 2) + rs2", "Address generation: index × 4 + base (word arrays)."),
  rr("sh3add", "Zba", 6, 0x10, "SH3ADD", "(rs1 << 3) + rs2", "Address generation: index × 8 + base."),
  rr("andn", "Zbb", 7, 0x20, "ANDN", "rs1 & ~rs2"), rr("orn", "Zbb", 6, 0x20, "ORN", "rs1 | ~rs2"),
  rr("xnor", "Zbb", 4, 0x20, "XNOR", "~(rs1 ^ rs2)"),
  rr("max", "Zbb", 6, 0x05, "MAX", "max(rs1, rs2) signed"), rr("maxu", "Zbb", 7, 0x05, "MAXU", "max(rs1, rs2) unsigned"),
  rr("min", "Zbb", 4, 0x05, "MIN", "min(rs1, rs2) signed"), rr("minu", "Zbb", 5, 0x05, "MINU", "min(rs1, rs2) unsigned"),
  rr("rol", "Zbb", 1, 0x30, "ROL", "rs1 rotated left by rs2[4:0]"), rr("ror", "Zbb", 5, 0x30, "ROR", "rs1 rotated right by rs2[4:0]"),
  shiftI("rori", "Zbb", 5, 0x30, "ROR", "rs1 rotated right by shamt", "Rotate right by an immediate."),
  rr("clmul", "Zbc", 1, 0x05, "CLMUL", "low half of carry-less rs1 × rs2", "Carry-less multiply (XOR instead of add): CRCs and GCM."),
  rr("clmulr", "Zbc", 2, 0x05, "CLMULR", "bits 62:31 of carry-less product", "Carry-less multiply, reversed."),
  rr("clmulh", "Zbc", 3, 0x05, "CLMULH", "high half of carry-less product", "Carry-less multiply, high half."),
  rr("bclr", "Zbs", 1, 0x24, "BCLR", "rs1 with bit rs2 cleared"), rr("bext", "Zbs", 5, 0x24, "BEXT", "bit rs2 of rs1"),
  rr("binv", "Zbs", 1, 0x34, "BINV", "rs1 with bit rs2 inverted"), rr("bset", "Zbs", 1, 0x14, "BSET", "rs1 with bit rs2 set"),
  shiftI("bclri", "Zbs", 1, 0x24, "BCLR", "rs1 with bit shamt cleared", "Clear a single bit."),
  shiftI("bexti", "Zbs", 5, 0x24, "BEXT", "bit shamt of rs1", "Extract a single bit."),
  shiftI("binvi", "Zbs", 1, 0x34, "BINV", "rs1 with bit shamt inverted", "Invert a single bit."),
  shiftI("bseti", "Zbs", 1, 0x14, "BSET", "rs1 with bit shamt set", "Set a single bit."),
);
const unary = (m: string, ext: Ext, opcode: number, f3: number, f12: number, op: AluOp, sem: string, summary: string) =>
  row(m, ext, "IFIX", { opcode, funct3: f3, funct12: f12 }, "rd,rs1", "I_ALU", `rd ← ${sem}`, summary, { aluOp: op });
add(
  unary("clz", "Zbb", O.OP_IMM, 1, 0x600, "CLZ", "count leading zeros of rs1", "Count leading zero bits."),
  unary("ctz", "Zbb", O.OP_IMM, 1, 0x601, "CTZ", "count trailing zeros of rs1", "Count trailing zero bits."),
  unary("cpop", "Zbb", O.OP_IMM, 1, 0x602, "CPOP", "number of 1 bits in rs1", "Population count."),
  unary("sext.b", "Zbb", O.OP_IMM, 1, 0x604, "SEXTB", "sext(rs1[7:0])", "Sign-extend the low byte."),
  unary("sext.h", "Zbb", O.OP_IMM, 1, 0x605, "SEXTH", "sext(rs1[15:0])", "Sign-extend the low halfword."),
  unary("orc.b", "Zbb", O.OP_IMM, 5, 0x287, "ORCB", "each byte → 0x00 or 0xFF", "OR-combine bytes: finds zero bytes (fast strlen)."),
  unary("rev8", "Zbb", O.OP_IMM, 5, 0x698, "REV8", "rs1 with bytes reversed", "Byte-reverse: converts between little- and big-endian."),
  unary("zext.h", "Zbb", O.OP, 4, 0x080, "ZEXTH", "zext(rs1[15:0])", "Zero-extend the low halfword."),
);

// ───────────── V (teaching subset; VLEN = 128, ELEN = 32) ─────────────
add(
  row("vsetvli", "V", "VSETVLI", { opcode: O.OP_V, funct3: 7, vbit31: 0 }, "rd,rs1,vtypei", "VSET", "vl ← min(rs1, VLMAX); vtype ← vtypei",
    "Configure the vector unit: element width (SEW), grouping (LMUL) and how many elements to process.", { op: "vsetvli" }),
  row("vsetivli", "V", "VSETIVLI", { opcode: O.OP_V, funct3: 7, vbits: 3 }, "rd,uimm5,vtypei", "VSET", "vl ← min(uimm, VLMAX); vtype ← vtypei",
    "Configure the vector unit with an immediate application vector length.", { op: "vsetivli" }),
  row("vsetvl", "V", "VSETVL", { opcode: O.OP_V, funct3: 7, funct7: 0x40 }, "rd,rs1,rs2", "VSET", "vl ← min(rs1, VLMAX); vtype ← rs2",
    "Configure the vector unit from registers.", { op: "vsetvl" }),
);
for (const [eew, width] of [[8, 0], [16, 5], [32, 6]] as const) {
  const w = (eew / 8) as MemWidth;
  add(
    row(`vle${eew}.v`, "V", "VL", { opcode: O.LOAD_FP, width, nf: 0, mew: 0, mop: 0, lumop: 0 }, "vd,(rs1),vm?", "V_LOAD",
      `vd[i] ← M${eew}[rs1 + i·${w}]`, "Unit-stride vector load: vl consecutive elements.", { memWidth: w, op: "unit" }),
    row(`vlse${eew}.v`, "V", "VLS", { opcode: O.LOAD_FP, width, nf: 0, mew: 0, mop: 2 }, "vd,(rs1),rs2,vm?", "V_LOAD",
      `vd[i] ← M${eew}[rs1 + i·rs2]`, "Strided vector load: elements rs2 bytes apart (e.g. a matrix column).", { memWidth: w, op: "strided" }),
    row(`vse${eew}.v`, "V", "VS", { opcode: O.STORE_FP, width, nf: 0, mew: 0, mop: 0, sumop: 0 }, "vs3,(rs1),vm?", "V_STORE",
      `M${eew}[rs1 + i·${w}] ← vs3[i]`, "Unit-stride vector store.", { memWidth: w, op: "unit" }),
    row(`vsse${eew}.v`, "V", "VSS", { opcode: O.STORE_FP, width, nf: 0, mew: 0, mop: 2 }, "vs3,(rs1),rs2,vm?", "V_STORE",
      `M${eew}[rs1 + i·rs2] ← vs3[i]`, "Strided vector store.", { memWidth: w, op: "strided" }),
  );
}
/** funct3 for each operand category. */
const VF3 = { IVV: 0, MVV: 2, IVI: 3, IVX: 4, MVX: 6 } as const;
type VCat = keyof typeof VF3;
const vop = (base: string, f6: number, cats: VCat[], sem: string, summary: string, op = base.toUpperCase(), uimm = false) => {
  for (const c of cats) {
    const suffix = c.endsWith("VV") ? (base.startsWith("vred") ? "vs" : "vv") : c.endsWith("VX") ? "vx" : "vi";
    const layout: LayoutId = c.endsWith("VV") ? "OPVV" : c.endsWith("VX") ? "OPVX" : uimm ? "OPVIU" : "OPVI";
    const src = c.endsWith("VV") ? "vs1" : c.endsWith("VX") ? "rs1" : uimm ? "uimm5" : "simm5";
    const syntax = base === "vmacc" || base === "vnmsac" ? `vd,${src},vs2,vm?` : `vd,vs2,${src},vm?`;
    add(row(`${base}.${suffix}`, "V", layout, { opcode: O.OP_V, funct3: VF3[c], funct6: f6 }, syntax, "V_ARITH",
      sem.replace("B", src === "vs1" ? "vs1[i]" : src), summary, { op }));
  }
};
vop("vadd", 0x00, ["IVV", "IVX", "IVI"], "vd[i] ← vs2[i] + B", "Element-wise add.");
vop("vsub", 0x02, ["IVV", "IVX"], "vd[i] ← vs2[i] − B", "Element-wise subtract.");
vop("vrsub", 0x03, ["IVX", "IVI"], "vd[i] ← B − vs2[i]", "Reverse subtract.");
vop("vminu", 0x04, ["IVV", "IVX"], "vd[i] ← minu(vs2[i], B)", "Unsigned minimum.");
vop("vmin", 0x05, ["IVV", "IVX"], "vd[i] ← min(vs2[i], B)", "Signed minimum.");
vop("vmaxu", 0x06, ["IVV", "IVX"], "vd[i] ← maxu(vs2[i], B)", "Unsigned maximum.");
vop("vmax", 0x07, ["IVV", "IVX"], "vd[i] ← max(vs2[i], B)", "Signed maximum.");
vop("vand", 0x09, ["IVV", "IVX", "IVI"], "vd[i] ← vs2[i] & B", "Element-wise AND.");
vop("vor", 0x0a, ["IVV", "IVX", "IVI"], "vd[i] ← vs2[i] | B", "Element-wise OR.");
vop("vxor", 0x0b, ["IVV", "IVX", "IVI"], "vd[i] ← vs2[i] ^ B", "Element-wise XOR.");
vop("vslideup", 0x0e, ["IVX", "IVI"], "vd[i + B] ← vs2[i]", "Slide elements up by an offset.", "SLIDEUP", true);
vop("vslidedown", 0x0f, ["IVX", "IVI"], "vd[i] ← vs2[i + B]", "Slide elements down by an offset.", "SLIDEDOWN", true);
vop("vmseq", 0x18, ["IVV", "IVX", "IVI"], "mask[i] ← vs2[i] == B", "Compare equal, producing a mask.", "SEQ");
vop("vmsne", 0x19, ["IVV", "IVX", "IVI"], "mask[i] ← vs2[i] ≠ B", "Compare not equal, producing a mask.", "SNE");
vop("vmsltu", 0x1a, ["IVV", "IVX"], "mask[i] ← vs2[i] <u B", "Unsigned less-than mask.", "SLTU");
vop("vmslt", 0x1b, ["IVV", "IVX"], "mask[i] ← vs2[i] < B", "Signed less-than mask.", "SLT");
vop("vmsleu", 0x1c, ["IVV", "IVX", "IVI"], "mask[i] ← vs2[i] ≤u B", "Unsigned less-or-equal mask.", "SLEU");
vop("vmsle", 0x1d, ["IVV", "IVX", "IVI"], "mask[i] ← vs2[i] ≤ B", "Signed less-or-equal mask.", "SLE");
vop("vmsgtu", 0x1e, ["IVX", "IVI"], "mask[i] ← vs2[i] >u B", "Unsigned greater-than mask.", "SGTU");
vop("vmsgt", 0x1f, ["IVX", "IVI"], "mask[i] ← vs2[i] > B", "Signed greater-than mask.", "SGT");
vop("vsll", 0x25, ["IVV", "IVX", "IVI"], "vd[i] ← vs2[i] << B", "Element-wise shift left.", "SLL", true);
vop("vsrl", 0x28, ["IVV", "IVX", "IVI"], "vd[i] ← vs2[i] >>u B", "Element-wise logical shift right.", "SRL", true);
vop("vsra", 0x29, ["IVV", "IVX", "IVI"], "vd[i] ← vs2[i] >>s B", "Element-wise arithmetic shift right.", "SRA", true);
vop("vmul", 0x25, ["MVV", "MVX"], "vd[i] ← vs2[i] × B", "Element-wise multiply (low bits).");
vop("vmulh", 0x27, ["MVV", "MVX"], "vd[i] ← high(vs2[i] × B)", "Element-wise multiply, high half (signed).");
vop("vmulhu", 0x24, ["MVV", "MVX"], "vd[i] ← highu(vs2[i] × B)", "Element-wise multiply, high half (unsigned).");
vop("vdivu", 0x20, ["MVV", "MVX"], "vd[i] ← vs2[i] ÷u B", "Element-wise unsigned divide.");
vop("vdiv", 0x21, ["MVV", "MVX"], "vd[i] ← vs2[i] ÷ B", "Element-wise signed divide.");
vop("vremu", 0x22, ["MVV", "MVX"], "vd[i] ← vs2[i] modu B", "Element-wise unsigned remainder.");
vop("vrem", 0x23, ["MVV", "MVX"], "vd[i] ← vs2[i] mod B", "Element-wise signed remainder.");
vop("vmacc", 0x2d, ["MVV", "MVX"], "vd[i] ← B × vs2[i] + vd[i]", "Multiply-accumulate: the inner loop of dot products.", "MACC");
vop("vnmsac", 0x2f, ["MVV", "MVX"], "vd[i] ← −(B × vs2[i]) + vd[i]", "Negated multiply-subtract-accumulate.", "NMSAC");
for (const [m, f6] of [["vredsum", 0], ["vredand", 1], ["vredor", 2], ["vredxor", 3], ["vredminu", 4], ["vredmin", 5], ["vredmaxu", 6], ["vredmax", 7]] as const) {
  vop(m, f6, ["MVV"], `vd[0] ← ${m.slice(4)}(vs1[0], vs2[*])`, "Reduction: fold all active elements of vs2 into element 0.", m.slice(4).toUpperCase());
}
add(
  row("vmerge.vvm", "V", "OPVV", { opcode: O.OP_V, funct3: 0, funct6: 0x17, vm: 0 }, "vd,vs2,vs1,v0", "V_ARITH",
    "vd[i] ← v0[i] ? vs1[i] : vs2[i]", "Select per element using the mask in v0.", { op: "MERGE" }),
  row("vmerge.vxm", "V", "OPVX", { opcode: O.OP_V, funct3: 4, funct6: 0x17, vm: 0 }, "vd,vs2,rs1,v0", "V_ARITH",
    "vd[i] ← v0[i] ? rs1 : vs2[i]", "Select per element using the mask in v0.", { op: "MERGE" }),
  row("vmerge.vim", "V", "OPVI", { opcode: O.OP_V, funct3: 3, funct6: 0x17, vm: 0 }, "vd,vs2,simm5,v0", "V_ARITH",
    "vd[i] ← v0[i] ? imm : vs2[i]", "Select per element using the mask in v0.", { op: "MERGE" }),
  row("vmv.v.v", "V", "OPVV", { opcode: O.OP_V, funct3: 0, funct6: 0x17, vm: 1, vs2: 0 }, "vd,vs1", "V_ARITH",
    "vd[i] ← vs1[i]", "Copy a vector.", { op: "MV" }),
  row("vmv.v.x", "V", "OPVX", { opcode: O.OP_V, funct3: 4, funct6: 0x17, vm: 1, vs2: 0 }, "vd,rs1", "V_ARITH",
    "vd[i] ← rs1", "Splat a scalar into every element.", { op: "MV" }),
  row("vmv.v.i", "V", "OPVI", { opcode: O.OP_V, funct3: 3, funct6: 0x17, vm: 1, vs2: 0 }, "vd,simm5", "V_ARITH",
    "vd[i] ← imm", "Splat an immediate into every element.", { op: "MV" }),
  row("vmv.x.s", "V", "OPVV", { opcode: O.OP_V, funct3: 2, funct6: 0x10, vs1: 0, vm: 1 }, "rd,vs2", "V_ARITH",
    "rd ← vs2[0]", "Move element 0 to an integer register (sign-extended).", { op: "MVXS" }),
  row("vmv.s.x", "V", "OPVX", { opcode: O.OP_V, funct3: 6, funct6: 0x10, vs2: 0, vm: 1 }, "vd,rs1", "V_ARITH",
    "vd[0] ← rs1", "Move an integer register into element 0.", { op: "MVSX" }),
  row("vcpop.m", "V", "OPVV", { opcode: O.OP_V, funct3: 2, funct6: 0x10, vs1: 0x10 }, "rd,vs2,vm?", "V_ARITH",
    "rd ← popcount(vs2 mask)", "Count set mask bits among the first vl.", { op: "CPOP" }),
  row("vfirst.m", "V", "OPVV", { opcode: O.OP_V, funct3: 2, funct6: 0x10, vs1: 0x11 }, "rd,vs2,vm?", "V_ARITH",
    "rd ← index of first set mask bit, or −1", "Find the first set mask bit.", { op: "FIRST" }),
  row("vid.v", "V", "OPVV", { opcode: O.OP_V, funct3: 2, funct6: 0x14, vs1: 0x11, vs2: 0 }, "vd,vm?", "V_ARITH",
    "vd[i] ← i", "Write each element's index.", { op: "ID" }),
);
for (const [m, f6] of [["vmandn", 0x18], ["vmand", 0x19], ["vmor", 0x1a], ["vmxor", 0x1b], ["vmorn", 0x1c], ["vmnand", 0x1d], ["vmnor", 0x1e], ["vmxnor", 0x1f]] as const) {
  add(row(`${m}.mm`, "V", "OPVV", { opcode: O.OP_V, funct3: 2, funct6: f6, vm: 1 }, "vd,vs2,vs1", "V_ARITH",
    `vd.mask ← ${m.slice(2)}(vs2.mask, vs1.mask)`, "Logical operation on whole mask registers.", { op: `M${m.slice(2).toUpperCase()}` }));
}

// ───────────── match/mask ─────────────

function matchMask(r: Row): { match: number; mask: number } {
  let match = 0;
  let mask = 0;
  for (const f of LAYOUTS[r.layout]) {
    const v = r.fixed[f.name];
    if (v === undefined) continue;
    const width = f.hi - f.lo + 1;
    const fm = width === 32 ? 0xffffffff : (1 << width) - 1;
    const piece = f.immLo !== undefined ? (v >> f.immLo) & fm : v & fm;
    match |= piece << f.lo;
    mask |= fm << f.lo;
  }
  return { match: match >>> 0, mask: mask >>> 0 };
}

export const INSTRUCTIONS: InstrDef[] = rows.map((r) => ({ ...r, ...matchMask(r) }));

export const BY_MNEMONIC = new Map(INSTRUCTIONS.map((d) => [d.mnemonic, d]));

/** Candidates per opcode, most specific mask first, so overlapping encodings resolve correctly. */
const BY_OPCODE = new Map<number, InstrDef[]>();
for (const d of INSTRUCTIONS) {
  const op = d.match & 0x7f;
  if (!BY_OPCODE.has(op)) BY_OPCODE.set(op, []);
  BY_OPCODE.get(op)!.push(d);
}
const popcount = (x: number) => {
  let n = 0;
  for (let v = x >>> 0; v; v &= v - 1) n++;
  return n;
};
for (const list of BY_OPCODE.values()) list.sort((a, b) => popcount(b.mask) - popcount(a.mask));

/** Find the instruction definition for a 32-bit word, or undefined if illegal. */
export function lookup(word: number): InstrDef | undefined {
  const w = word >>> 0;
  if ((w & 3) !== 3) return undefined;
  for (const d of BY_OPCODE.get(w & 0x7f) ?? []) {
    if (((w & d.mask) >>> 0) === d.match) return d;
  }
  return undefined;
}

export function layoutOf(def: InstrDef): LayoutField[] {
  return LAYOUTS[def.layout];
}

export const EXT_LABEL: Record<Ext, string> = {
  I: "RV32I", M: "M extension", A: "A extension", F: "F extension", D: "D extension", Zicsr: "Zicsr",
  Zifencei: "Zifencei", Priv: "Privileged", Zba: "B: Zba", Zbb: "B: Zbb", Zbc: "B: Zbc", Zbs: "B: Zbs", V: "V extension",
};
