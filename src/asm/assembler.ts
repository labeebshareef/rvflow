import { BY_MNEMONIC, type InstrDef } from "@/isa/instructions";
import { decode, encode, TOKEN_FIELD, type EncodeOperands } from "@/isa/encoding";
import { CSR_BY_NAME } from "@/isa/csr";
import { parseFRegister, parseRegister, parseVRegister } from "@/isa/registers";
import { C_BY_MNEMONIC, CEncodeError, encodeC, expandC, tryCompress, type COperands } from "@/isa/rvc";
import { DATA_BASE, TEXT_BASE } from "@/sim/memmap";
import { disassembleC, formatInstr } from "./disasm";

export interface AsmError {
  line: number; // 1-based
  message: string;
}

export interface TextEntry {
  addr: number;
  /** Machine code: a 32-bit word, or a 16-bit halfword when size = 2. */
  word: number;
  size: 2 | 4;
  /** 1-based source line. */
  line: number;
  /** The real instruction, e.g. "addi t1, t1, 10" (for compressed: the c.* form). */
  asm: string;
  /** Set when this entry came from expanding a pseudo-instruction. */
  pseudo?: { source: string; part: number; of: number };
  /** For compressed entries: the 32-bit instruction it expands to. */
  expanded?: { word: number; asm: string };
}

export interface Program {
  text: TextEntry[];
  textBase: number;
  textEnd: number;
  /** Data segment bytes starting at dataBase. */
  data: number[];
  dataBase: number;
  symbols: Map<string, number>;
  entry: number;
  errors: AsmError[];
  /** Source line → text addresses. */
  lineToAddrs: Map<number, number[]>;
}

class AsmFail extends Error {}
const fail = (msg: string): never => {
  throw new AsmFail(msg);
};

// ───────────────────────── tokenizing ─────────────────────────

interface Stmt {
  line: number;
  labels: string[];
  op?: string; // mnemonic or directive (lowercase)
  args: string[];
  raw: string;
}

function stripComment(s: string): string {
  let inStr = false;
  let inChr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && (inStr || inChr)) {
      i++;
      continue;
    }
    if (c === '"' && !inChr) inStr = !inStr;
    else if (c === "'" && !inStr) inChr = !inChr;
    else if ((c === "#" || (c === "/" && s[i + 1] === "/")) && !inStr && !inChr) return s.slice(0, i);
  }
  return s;
}

/** Split operands on commas that are not inside quotes or parentheses. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === "\\") cur += s[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

function parseLines(src: string): Stmt[] {
  const stmts: Stmt[] = [];
  src.split(/\r?\n/).forEach((rawLine, i) => {
    let s = stripComment(rawLine).trim();
    const labels: string[] = [];
    let m: RegExpMatchArray | null;
    while ((m = s.match(/^([A-Za-z_.$][\w.$]*|\d+)\s*:/))) {
      labels.push(m[1]);
      s = s.slice(m[0].length).trim();
    }
    if (s === "" && labels.length === 0) return;
    const sp = s.search(/\s/);
    const op = s === "" ? undefined : (sp < 0 ? s : s.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? "" : s.slice(sp + 1).trim();
    stmts.push({ line: i + 1, labels, op, args: op ? splitArgs(rest) : [], raw: rawLine.trim() });
  });
  return stmts;
}

// ───────────────────────── expressions ─────────────────────────

type Reloc = "hi" | "lo" | "pcrel_hi" | "pcrel_lo";

interface Ctx {
  symbols: Map<string, number>;
  equs: Map<string, number>;
  /** Numeric local labels ("1:"): name → addresses in source order. */
  locals: Map<string, number[]>;
  /** In pass 1 unknown symbols evaluate to undefined instead of failing. */
  final: boolean;
  pc: number;
  /** For %pcrel_lo: address of an auipc → the symbol it targets. */
  pcrelHi: Map<number, number>;
}

function parseNumber(tok: string): number | undefined {
  const t = tok.trim();
  if (/^[-+]?0x[0-9a-f_]+$/i.test(t)) {
    const neg = t.startsWith("-");
    const v = parseInt(t.replace(/^[-+]?0x/i, "").replace(/_/g, ""), 16);
    return neg ? -v : v;
  }
  if (/^[-+]?0b[01_]+$/i.test(t)) {
    const neg = t.startsWith("-");
    const v = parseInt(t.replace(/^[-+]?0b/i, "").replace(/_/g, ""), 2);
    return neg ? -v : v;
  }
  if (/^[-+]?\d+$/.test(t)) return parseInt(t, 10);
  const ch = t.match(/^'(\\?.)'$/);
  if (ch) return unescape(ch[1]).charCodeAt(0);
  return undefined;
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", '"': '"', "'": "'" })[c] ?? c);
}

export const hi20 = (v: number): number => ((v + 0x800) >>> 12) & 0xfffff;
export const lo12 = (v: number): number => (v << 20) >> 20;

function resolveLocal(tok: string, ctx: Ctx): number | undefined {
  const m = tok.match(/^(\d+)([fb])$/);
  if (!m) return undefined;
  const list = ctx.locals.get(m[1]) ?? [];
  if (m[2] === "b") {
    for (let i = list.length - 1; i >= 0; i--) if (list[i] <= ctx.pc) return list[i];
  } else {
    for (const a of list) if (a > ctx.pc) return a;
  }
  return undefined;
}

/**
 * Evaluate an expression: numbers, symbols, .equ names, local labels (1b/1f),
 * `a + b - c`, `a << b`, and %hi %lo %pcrel_hi %pcrel_lo.
 * Returns undefined in pass 1 when a symbol is not yet known.
 */
