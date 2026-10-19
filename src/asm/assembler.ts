import { BY_MNEMONIC, type InstrDef } from "@/isa/instructions";
import { encode } from "@/isa/encoding";
import { ABI_NAMES, parseRegister } from "@/isa/registers";
import { DATA_BASE, TEXT_BASE } from "@/sim/cpu";

export interface AsmError {
  line: number; // 1-based
  message: string;
}

export interface TextEntry {
  addr: number;
  word: number;
  /** 1-based source line. */
  line: number;
  /** The real instruction, e.g. "addi t1, t1, 10". */
  asm: string;
  /** Set when this entry came from expanding a pseudo-instruction. */
  pseudo?: { source: string; part: number; of: number };
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
    while ((m = s.match(/^([A-Za-z_.$][\w.$]*)\s*:/))) {
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
  /** In pass 1 unknown symbols evaluate to undefined instead of failing. */
  final: boolean;
  pc: number;
  /** For %pcrel_lo: label → address of the auipc it refers to. */
  pcrelHi: Map<number, number>;
}

function parseNumber(tok: string): number | undefined {
  const t = tok.trim();
  if (/^[-+]?0x[0-9a-f_]+$/i.test(t)) return parseInt(t.replace(/_/g, ""), 16);
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

/**
 * Evaluate an expression: numbers, symbols, .equ names, `a + b - c`, and
 * relocation operators %hi(x) %lo(x) %pcrel_hi(x) %pcrel_lo(label).
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
  // Split into signed terms (respecting a leading sign and character literals).
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
    if ((c === "+" || c === "-") && cur.trim() !== "" && !/0x$/i.test(cur.trim())) {
      push();
      sign = c === "-" ? -1 : 1;
    } else if ((c === "+" || c === "-") && cur.trim() === "" && terms.length === 0 && sign === 1) {
      sign = c === "-" ? -1 : 1;
    } else cur += c;
    i++;
  }
  push();
  let total = 0;
  for (const t of terms) {
    let v = parseNumber(t.tok);
    if (v === undefined) {
      if (!/^[A-Za-z_.$][\w.$]*$/.test(t.tok)) fail(`can't understand "${t.tok}"`);
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

function reg(tok: string | undefined, what = "register"): number {
  if (tok === undefined) return fail(`missing ${what}`);
  const r = parseRegister(tok);
  if (r === undefined) fail(`"${tok}" is not a register (use x0–x31 or ABI names like t0, a0, sp)`);
  return r!;
}

/** Parse "imm(rs1)", "(rs1)" or a bare "imm" (rs1 = x0 is not allowed — must have parens). */
function memOperand(tok: string | undefined, ctx: Ctx): { imm: number | undefined; rs1: number } {
  if (!tok) return fail("missing memory operand like 8(sp)");
  const m = tok.match(/^(.*)\(\s*([^)]+)\s*\)$/);
  if (!m) return fail(`expected a memory operand like 8(sp), got "${tok}"`);
  const imm = m[1].trim() === "" ? 0 : evalExpr(m[1], ctx);
  return { imm, rs1: reg(m[2]) };
}

function checkRange(v: number, lo: number, hi: number, what: string, hint = ""): number {
  if (v < lo || v > hi) fail(`${what} ${v} doesn't fit (${lo}…${hi})${hint}`);
  return v;
}

// ───────────────────────── instruction expansion ─────────────────────────

interface Real {
  def: InstrDef;
  rd?: number;
  rs1?: number;
  rs2?: number;
  imm?: number;
}

const R = (m: string, o: Omit<Real, "def">): Real => ({ def: BY_MNEMONIC.get(m)!, ...o });

/** Number of real instructions a statement expands to (pass 1). */
function sizeOf(op: string, args: string[], ctx: Ctx): number {
  switch (op) {
    case "li": {
      const v = args[1] !== undefined ? safeEval(args[1], ctx) : 0;
      if (v === undefined) return 2;
      return v >= -2048 && v <= 2047 ? 1 : 2;
    }
    case "la":
    case "call":
    case "tail":
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

function branchOffset(label: string, ctx: Ctx, bits: number): number {
  const target = evalExpr(label, ctx) ?? ctx.pc;
  const off = target - ctx.pc;
  const lim = 2 ** (bits - 1);
  if (off < -lim || off > lim - 2) fail(`branch target is ${off} bytes away; this instruction reaches ±${lim} bytes`);
  if (off & 1) fail("branch/jump target must be 2-byte aligned");
  return off;
}

/** Expand a (possibly pseudo) instruction into real instructions. `sizeHint` is the pass-1 size. */
function expand(op: string, a: string[], ctx: Ctx, sizeHint: number): Real[] {
  const E = (e: string) => evalExpr(e, ctx) ?? 0;
  switch (op) {
    // ── pseudo-instructions ──
    case "nop": need(a, 0, "nop"); return [R("addi", { rd: 0, rs1: 0, imm: 0 })];
    case "li": {
      need(a, 2, "li rd, imm");
      const rd = reg(a[0]);
      const v = E(a[1]);
      checkRange(v, -0x80000000, 0xffffffff, "li immediate");
      const s = v | 0;
      if (sizeHint === 1) return [R("addi", { rd, rs1: 0, imm: s })];
      return [R("lui", { rd, imm: hi20(s) << 12 }), R("addi", { rd, rs1: rd, imm: lo12(s) })];
    }
    case "la": {
      need(a, 2, "la rd, symbol");
      const rd = reg(a[0]);
      const off = E(a[1]) - ctx.pc;
      return [R("auipc", { rd, imm: hi20(off) << 12 }), R("addi", { rd, rs1: rd, imm: lo12(off) })];
    }
    case "mv": need(a, 2, "mv rd, rs"); return [R("addi", { rd: reg(a[0]), rs1: reg(a[1]), imm: 0 })];
    case "not": need(a, 2, "not rd, rs"); return [R("xori", { rd: reg(a[0]), rs1: reg(a[1]), imm: -1 })];
    case "neg": need(a, 2, "neg rd, rs"); return [R("sub", { rd: reg(a[0]), rs1: 0, rs2: reg(a[1]) })];
    case "seqz": need(a, 2, "seqz rd, rs"); return [R("sltiu", { rd: reg(a[0]), rs1: reg(a[1]), imm: 1 })];
    case "snez": need(a, 2, "snez rd, rs"); return [R("sltu", { rd: reg(a[0]), rs1: 0, rs2: reg(a[1]) })];
    case "sltz": need(a, 2, "sltz rd, rs"); return [R("slt", { rd: reg(a[0]), rs1: reg(a[1]), rs2: 0 })];
    case "sgtz": need(a, 2, "sgtz rd, rs"); return [R("slt", { rd: reg(a[0]), rs1: 0, rs2: reg(a[1]) })];
    case "beqz": need(a, 2, "beqz rs, label"); return [R("beq", { rs1: reg(a[0]), rs2: 0, imm: branchOffset(a[1], ctx, 13) })];
    case "bnez": need(a, 2, "bnez rs, label"); return [R("bne", { rs1: reg(a[0]), rs2: 0, imm: branchOffset(a[1], ctx, 13) })];
    case "blez": need(a, 2, "blez rs, label"); return [R("bge", { rs1: 0, rs2: reg(a[0]), imm: branchOffset(a[1], ctx, 13) })];
    case "bgez": need(a, 2, "bgez rs, label"); return [R("bge", { rs1: reg(a[0]), rs2: 0, imm: branchOffset(a[1], ctx, 13) })];
    case "bltz": need(a, 2, "bltz rs, label"); return [R("blt", { rs1: reg(a[0]), rs2: 0, imm: branchOffset(a[1], ctx, 13) })];
    case "bgtz": need(a, 2, "bgtz rs, label"); return [R("blt", { rs1: 0, rs2: reg(a[0]), imm: branchOffset(a[1], ctx, 13) })];
    case "bgt": case "ble": case "bgtu": case "bleu": {
      need(a, 3, `${op} rs, rt, label`);
      const real = { bgt: "blt", ble: "bge", bgtu: "bltu", bleu: "bgeu" }[op];
      return [R(real, { rs1: reg(a[1]), rs2: reg(a[0]), imm: branchOffset(a[2], ctx, 13) })];
    }
    case "j": need(a, 1, "j label"); return [R("jal", { rd: 0, imm: branchOffset(a[0], ctx, 21) })];
    case "jr": need(a, 1, "jr rs"); return [R("jalr", { rd: 0, rs1: reg(a[0]), imm: 0 })];
    case "ret": need(a, 0, "ret"); return [R("jalr", { rd: 0, rs1: 1, imm: 0 })];
    case "call": case "tail": {
      need(a, 1, `${op} label`);
      const off = E(a[0]) - ctx.pc;
      const t = op === "call" ? 1 : 6;
      return [R("auipc", { rd: t, imm: hi20(off) << 12 }), R("jalr", { rd: op === "call" ? 1 : 0, rs1: t, imm: lo12(off) })];
    }
    case "fence":
      if (a.length !== 0 && a.length !== 2) fail("fence takes no operands or pred, succ (e.g. fence rw, rw)");
      return [R("fence", { imm: a.length === 0 ? 0x0ff : (fenceSet(a[0]) << 4) | fenceSet(a[1]) })];
    case "jal":
      if (a.length === 1) return [R("jal", { rd: 1, imm: branchOffset(a[0], ctx, 21) })];
      need(a, 2, "jal rd, label");
      return [R("jal", { rd: reg(a[0]), imm: branchOffset(a[1], ctx, 21) })];
    case "jalr":
      if (a.length === 1) return [R("jalr", { rd: 1, rs1: reg(a[0]), imm: 0 })];
      if (a.length === 3) {
        return [R("jalr", { rd: reg(a[0]), rs1: reg(a[1]), imm: checkRange(E(a[2]), -2048, 2047, "immediate") })];
      }
      break;
  }

  const def = BY_MNEMONIC.get(op);
  if (!def) return fail(`unknown instruction "${op}"`);
  const imm12 = (v: number) =>
    checkRange(v, -2048, 2047, "immediate", v > 2047 || v < -2048 ? "; it needs 12 bits signed — use li to build large constants" : "");
  switch (def.syntax) {
    case "rd,rs1,rs2": need(a, 3, `${op} rd, rs1, rs2`); return [{ def, rd: reg(a[0]), rs1: reg(a[1]), rs2: reg(a[2]) }];
    case "rd,rs1,imm": need(a, 3, `${op} rd, rs1, imm`); return [{ def, rd: reg(a[0]), rs1: reg(a[1]), imm: imm12(E(a[2])) }];
    case "rd,rs1,shamt":
      need(a, 3, `${op} rd, rs1, shamt`);
      return [{ def, rd: reg(a[0]), rs1: reg(a[1]), imm: checkRange(E(a[2]), 0, 31, "shift amount") }];
    case "rd,imm(rs1)": {
      need(a, 2, `${op} rd, imm(rs1)`);
      const m = memOperand(a[1], ctx);
      return [{ def, rd: reg(a[0]), rs1: m.rs1, imm: imm12(m.imm ?? 0) }];
    }
    case "rs2,imm(rs1)": {
      need(a, 2, `${op} rs2, imm(rs1)`);
      const m = memOperand(a[1], ctx);
      return [{ def, rs2: reg(a[0]), rs1: m.rs1, imm: imm12(m.imm ?? 0) }];
    }
    case "rs1,rs2,label":
      need(a, 3, `${op} rs1, rs2, label`);
      return [{ def, rs1: reg(a[0]), rs2: reg(a[1]), imm: branchOffset(a[2], ctx, 13) }];
    case "rd,imm20": {
      need(a, 2, `${op} rd, imm`);
      const v = checkRange(E(a[1]), -0x80000, 0xfffff, "upper immediate", " (20 bits)");
      return [{ def, rd: reg(a[0]), imm: (v & 0xfffff) << 12 }];
    }
    case "rd,label": need(a, 2, `${op} rd, label`); return [{ def, rd: reg(a[0]), imm: branchOffset(a[1], ctx, 21) }];
    case "none": need(a, 0, op); return [{ def }];
    case "fence": return [{ def, imm: 0x0ff }];
  }
}

function fenceSet(s: string): number {
  const t = s.toLowerCase();
  if (!/^[iorw]+$/.test(t)) fail(`fence set "${s}" must use letters i, o, r, w`);
  return (t.includes("i") ? 8 : 0) | (t.includes("o") ? 4 : 0) | (t.includes("r") ? 2 : 0) | (t.includes("w") ? 1 : 0);
}

const PSEUDOS = new Set([
  "nop", "li", "la", "mv", "not", "neg", "seqz", "snez", "sltz", "sgtz", "beqz", "bnez", "blez", "bgez", "bltz", "bgtz",
  "bgt", "ble", "bgtu", "bleu", "j", "jr", "ret", "call", "tail",
]);

export const isPseudo = (op: string): boolean => PSEUDOS.has(op);
export const PSEUDO_LIST = [...PSEUDOS];

// ───────────────────────── assembler ─────────────────────────

type Section = "text" | "data";

function dataBytes(op: string, args: string[], ctx: Ctx, offsetInData: number): number[] {
  const out: number[] = [];
  const pushN = (v: number, n: number) => {
    for (let i = 0; i < n; i++) out.push((v >>> (8 * i)) & 0xff);
  };
  switch (op) {
    case ".byte": for (const x of args) pushN(evalExpr(x, ctx) ?? 0, 1); break;
    case ".half": case ".short": for (const x of args) pushN(evalExpr(x, ctx) ?? 0, 2); break;
    case ".word": case ".long": for (const x of args) pushN(evalExpr(x, ctx) ?? 0, 4); break;
    case ".string": case ".asciz": case ".ascii":
      for (const x of args) {
        const m = x.match(/^"((?:[^"\\]|\\.)*)"$/);
        if (!m) fail(`${op} expects a quoted string`);
        for (const ch of unescape(m![1])) out.push(ch.charCodeAt(0) & 0xff);
        if (op !== ".ascii") out.push(0);
      }
      break;
    case ".zero": case ".space": {
      const n = evalExpr(args[0] ?? "", { ...ctx, final: true })!;
      checkRange(n, 0, 1 << 20, `${op} size`);
      for (let i = 0; i < n; i++) out.push(0);
      break;
    }
    case ".align": case ".p2align": case ".balign": {
      const n = evalExpr(args[0] ?? "", { ...ctx, final: true })!;
      const align = op === ".balign" ? n : 2 ** n;
      while ((offsetInData + out.length) % align !== 0) out.push(0);
      break;
    }
  }
  return out;
}

const DATA_DIRECTIVES = new Set([".byte", ".half", ".short", ".word", ".long", ".string", ".asciz", ".ascii", ".zero", ".space", ".align", ".p2align", ".balign"]);
const IGNORED_DIRECTIVES = new Set([".globl", ".global", ".type", ".size", ".file", ".option", ".attribute", ".ident", ".section"]);

export function assemble(src: string): Program {
  const stmts = parseLines(src);
  const errors: AsmError[] = [];
  const symbols = new Map<string, number>();
  const equs = new Map<string, number>();
  const pcrelHi = new Map<number, number>();
  const sizes = new Map<Stmt, number>();
  const err = (line: number, e: unknown) => {
    if (e instanceof AsmFail) errors.push({ line, message: e.message });
    else throw e;
  };

  const sectionOf = (st: Stmt, cur: Section): Section => {
    if (st.op === ".text") return "text";
    if (st.op === ".data" || st.op === ".rodata" || st.op === ".bss" || st.op === ".sdata") return "data";
    if (st.op === ".section") return /text/.test(st.args[0] ?? "") ? "text" : "data";
    return cur;
  };

  // Pass 1: assign addresses to labels.
  let section: Section = "text";
  let tpc = TEXT_BASE;
  let dpc = DATA_BASE;
  for (const st of stmts) {
    section = sectionOf(st, section);
    const ctx: Ctx = { symbols, equs, final: false, pc: tpc, pcrelHi };
    for (const l of st.labels) {
      if (symbols.has(l)) errors.push({ line: st.line, message: `label "${l}" is defined twice` });
      symbols.set(l, section === "text" ? tpc : dpc);
    }
    if (!st.op) continue;
    try {
      if (st.op === ".equ" || st.op === ".set") {
        if (st.args.length !== 2) fail(".equ name, value");
        const v = evalExpr(st.args[1], { ...ctx, final: true })!;
        equs.set(st.args[0], v);
      } else if (DATA_DIRECTIVES.has(st.op)) {
        if (section === "text") {
          if (st.op === ".align" || st.op === ".p2align" || st.op === ".balign") continue;
          fail(`data directive ${st.op} in .text — put data after a .data line`);
        }
        const n = dataBytes(st.op, st.args, ctx, dpc - DATA_BASE).length;
        // Labels on an .align line point after the padding.
        dpc += n;
      } else if (st.op.startsWith(".")) {
        if (![".text", ".data", ".rodata", ".bss", ".sdata"].includes(st.op) && !IGNORED_DIRECTIVES.has(st.op)) {
          fail(`unsupported directive ${st.op}`);
        }
      } else {
        if (section !== "text") fail(`instruction "${st.op}" in a data section — add .text before code`);
        const n = sizeOf(st.op, st.args, ctx);
        sizes.set(st, n);
        tpc += 4 * n;
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
  for (const st of stmts) {
    section = sectionOf(st, section);
    if (!st.op || st.op.startsWith(".")) {
      if (st.op && DATA_DIRECTIVES.has(st.op) && section === "data") {
        try {
          data.push(...dataBytes(st.op, st.args, { symbols, equs, final: true, pc: tpc, pcrelHi }, data.length));
        } catch (e) {
          err(st.line, e);
        }
      }
      continue;
    }
    const n = sizes.get(st);
    if (n === undefined) continue; // failed in pass 1
    try {
      const ctx: Ctx = { symbols, equs, final: true, pc: tpc, pcrelHi };
      // Record %pcrel_hi targets for later %pcrel_lo lookups.
      if (st.op === "auipc" && st.args[1]?.startsWith("%pcrel_hi(")) {
        const inner = st.args[1].slice(10, -1);
        const target = evalExpr(inner, ctx)!;
        for (const l of st.labels) pcrelHi.set(symbols.get(l)!, target);
        pcrelHi.set(tpc, target);
      }
      const reals = expand(st.op, st.args, ctx, n);
      if (reals.length !== n) fail("internal: pseudo-instruction size changed between passes");
      const addrs: number[] = [];
      reals.forEach((r, k) => {
        const word = encode(r.def, r);
        text.push({
          addr: tpc,
          word,
          line: st.line,
          asm: formatReal(r, tpc),
          pseudo: isPseudo(st.op!) || reals.length > 1 || r.def.mnemonic !== st.op
            ? { source: `${st.op} ${st.args.join(", ")}`.trim(), part: k + 1, of: reals.length }
            : undefined,
        });
        addrs.push(tpc);
        tpc += 4;
      });
      lineToAddrs.set(st.line, addrs);
    } catch (e) {
      err(st.line, e);
      tpc += 4 * n;
    }
  }

  const entry = symbols.get("_start") ?? symbols.get("main") ?? TEXT_BASE;
  errors.sort((a, b) => a.line - b.line);
  return { text, textBase: TEXT_BASE, textEnd: tpc, data, dataBase: DATA_BASE, symbols, entry, errors, lineToAddrs };
}

/** Canonical text of a real instruction (branch targets as absolute addresses). */
function formatReal(r: Real, pc: number): string {
  const n = (x?: number) => (x === undefined ? "?" : ABI_NAMES[x]);
  const m = r.def.mnemonic;
  const imm = r.imm ?? 0;
  switch (r.def.syntax) {
    case "rd,rs1,rs2": return `${m} ${n(r.rd)}, ${n(r.rs1)}, ${n(r.rs2)}`;
    case "rd,rs1,imm": case "rd,rs1,shamt": return `${m} ${n(r.rd)}, ${n(r.rs1)}, ${imm}`;
    case "rd,imm(rs1)": return `${m} ${n(r.rd)}, ${imm}(${n(r.rs1)})`;
    case "rs2,imm(rs1)": return `${m} ${n(r.rs2)}, ${imm}(${n(r.rs1)})`;
    case "rs1,rs2,label": return `${m} ${n(r.rs1)}, ${n(r.rs2)}, 0x${((pc + imm) >>> 0).toString(16)}`;
    case "rd,imm20": return `${m} ${n(r.rd)}, 0x${((imm >>> 12) & 0xfffff).toString(16)}`;
    case "rd,label": return `${m} ${n(r.rd)}, 0x${((pc + imm) >>> 0).toString(16)}`;
    case "fence": return imm === 0x0ff ? "fence" : `fence ${imm}`;
    case "none": return m;
  }
}
