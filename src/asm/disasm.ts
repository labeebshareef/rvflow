import { decode, type Decoded } from "@/isa/encoding";
import type { InstrDef } from "@/isa/instructions";
import { csrName } from "@/isa/csr";
import { ABI_NAMES, FP_ABI_NAMES } from "@/isa/registers";
import { expandC } from "@/isa/rvc";

export interface DisasmOptions {
  abi?: boolean;
  /** Address → label, used to name branch and jump targets. */
  labels?: Map<number, string>;
}

const RM_NAMES = ["rne", "rtz", "rdn", "rup", "rmm", "rm5", "rm6", "dyn"];

/** Format vtype immediate bits as "e32, m1, ta, ma". */
export function formatVtype(v: number): string {
  const lmul = ["m1", "m2", "m4", "m8", "m?", "mf8", "mf4", "mf2"][v & 7];
  const sew = `e${8 << ((v >> 3) & 7)}`;
  return `${sew}, ${lmul}, ${v & 0x40 ? "ta" : "tu"}, ${v & 0x80 ? "ma" : "mu"}`;
}

/** Print an instruction from its definition and field values, following its operand syntax. */
export function formatInstr(def: InstrDef, f: Record<string, number>, pc: number, opts: DisasmOptions = {}): string {
  const x = (n: number) => (opts.abi === false ? `x${n}` : ABI_NAMES[n]);
  const fr = (n: number) => (opts.abi === false ? `f${n}` : FP_ABI_NAMES[n]);
  const target = (off: number) => {
    const t = (pc + off) >>> 0;
    return opts.labels?.get(t) ?? `0x${t.toString(16)}`;
  };
  const imm = f.imm ?? 0;
  const out: string[] = [];
  for (const raw of def.syntax ? def.syntax.split(",") : []) {
    const tok = raw.replace(/\?$/, "");
    const optional = raw.endsWith("?");
    switch (tok) {
      case "rd": case "rs1": case "rs2": case "rs3":
        if (optional && !f[tok]) break;
        out.push(x(f[tok] ?? 0));
        break;
      case "fd": out.push(fr(f.rd)); break;
      case "fs1": out.push(fr(f.rs1)); break;
      case "fs2": out.push(fr(f.rs2)); break;
      case "fs3": out.push(fr(f.rs3)); break;
      case "vd": case "vs1": case "vs2": case "vs3": out.push(`v${f[tok]}`); break;
      case "imm": out.push(String(imm)); break;
      case "uimm20": out.push(`0x${((imm >>> 12) & 0xfffff).toString(16)}`); break;
      case "offB": case "offJ": out.push(target(imm)); break;
      case "mem": case "memS": out.push(`${imm}(${x(f.rs1)})`); break;
      case "(rs1)": out.push(`(${x(f.rs1)})`); break;
      case "shamt": out.push(String(f.shamt)); break;
      case "csr": out.push(csrName(f.csr)); break;
      case "zimm": out.push(String(f.zimm)); break;
      case "simm5": out.push(String(f.simm5)); break;
      case "uimm5": out.push(String(f.uimm5)); break;
      case "vtypei": out.push(formatVtype(f.vtypei)); break;
      case "v0": out.push("v0"); break;
      case "rm": {
        const rm = f.funct3;
        if (rm !== (def.defaultRm ?? 7)) out.push(RM_NAMES[rm]);
        break;
      }
      case "vm": if (f.vm === 0) out.push("v0.t"); break;
      case "pred": case "succ": {
        const set = (v: number) => (v & 8 ? "i" : "") + (v & 4 ? "o" : "") + (v & 2 ? "r" : "") + (v & 1 ? "w" : "") || "0";
        if (!(f.pred === 15 && f.succ === 15)) out.push(set(f[tok]));
        break;
      }
    }
  }
  let m = def.mnemonic;
  if (def.animClass === "AMO" || def.animClass === "LR" || def.animClass === "SC") {
    m += f.aq && f.rl ? ".aqrl" : f.aq ? ".aq" : f.rl ? ".rl" : "";
  }
  return out.length ? `${m} ${out.join(", ")}` : m;
}

/** Disassemble one 32-bit word. Returns null for an illegal instruction. */
export function disassemble(word: number, pc: number, opts: DisasmOptions = {}): string | null {
  const d = decode(word);
  return d ? formatInstr(d.def, d.f, pc, opts) : null;
}

/** Disassemble a 16-bit compressed instruction as "c.addi a0, 1  (addi a0, a0, 1)". */
export function disassembleC(half: number, pc: number, opts: DisasmOptions = {}): { c: string; expanded: string } | null {
  const e = expandC(half);
  if (!e) return null;
  const d = decode(e.word) as Decoded;
  const expanded = formatInstr(d.def, d.f, pc, opts);
  const args = expanded.includes(" ") ? expanded.slice(expanded.indexOf(" ") + 1) : "";
  return { c: `${e.mnemonic}${args ? ` ${cArgs(e.mnemonic, args)}` : ""}`, expanded };
}

/** Compressed forms omit the operands they imply (rd = rs1, x0, sp). */
function cArgs(m: string, args: string): string {
  const a = args.split(", ");
  switch (m) {
    case "c.addi": case "c.andi": case "c.srli": case "c.srai": case "c.slli": return `${a[0]}, ${a[2]}`;
    case "c.li": return `${a[0]}, ${a[2]}`;
    case "c.addi16sp": return `sp, ${a[2]}`;
    case "c.addi4spn": return `${a[0]}, sp, ${a[2]}`;
    case "c.mv": return `${a[0]}, ${a[2]}`;
    case "c.add": case "c.sub": case "c.xor": case "c.or": case "c.and": return `${a[0]}, ${a[2]}`;
    case "c.jr": case "c.jalr": return a[1].replace(/^0\(|\)$/g, "");
    case "c.j": case "c.jal": return a[1];
    case "c.beqz": case "c.bnez": return `${a[0]}, ${a[2]}`;
    case "c.nop": case "c.ebreak": return "";
    default: return args;
  }
}