function evalExpr(expr: string, ctx: Ctx): number | undefined {
  const e = expr.trim();
  if (e === "") fail("missing operand");
  const rel = e.match(/^%(hi|lo|pcrel_hi|pcrel_lo)\((.+)\)$/i);
  if (rel) {
    const kind = rel[1].toLowerCase() as Reloc;
    const inner = evalExpr(rel[2], ctx);
    if (inner === undefined) return undefined;
    switch (kind) {
      case "hi": return hi20(inner);
      case "lo": return lo12(inner);
      case "pcrel_hi": return hi20(inner - ctx.pc);
      case "pcrel_lo": {
        const target = ctx.pcrelHi.get(inner);
        if (target === undefined) {
          if (!ctx.final) return 0;
          return fail(`%pcrel_lo(${rel[2]}) must name the label of an auipc that used %pcrel_hi`);
        }
        return lo12(target - inner);
      }
    }
  }
  const shift = e.match(/^(.+?)\s*(<<|>>)\s*(.+)$/);
  if (shift) {
    const a = evalExpr(shift[1], ctx);
    const b = evalExpr(shift[3], ctx);
    if (a === undefined || b === undefined) return undefined;
    return shift[2] === "<<" ? a * 2 ** b : Math.floor(a / 2 ** b);
  }
  if (/^\(.*\)$/.test(e)) return evalExpr(e.slice(1, -1), ctx);
  const terms: { sign: number; tok: string }[] = [];
  let i = 0;
  let sign = 1;
  let cur = "";
  const push = () => {
    if (cur.trim() !== "") terms.push({ sign, tok: cur.trim() });
    cur = "";
  };
  while (i < e.length) {
    const c = e[i];
    if (c === "'") {
      const end = e.indexOf("'", i + (e[i + 1] === "\\" ? 3 : 2));
      cur += e.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if ((c === "+" || c === "-") && cur.trim() !== "" && !/[eE]$/.test(cur.trim()) || ((c === "+" || c === "-") && cur.trim() !== "" && /^0x/i.test(cur.trim()))) {
      push();
      sign = c === "-" ? -1 : 1;
    } else if ((c === "+" || c === "-") && cur.trim() === "") {
      sign *= c === "-" ? -1 : 1;
    } else cur += c;
    i++;
  }
  push();
  let total = 0;
  for (const t of terms) {
    let v = parseNumber(t.tok);
    if (v === undefined) v = resolveLocal(t.tok, ctx);
    if (v === undefined) {
      if (!/^[A-Za-z_.$][\w.$]*$/.test(t.tok) && !/^\d+[fb]$/.test(t.tok)) fail(`can't understand "${t.tok}"`);
      v = ctx.equs.get(t.tok) ?? ctx.symbols.get(t.tok);
      if (v === undefined) {
        if (!ctx.final) return undefined;
        if (parseRegister(t.tok) !== undefined) fail(`expected a number or label, got register "${t.tok}"`);
        fail(`unknown label or symbol "${t.tok}"`);
      }
    }
    total += t.sign * v!;
  }
  return total;
}

function xreg(tok: string | undefined, what = "register"): number {
  if (tok === undefined) return fail(`missing ${what}`);
  const r = parseRegister(tok);
  if (r === undefined) {
    if (parseFRegister(tok) !== undefined) fail(`"${tok}" is a floating-point register; this operand needs an integer register`);
    fail(`"${tok}" is not a register (use x0–x31 or ABI names like t0, a0, sp)`);
  }
  return r!;
}

function freg(tok: string | undefined): number {
  if (tok === undefined) return fail("missing FP register");
  const r = parseFRegister(tok);
  if (r === undefined) {
    if (parseRegister(tok) !== undefined) fail(`"${tok}" is an integer register; this operand needs an FP register (f0–f31, fa0, ft0…)`);
    fail(`"${tok}" is not an FP register (use f0–f31 or ABI names like fa0, ft0, fs0)`);
  }
  return r!;
}

function vreg(tok: string | undefined): number {
  if (tok === undefined) return fail("missing vector register");
  const r = parseVRegister(tok);
  if (r === undefined) fail(`"${tok}" is not a vector register (v0–v31)`);
  return r!;
}

/** Parse "imm(rs1)", "(rs1)". */
function memOperand(tok: string | undefined, ctx: Ctx): { imm: number | undefined; rs1: number } {
  if (!tok) return fail("missing memory operand like 8(sp)");
  const m = tok.match(/^(.*)\(\s*([^)]+)\s*\)$/);
  if (!m) return fail(`expected a memory operand like 8(sp), got "${tok}"`);
  const imm = m[1].trim() === "" ? 0 : evalExpr(m[1], ctx);
  return { imm, rs1: xreg(m[2]) };
}

function checkRange(v: number, lo: number, hi: number, what: string, hint = ""): number {
  if (v < lo || v > hi) fail(`${what} ${v} doesn't fit (${lo}…${hi})${hint}`);
  return v;
}

const RM: Record<string, number> = { rne: 0, rtz: 1, rdn: 2, rup: 3, rmm: 4, dyn: 7 };

function parseVtype(args: string[]): number {
  let v = 0;
  let sew: number | undefined;
  let lmul: number | undefined;
  for (const a of args.map((x) => x.trim().toLowerCase())) {
    const e = a.match(/^e(8|16|32|64)$/);
    const m = a.match(/^m(f?)(1|2|4|8)$/);
    if (e) sew = Math.log2(Number(e[1]) / 8);
    else if (m) {
      const n = Math.log2(Number(m[2]));
      lmul = m[1] ? (8 - n) & 7 : n;
      if (m[1] && n === 0) fail("mf1 is not a valid LMUL");
    } else if (a === "ta") v |= 0x40;
    else if (a === "ma") v |= 0x80;
    else if (a === "tu" || a === "mu") continue;
    else fail(`unknown vtype setting "${a}" (expected e8/e16/e32, m1/m2/m4/m8/mf2…, ta/tu, ma/mu)`);
  }
  if (sew === undefined) fail("vtype needs an element width: e8, e16 or e32");
  return v | (sew! << 3) | (lmul ?? 0);
}

