import { decode } from "@/isa/encoding";
import { ABI_NAMES } from "@/isa/registers";

export interface DisasmOptions {
  abi?: boolean;
  /** Address → label, used to name branch and jump targets. */
  labels?: Map<number, string>;
}

/** Disassemble one word. Returns null for an illegal instruction. */
export function disassemble(word: number, pc: number, opts: DisasmOptions = {}): string | null {
  const d = decode(word);
  if (!d) return null;
  const r = (n: number) => (opts.abi === false ? `x${n}` : ABI_NAMES[n]);
  const target = (off: number) => {
    const t = (pc + off) >>> 0;
    return opts.labels?.get(t) ?? `0x${t.toString(16)}`;
  };
  const m = d.def.mnemonic;
  switch (d.def.syntax) {
    case "rd,rs1,rs2": return `${m} ${r(d.rd)}, ${r(d.rs1)}, ${r(d.rs2)}`;
    case "rd,rs1,imm": case "rd,rs1,shamt": return `${m} ${r(d.rd)}, ${r(d.rs1)}, ${d.imm}`;
    case "rd,imm(rs1)": return `${m} ${r(d.rd)}, ${d.imm}(${r(d.rs1)})`;
    case "rs2,imm(rs1)": return `${m} ${r(d.rs2)}, ${d.imm}(${r(d.rs1)})`;
    case "rs1,rs2,label": return `${m} ${r(d.rs1)}, ${r(d.rs2)}, ${target(d.imm)}`;
    case "rd,imm20": return `${m} ${r(d.rd)}, 0x${((d.imm >>> 12) & 0xfffff).toString(16)}`;
    case "rd,label": return `${m} ${r(d.rd)}, ${target(d.imm)}`;
    case "fence": return "fence";
    case "none": return m;
  }
}