// ───────────────────────── operands by syntax ─────────────────────────

/** One real instruction to emit: a 32-bit definition with operands, or a compressed form. */
interface Real {
  def: InstrDef;
  ops: EncodeOperands;
  /** Explicit c.* mnemonic. */
  c?: string;
  cOps?: COperands;
}

function needCount(def: { mnemonic: string; syntax: string }, a: string[], toks: string[]) {
  const required = toks.filter((t) => !t.endsWith("?")).length;
  if (a.length < required || a.length > toks.length) {
    const usage = `${def.mnemonic} ${toks.map((t) => t.replace("?", "")).join(", ")}`.trim();
    fail(`expected ${required === toks.length ? required : `${required}–${toks.length}`} operand${toks.length === 1 ? "" : "s"}: ${usage}`);
  }
}

function branchOffset(label: string, ctx: Ctx, bits: number): number {
  const target = evalExpr(label, ctx) ?? ctx.pc;
  const off = (target - ctx.pc) | 0; // addresses wrap modulo 2^32
  const lim = 2 ** (bits - 1);
  if (off < -lim || off > lim - 2) fail(`branch target is ${off} bytes away; this instruction reaches ±${lim} bytes`);
  if (off & 1) fail("branch/jump target must be 2-byte aligned");
  return off;
}

const imm12 = (v: number) =>
  checkRange(v, -2048, 2047, "immediate", v > 2047 || v < -2048 ? "; it needs 12 bits signed — use li to build large constants" : "");

/** Parse the operands of a 32-bit instruction according to its syntax string. */
function parseOperands(def: InstrDef, a: string[], ctx: Ctx): EncodeOperands {
  const E = (e: string) => evalExpr(e, ctx) ?? 0;
  const ops: EncodeOperands = {};
  const toks = def.syntax ? def.syntax.split(",") : [];
  if (toks.at(-1) === "vtypei") {
    // vsetvli rd, rs1, e32, m1, ta, ma: everything after the fixed operands is vtype.
    const head = a.slice(0, toks.length - 1);
    if (head.length !== toks.length - 1 || a.length < toks.length) fail(`expected: ${def.mnemonic} ${def.syntax.replace("vtypei", "e32, m1[, ta, ma]")}`);
    const t = a.slice(toks.length - 1);
    ops.vtypei = t.length === 1 && parseNumber(t[0]) !== undefined ? parseNumber(t[0]) : parseVtype(t);
    a = [...head, "_vtype_"];
  }
  needCount(def, a, toks);
  let ai = 0;
  for (const raw of toks) {
    const tok = raw.replace(/\?$/, "");
    const optional = raw.endsWith("?");
    const arg = a[ai];
    if (optional) {
      if (arg === undefined) continue;
      if (tok === "vm" && arg.toLowerCase() !== "v0.t") fail(`mask operand must be v0.t, got "${arg}"`);
      if (tok === "rm" && RM[arg.toLowerCase()] === undefined) fail(`"${arg}" is not a rounding mode (rne, rtz, rdn, rup, rmm, dyn)`);
    }
    ai++;
    const field = TOKEN_FIELD[tok] ?? tok;
    switch (tok) {
      case "rd": case "rs1": case "rs2": case "rs3": ops[tok] = xreg(arg); break;
      case "fd": case "fs1": case "fs2": case "fs3": ops[field] = freg(arg); break;
      case "vd": case "vs1": case "vs2": case "vs3": ops[tok] = vreg(arg); break;
      case "imm": ops.imm = imm12(E(arg)); break;
      case "uimm20": ops.imm = (checkRange(E(arg), -0x80000, 0xfffff, "upper immediate", " (20 bits)") & 0xfffff) << 12; break;
      case "offB": ops.imm = branchOffset(arg, ctx, 13); break;
      case "offJ": ops.imm = branchOffset(arg, ctx, 21); break;
      case "mem": case "memS": {
        const m = memOperand(arg, ctx);
        ops.rs1 = m.rs1;
        ops.imm = imm12(m.imm ?? 0);
        break;
      }
      case "(rs1)": {
        const m = memOperand(arg, ctx);
        if ((m.imm ?? 0) !== 0) fail(`${def.mnemonic} takes no offset: write (${arg.replace(/^.*\(/, "").replace(/\)$/, "")})`);
        ops.rs1 = m.rs1;
        break;
      }
      case "shamt": ops.shamt = checkRange(E(arg), 0, 31, "shift amount"); break;
      case "csr": {
        const named = CSR_BY_NAME.get(arg.toLowerCase());
        ops.csr = named ? named.addr : checkRange(E(arg), 0, 0xfff, "CSR number");
        break;
      }
      case "zimm": ops.zimm = checkRange(E(arg), 0, 31, "CSR immediate", " (5 bits, unsigned)"); break;
      case "simm5": ops.simm5 = checkRange(E(arg), -16, 15, "vector immediate", " (5 bits, signed)"); break;
      case "uimm5": ops.uimm5 = checkRange(E(arg), 0, 31, "unsigned immediate", " (5 bits)"); break;
      case "vtypei": break;
      case "v0": if (arg.toLowerCase() !== "v0") fail(`this operand must be v0 (the mask register), got "${arg}"`); break;
      case "rm": ops.funct3 = RM[arg.toLowerCase()]; break;
      case "vm": ops.vm = 0; break;
      case "pred": ops.pred = fenceSet(arg); break;
      case "succ": ops.succ = fenceSet(arg); break;
    }
  }
  return ops;
}

function fenceSet(s: string | undefined): number {
  if (s === undefined) return fail("fence takes pred, succ (e.g. fence rw, rw)");
  const t = s.toLowerCase();
  if (t === "0") return 0;
  if (!/^[iorw]+$/.test(t)) fail(`fence set "${s}" must use letters i, o, r, w`);
  return (t.includes("i") ? 8 : 0) | (t.includes("o") ? 4 : 0) | (t.includes("r") ? 2 : 0) | (t.includes("w") ? 1 : 0);
}

/** Parse the operands of an explicit c.* instruction. */
function parseCOperands(m: string, a: string[], ctx: Ctx): COperands {
  const cdef = C_BY_MNEMONIC.get(m)!;
  const toks = cdef.syntax ? cdef.syntax.split(",") : [];
  needCount(cdef, a, toks);
  const o: COperands = {};
  const E = (e: string) => evalExpr(e, ctx) ?? 0;
  toks.forEach((tok, i) => {
    const arg = a[i];
    switch (tok) {
      case "rd": case "rd'": o.rd = xreg(arg); break;
      case "rs1": case "rs1'": o.rs1 = xreg(arg); break;
      case "rs2": case "rs2'": o.rs2 = xreg(arg); break;
      case "fd": case "fd'": o.rd = freg(arg); break;
      case "fs2": case "fs2'": o.rs2 = freg(arg); break;
      case "sp": if (xreg(arg) !== 2) fail(`${m} works on sp`); break;
      case "imm": case "uimm": o.imm = E(arg); break;
      case "uimm20": o.imm = E(arg) & 0xfffff; break;
      case "mem'": case "memsp": {
        const mo = memOperand(arg, ctx);
        o.rs1 = mo.rs1;
        o.imm = mo.imm ?? 0;
        if (tok === "memsp" && mo.rs1 !== 2) fail(`${m} addresses relative to sp`);
        break;
      }
      case "offB": o.imm = branchOffset(arg, ctx, 9); break;
      case "offJ": o.imm = branchOffset(arg, ctx, 12); break;
    }
  });
  return o;
}

// ───────────────────────── pseudo-instructions ─────────────────────────

const R = (m: string, ops: EncodeOperands): Real => ({ def: BY_MNEMONIC.get(m)!, ops });

/** Number of real instructions a statement expands to (pass 1). */
function sizeOf(op: string, args: string[], ctx: Ctx): number {
  switch (op) {
    case "li": {
      const v = args[1] !== undefined ? safeEval(args[1], ctx) : 0;
      if (v === undefined) return 2;
      return v >= -2048 && v <= 2047 ? 1 : (v | 0) % 4096 === 0 || (lo12(v | 0) === 0) ? 1 : 2;
    }
    case "la": case "lla": case "call": case "tail":
      return 2;
    default:
      return 1;
  }
}

function safeEval(expr: string, ctx: Ctx): number | undefined {
  try {
    return evalExpr(expr, { ...ctx, final: false });
  } catch {
    return undefined;
  }
}

function need(args: string[], n: number, usage: string): void {
  if (args.length !== n) fail(`expected ${n} operand${n === 1 ? "" : "s"}: ${usage}`);
}

const CSR_PSEUDO: Record<string, [string, string]> = {
  rdcycle: ["csrrs", "cycle"], rdtime: ["csrrs", "time"], rdinstret: ["csrrs", "instret"],
  rdcycleh: ["csrrs", "cycleh"], rdtimeh: ["csrrs", "timeh"], rdinstreth: ["csrrs", "instreth"],
  frcsr: ["csrrs", "fcsr"], frrm: ["csrrs", "frm"], frflags: ["csrrs", "fflags"],
};

/** Expand a pseudo-instruction, or return null if `op` is not one. */
function expandPseudo(op: string, a: string[], ctx: Ctx, sizeHint: number): Real[] | null {
  const E = (e: string) => evalExpr(e, ctx) ?? 0;
  const csrAddr = (s: string) => CSR_BY_NAME.get(s.toLowerCase())?.addr ?? checkRange(E(s), 0, 0xfff, "CSR number");
  switch (op) {
    case "nop": need(a, 0, "nop"); return [R("addi", { rd: 0, rs1: 0, imm: 0 })];
    case "li": {
      need(a, 2, "li rd, imm");
      const rd = xreg(a[0]);
      const v = E(a[1]);
      checkRange(v, -0x80000000, 0xffffffff, "li immediate");
      const s = v | 0;
      if (sizeHint === 1) {
        if (s >= -2048 && s <= 2047) return [R("addi", { rd, rs1: 0, imm: s })];
        return [R("lui", { rd, imm: hi20(s) << 12 })];
      }
      return [R("lui", { rd, imm: hi20(s) << 12 }), R("addi", { rd, rs1: rd, imm: lo12(s) })];
    }
    case "la": case "lla": {
      need(a, 2, `${op} rd, symbol`);
      const rd = xreg(a[0]);
      const off = E(a[1]) - ctx.pc;
      return [R("auipc", { rd, imm: hi20(off) << 12 }), R("addi", { rd, rs1: rd, imm: lo12(off) })];
    }
    case "mv": need(a, 2, "mv rd, rs"); return [R("addi", { rd: xreg(a[0]), rs1: xreg(a[1]), imm: 0 })];
    case "not": need(a, 2, "not rd, rs"); return [R("xori", { rd: xreg(a[0]), rs1: xreg(a[1]), imm: -1 })];
    case "neg": need(a, 2, "neg rd, rs"); return [R("sub", { rd: xreg(a[0]), rs1: 0, rs2: xreg(a[1]) })];
    case "seqz": need(a, 2, "seqz rd, rs"); return [R("sltiu", { rd: xreg(a[0]), rs1: xreg(a[1]), imm: 1 })];
    case "snez": need(a, 2, "snez rd, rs"); return [R("sltu", { rd: xreg(a[0]), rs1: 0, rs2: xreg(a[1]) })];
    case "sltz": need(a, 2, "sltz rd, rs"); return [R("slt", { rd: xreg(a[0]), rs1: xreg(a[1]), rs2: 0 })];
    case "sgtz": need(a, 2, "sgtz rd, rs"); return [R("slt", { rd: xreg(a[0]), rs1: 0, rs2: xreg(a[1]) })];
    case "sgt": case "sgtu": need(a, 3, `${op} rd, rs, rt`); return [R(op === "sgt" ? "slt" : "sltu", { rd: xreg(a[0]), rs1: xreg(a[2]), rs2: xreg(a[1]) })];
    case "zext.b": need(a, 2, "zext.b rd, rs"); return [R("andi", { rd: xreg(a[0]), rs1: xreg(a[1]), imm: 255 })];
    case "beqz": need(a, 2, "beqz rs, label"); return [R("beq", { rs1: xreg(a[0]), rs2: 0, imm: branchOffset(a[1], ctx, 13) })];
    case "bnez": need(a, 2, "bnez rs, label"); return [R("bne", { rs1: xreg(a[0]), rs2: 0, imm: branchOffset(a[1], ctx, 13) })];
    case "blez": need(a, 2, "blez rs, label"); return [R("bge", { rs1: 0, rs2: xreg(a[0]), imm: branchOffset(a[1], ctx, 13) })];
    case "bgez": need(a, 2, "bgez rs, label"); return [R("bge", { rs1: xreg(a[0]), rs2: 0, imm: branchOffset(a[1], ctx, 13) })];
    case "bltz": need(a, 2, "bltz rs, label"); return [R("blt", { rs1: xreg(a[0]), rs2: 0, imm: branchOffset(a[1], ctx, 13) })];
    case "bgtz": need(a, 2, "bgtz rs, label"); return [R("blt", { rs1: 0, rs2: xreg(a[0]), imm: branchOffset(a[1], ctx, 13) })];
    case "bgt": case "ble": case "bgtu": case "bleu": {
      need(a, 3, `${op} rs, rt, label`);
      const real = { bgt: "blt", ble: "bge", bgtu: "bltu", bleu: "bgeu" }[op];
      return [R(real, { rs1: xreg(a[1]), rs2: xreg(a[0]), imm: branchOffset(a[2], ctx, 13) })];
    }
    case "j": need(a, 1, "j label"); return [R("jal", { rd: 0, imm: branchOffset(a[0], ctx, 21) })];
    case "jr":
      if (a.length === 2) return [R("jalr", { rd: 0, rs1: xreg(a[0]), imm: imm12(E(a[1])) })];
      need(a, 1, "jr rs");
      return [R("jalr", { rd: 0, rs1: xreg(a[0]), imm: 0 })];
    case "ret": need(a, 0, "ret"); return [R("jalr", { rd: 0, rs1: 1, imm: 0 })];
    case "call": case "tail": {
      need(a, 1, `${op} label`);
      const off = E(a[0]) - ctx.pc;
      const t = op === "call" ? 1 : 6;
      return [R("auipc", { rd: t, imm: hi20(off) << 12 }), R("jalr", { rd: op === "call" ? 1 : 0, rs1: t, imm: lo12(off) })];
    }
    case "jal":
      if (a.length === 1) return [R("jal", { rd: 1, imm: branchOffset(a[0], ctx, 21) })];
      return null;
    case "jalr":
      if (a.length === 1) return [R("jalr", { rd: 1, rs1: xreg(a[0]), imm: 0 })];
      if (a.length === 3) return [R("jalr", { rd: xreg(a[0]), rs1: xreg(a[1]), imm: imm12(E(a[2])) })];
      if (a.length === 2 && !/\(/.test(a[1])) return [R("jalr", { rd: xreg(a[0]), rs1: xreg(a[1]), imm: 0 })];
      return null;
    case "fence":
      if (a.length === 0) return [R("fence", { pred: 15, succ: 15 })];
      return null;
    case "pause": need(a, 0, "pause"); return [R("fence", { pred: 1, succ: 0 })];
    case "unimp": case "c.unimp": need(a, 0, "unimp"); return [R("csrrw", { rd: 0, csr: 0xc00, rs1: 0 })];
    // CSR shorthands
    case "csrr": need(a, 2, "csrr rd, csr"); return [R("csrrs", { rd: xreg(a[0]), csr: csrAddr(a[1]), rs1: 0 })];
    case "csrw": case "csrs": case "csrc": {
      need(a, 2, `${op} csr, rs`);
      const real = { csrw: "csrrw", csrs: "csrrs", csrc: "csrrc" }[op];
      const asImm = parseRegister(a[1]) === undefined;
      if (asImm) return [R(`${real}i`, { rd: 0, csr: csrAddr(a[0]), zimm: checkRange(E(a[1]), 0, 31, "CSR immediate") })];
      return [R(real, { rd: 0, csr: csrAddr(a[0]), rs1: xreg(a[1]) })];
    }
    case "csrwi": case "csrsi": case "csrci": {
      need(a, 2, `${op} csr, uimm`);
      const real = { csrwi: "csrrwi", csrsi: "csrrsi", csrci: "csrrci" }[op];
      return [R(real, { rd: 0, csr: csrAddr(a[0]), zimm: checkRange(E(a[1]), 0, 31, "CSR immediate") })];
    }
    case "fscsr": case "fsrm": case "fsflags": {
      const csr = { fscsr: 0x003, fsrm: 0x002, fsflags: 0x001 }[op];
      if (a.length === 1) return [R("csrrw", { rd: 0, csr, rs1: xreg(a[0]) })];
      need(a, 2, `${op} rd, rs`);
      return [R("csrrw", { rd: xreg(a[0]), csr, rs1: xreg(a[1]) })];
    }
    case "fsrmi": case "fsflagsi": {
      const csr = op === "fsrmi" ? 0x002 : 0x001;
      if (a.length === 1) return [R("csrrwi", { rd: 0, csr, zimm: checkRange(E(a[0]), 0, 31, "immediate") })];
      need(a, 2, `${op} rd, uimm`);
      return [R("csrrwi", { rd: xreg(a[0]), csr, zimm: checkRange(E(a[1]), 0, 31, "immediate") })];
    }
    // FP shorthands
    case "fmv.s": case "fabs.s": case "fneg.s": case "fmv.d": case "fabs.d": case "fneg.d": {
      need(a, 2, `${op} fd, fs`);
      const kind = op.slice(0, op.indexOf("."));
      const real = { fmv: "fsgnj", fabs: "fsgnjx", fneg: "fsgnjn" }[kind] + op.slice(-2);
      const rs = freg(a[1]);
      return [R(real, { rd: freg(a[0]), rs1: rs, rs2: rs })];
    }
    case "fmv.x.s": need(a, 2, "fmv.x.s rd, fs"); return [R("fmv.x.w", { rd: xreg(a[0]), rs1: freg(a[1]) })];
    case "fmv.s.x": need(a, 2, "fmv.s.x fd, rs"); return [R("fmv.w.x", { rd: freg(a[0]), rs1: xreg(a[1]) })];
    // Vector shorthands
    case "vnot.v": need(a, 2, "vnot.v vd, vs"); return [R("vxor.vi", { vd: vreg(a[0]), vs2: vreg(a[1]), simm5: -1, vm: 1 })];
    case "vneg.v": need(a, 2, "vneg.v vd, vs"); return [R("vrsub.vx", { vd: vreg(a[0]), vs2: vreg(a[1]), rs1: 0, vm: 1 })];
    case "vmmv.m": case "vmcpy.m": need(a, 2, `${op} vd, vs`); return [R("vmand.mm", { vd: vreg(a[0]), vs2: vreg(a[1]), vs1: vreg(a[1]) })];
    case "vmnot.m": need(a, 2, "vmnot.m vd, vs"); return [R("vmnand.mm", { vd: vreg(a[0]), vs2: vreg(a[1]), vs1: vreg(a[1]) })];
    case "vmclr.m": need(a, 1, "vmclr.m vd"); return [R("vmxor.mm", { vd: vreg(a[0]), vs2: vreg(a[0]), vs1: vreg(a[0]) })];
    case "vmset.m": need(a, 1, "vmset.m vd"); return [R("vmxnor.mm", { vd: vreg(a[0]), vs2: vreg(a[0]), vs1: vreg(a[0]) })];
    case "vmsgt.vv": case "vmsgtu.vv": case "vmsge.vv": case "vmsgeu.vv": {
      const real = { "vmsgt.vv": "vmslt.vv", "vmsgtu.vv": "vmsltu.vv", "vmsge.vv": "vmsle.vv", "vmsgeu.vv": "vmsleu.vv" }[op];
      if (a.length < 3 || a.length > 4) fail(`expected: ${op} vd, va, vb[, v0.t]`);
      return [R(real, { vd: vreg(a[0]), vs2: vreg(a[2]), vs1: vreg(a[1]), vm: a[3] ? 0 : 1 })];
    }
  }
  if (CSR_PSEUDO[op]) {
    need(a, 1, `${op} rd`);
    const [real, csr] = CSR_PSEUDO[op];
    return [R(real, { rd: xreg(a[0]), csr: CSR_BY_NAME.get(csr)!.addr, rs1: 0 })];
  }
  return null;
}

/** AMO mnemonics may carry .aq / .rl / .aqrl ordering suffixes. */
function splitOrdering(op: string): { base: string; aq: number; rl: number } {
  const m = op.match(/^(.*?)(\.aqrl|\.aq|\.rl)$/);
  if (m && BY_MNEMONIC.get(m[1])?.ext === "A") {
    return { base: m[1], aq: m[2] === ".rl" ? 0 : 1, rl: m[2] === ".aq" ? 0 : 1 };
  }
  return { base: op, aq: 0, rl: 0 };
}

/** Expand any statement into real instructions. */
function expand(op: string, a: string[], ctx: Ctx, sizeHint: number): Real[] {
  const p = expandPseudo(op, a, ctx, sizeHint);
  if (p) return p;
  if (C_BY_MNEMONIC.has(op)) {
    const cOps = parseCOperands(op, a, ctx);
    return [{ def: BY_MNEMONIC.get("addi")!, ops: {}, c: op, cOps }];
  }
  const { base, aq, rl } = splitOrdering(op);
  const def = BY_MNEMONIC.get(base);
  if (!def) return fail(`unknown instruction "${op}"`);
  const ops = parseOperands(def, a, ctx);
  if (def.ext === "A") Object.assign(ops, { aq, rl });
  return [{ def, ops }];
}

const PSEUDOS = new Set([
  "nop", "li", "la", "lla", "mv", "not", "neg", "seqz", "snez", "sltz", "sgtz", "sgt", "sgtu", "zext.b", "beqz", "bnez",
  "blez", "bgez", "bltz", "bgtz", "bgt", "ble", "bgtu", "bleu", "j", "jr", "ret", "call", "tail", "pause", "unimp",
  "csrr", "csrw", "csrs", "csrc", "csrwi", "csrsi", "csrci", "fscsr", "fsrm", "fsflags", "fsrmi", "fsflagsi",
  "fmv.s", "fabs.s", "fneg.s", "fmv.d", "fabs.d", "fneg.d", "fmv.x.s", "fmv.s.x",
  "vnot.v", "vneg.v", "vmmv.m", "vmnot.m", "vmclr.m", "vmset.m", "vmsgt.vv", "vmsgtu.vv", "vmsge.vv", "vmsgeu.vv",
  ...Object.keys(CSR_PSEUDO),
]);

export const isPseudo = (op: string): boolean => PSEUDOS.has(op);
export const PSEUDO_LIST = [...PSEUDOS];

// ───────────────────────── data directives ─────────────────────────

type Section = "text" | "data";

function f32Bytes(x: number): number[] {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, x, true);
  return [0, 1, 2, 3].map((i) => b.getUint8(i));
}

function f64Bytes(x: number): number[] {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x, true);
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => b.getUint8(i));
}

function parseFloatLit(s: string, ctx: Ctx): number {
  const t = s.trim().toLowerCase();
  if (t === "inf" || t === "+inf") return Infinity;
  if (t === "-inf") return -Infinity;
  if (t === "nan") return NaN;
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(t)) return Number(t);
  return evalExpr(s, ctx) ?? 0;
}

function dataBytes(op: string, args: string[], ctx: Ctx, offset: number): number[] {
  const out: number[] = [];
  const pushN = (v: number, n: number) => {
    for (let i = 0; i < n; i++) out.push(Math.floor(v / 2 ** (8 * i)) & 0xff);
  };
  switch (op) {
    case ".byte": case ".1byte": for (const x of args) pushN((evalExpr(x, ctx) ?? 0) >>> 0, 1); break;
    case ".half": case ".short": case ".2byte": for (const x of args) pushN((evalExpr(x, ctx) ?? 0) >>> 0, 2); break;
    case ".word": case ".long": case ".4byte": for (const x of args) pushN((evalExpr(x, ctx) ?? 0) >>> 0, 4); break;
    case ".dword": case ".quad": case ".8byte":
      for (const x of args) {
        const big = BigInt.asUintN(64, BigInt(evalExpr(x, ctx) ?? 0));
        for (let i = 0n; i < 8n; i++) out.push(Number((big >> (8n * i)) & 0xffn));
      }
      break;
    case ".float": for (const x of args) out.push(...f32Bytes(parseFloatLit(x, ctx))); break;
    case ".double": for (const x of args) out.push(...f64Bytes(parseFloatLit(x, ctx))); break;
    case ".string": case ".asciz": case ".ascii":
      for (const x of args) {
        const m = x.match(/^"((?:[^"\\]|\\.)*)"$/);
        if (!m) fail(`${op} expects a quoted string`);
        for (const ch of unescape(m![1])) out.push(ch.charCodeAt(0) & 0xff);
        if (op !== ".ascii") out.push(0);
      }
      break;
    case ".zero": case ".space": case ".skip": {
      const n = evalExpr(args[0] ?? "", { ...ctx, final: true })!;
      checkRange(n, 0, 1 << 20, `${op} size`);
      const fill = args[1] ? (evalExpr(args[1], ctx) ?? 0) & 0xff : 0;
      for (let i = 0; i < n; i++) out.push(fill);
      break;
    }
    case ".align": case ".p2align": case ".balign": {
      const n = evalExpr(args[0] ?? "", { ...ctx, final: true })!;
      const align = op === ".balign" ? n : 2 ** n;
      while ((offset + out.length) % align !== 0) out.push(0);
      break;
    }
  }
  return out;
}

const DATA_DIRECTIVES = new Set([
  ".byte", ".1byte", ".half", ".short", ".2byte", ".word", ".long", ".4byte", ".dword", ".quad", ".8byte", ".float", ".double",
  ".string", ".asciz", ".ascii", ".zero", ".space", ".skip", ".align", ".p2align", ".balign",
]);
const ALIGN_DIRECTIVES = new Set([".align", ".p2align", ".balign"]);
const IGNORED_DIRECTIVES = new Set([
  ".globl", ".global", ".type", ".size", ".file", ".attribute", ".ident", ".weak", ".local", ".comm", ".end", ".macro", ".endm",
]);
const SECTION_DIRECTIVES = new Set([".text", ".data", ".rodata", ".bss", ".sdata", ".sbss", ".section"]);

// ───────────────────────── assembler ─────────────────────────

/** Per-statement plan decided in pass 1 and replayed in pass 2. */
interface Plan {
  count: number;
  /** For each real instruction: will it be emitted as 16 bits? */
  compress: boolean[];
  bytes: number;
}

export function assemble(src: string): Program {
  const stmts = parseLines(src);
  const errors: AsmError[] = [];
  const symbols = new Map<string, number>();
  const equs = new Map<string, number>();
  const locals = new Map<string, number[]>();
  const pcrelHi = new Map<number, number>();
  const plans = new Map<Stmt, Plan>();
  const err = (line: number, e: unknown) => {
    if (e instanceof AsmFail || e instanceof CEncodeError) errors.push({ line, message: e.message });
    else throw e;
  };

  const sectionOf = (st: Stmt, cur: Section): Section => {
    if (st.op === ".text") return "text";
    if (st.op === ".data" || st.op === ".rodata" || st.op === ".bss" || st.op === ".sdata" || st.op === ".sbss") return "data";
    if (st.op === ".section") return /text/.test(st.args[0] ?? "") ? "text" : "data";
    return cur;
  };

  /** Alignment padding for a text-section .align. */
  const textPad = (st: Stmt, pc: number, ctx: Ctx): number => {
    const n = evalExpr(st.args[0] ?? "", { ...ctx, final: true })!;
    const align = st.op === ".balign" ? n : 2 ** n;
    return (align - (pc % align)) % align;
  };

  // Pass 1: assign addresses to labels and decide instruction sizes.
  let section: Section = "text";
  let rvc = false;
  const rvcStack: boolean[] = [];
  let tpc = TEXT_BASE;
  let dpc = DATA_BASE;
  for (const st of stmts) {
    section = sectionOf(st, section);
    const ctx: Ctx = { symbols, equs, locals, final: false, pc: tpc, pcrelHi };
    for (const l of st.labels) {
      const addr = section === "text" ? tpc : dpc;
      if (/^\d+$/.test(l)) {
        if (!locals.has(l)) locals.set(l, []);
        locals.get(l)!.push(addr);
        continue;
      }
      if (symbols.has(l)) errors.push({ line: st.line, message: `label "${l}" is defined twice` });
      symbols.set(l, addr);
    }
    if (!st.op) continue;
    try {
      if (st.op === ".equ" || st.op === ".set") {
        if (st.args.length !== 2) fail(".equ name, value");
        equs.set(st.args[0], evalExpr(st.args[1], { ...ctx, final: true })!);
      } else if (st.op === ".option") {
        const o = (st.args[0] ?? "").toLowerCase();
        if (o === "rvc") rvc = true;
        else if (o === "norvc") rvc = false;
        else if (o === "push") rvcStack.push(rvc);
        else if (o === "pop") rvc = rvcStack.pop() ?? rvc;
      } else if (DATA_DIRECTIVES.has(st.op)) {
        if (section === "text") {
          if (ALIGN_DIRECTIVES.has(st.op)) {
            tpc += textPad(st, tpc, ctx);
            continue;
          }
          fail(`data directive ${st.op} in .text — put data after a .data line`);
        }
        dpc += dataBytes(st.op, st.args, ctx, dpc - DATA_BASE).length;
      } else if (st.op.startsWith(".")) {
        if (!SECTION_DIRECTIVES.has(st.op) && !IGNORED_DIRECTIVES.has(st.op)) fail(`unsupported directive ${st.op}`);
      } else {
        if (section !== "text") fail(`instruction "${st.op}" in a data section — add .text before code`);
        const count = sizeOf(st.op, st.args, ctx);
        const compress: boolean[] = [];
        let bytes = 0;
        if (C_BY_MNEMONIC.has(st.op)) {
          compress.push(true);
          bytes = 2;
        } else if (rvc) {
          // Only compress when every operand is already known, so sizes cannot change in pass 2.
          let reals: Real[] | null = null;
          try {
            reals = expand(st.op, st.args, { ...ctx, final: true }, count);
          } catch {
            reals = null;
          }
          for (let k = 0; k < count; k++) {
            const r = reals?.[k];
            const c = !!r && !r.def.syntax.includes("off") && tryCompress(r.def, r.ops) !== null;
            compress.push(c);
            bytes += c ? 2 : 4;
          }
        } else {
          for (let k = 0; k < count; k++) compress.push(false);
          bytes = 4 * count;
        }
        plans.set(st, { count, compress, bytes });
        tpc += bytes;
      }
    } catch (e) {
      err(st.line, e);
    }
  }

  // Pass 2: encode.
  const text: TextEntry[] = [];
  const data: number[] = [];
  const lineToAddrs = new Map<number, number[]>();
  section = "text";
  tpc = TEXT_BASE;
  const emitAlignPad = (pad: number, line: number) => {
    const nop = BY_MNEMONIC.get("addi")!;
    while (pad >= 4) {
      text.push({ addr: tpc, word: encode(nop, {}), size: 4, line, asm: "nop" });
      tpc += 4;
      pad -= 4;
    }
    if (pad >= 2) {
      text.push({ addr: tpc, word: 0x0001, size: 2, line, asm: "c.nop", expanded: { word: encode(nop, {}), asm: "nop" } });
      tpc += 2;
    }
  };
  for (const st of stmts) {
    section = sectionOf(st, section);
    const ctx: Ctx = { symbols, equs, locals, final: true, pc: tpc, pcrelHi };
    if (!st.op || st.op.startsWith(".")) {
      if (st.op && DATA_DIRECTIVES.has(st.op)) {
        try {
          if (section === "data") data.push(...dataBytes(st.op, st.args, ctx, data.length));
          else if (ALIGN_DIRECTIVES.has(st.op)) emitAlignPad(textPad(st, tpc, ctx), st.line);
        } catch (e) {
          err(st.line, e);
        }
      }
      continue;
    }
    const plan = plans.get(st);
    if (!plan) continue; // failed in pass 1
    try {
      if (st.op === "auipc" && st.args[1]?.startsWith("%pcrel_hi(")) {
        pcrelHi.set(tpc, evalExpr(st.args[1].slice(10, -1), ctx)!);
      }
      const reals = expand(st.op, st.args, ctx, plan.count);
      if (reals.length !== plan.count) fail("internal: pseudo-instruction size changed between passes");
      if (st.op === "la" || st.op === "lla" || st.op === "call" || st.op === "tail") {
        pcrelHi.set(tpc, evalExpr(st.args[st.args.length - 1], ctx)!);
      }
      const addrs: number[] = [];
      const pseudo = isPseudo(st.op) || reals.length > 1 || (reals[0].def.mnemonic !== splitOrdering(st.op).base && !reals[0].c);
      reals.forEach((r, k) => {
        const p = pseudo ? { source: `${st.op} ${st.args.join(", ")}`.trim(), part: k + 1, of: reals.length } : undefined;
        if (r.c || plan.compress[k]) {
          const half = r.c ? encodeC(r.c, r.cOps!) : tryCompress(r.def, r.ops);
          if (half === null) fail("internal: compression decision changed between passes");
          const ex = expandC(half!)!;
          const d = decode(ex.word)!;
          const expandedAsm = formatInstr(d.def, d.f, tpc);
          text.push({
            addr: tpc, word: half!, size: 2, line: st.line,
            asm: r.c ? `${st.op} ${st.args.join(", ")}`.trim() : disassembleC(half!, tpc)!.c, pseudo: p,
            expanded: { word: ex.word, asm: expandedAsm },
          });
          addrs.push(tpc);
          tpc += 2;
        } else {
          const word = encode(r.def, r.ops);
          const d = decode(word);
          text.push({ addr: tpc, word, size: 4, line: st.line, asm: d ? formatInstr(d.def, d.f, tpc) : r.def.mnemonic, pseudo: p });
          addrs.push(tpc);
          tpc += 4;
        }
      });
      lineToAddrs.set(st.line, addrs);
    } catch (e) {
      err(st.line, e);
      tpc += plan.bytes;
    }
  }

  const entry = symbols.get("_start") ?? symbols.get("main") ?? TEXT_BASE;
  errors.sort((a, b) => a.line - b.line);
  return { text, textBase: TEXT_BASE, textEnd: tpc, data, dataBase: DATA_BASE, symbols, entry, errors, lineToAddrs };
}
