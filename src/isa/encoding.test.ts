import { describe, expect, it } from "vitest";
import { assemble } from "@/asm/assembler";
import { disassemble } from "@/asm/disasm";
import { decode, encode } from "./encoding";
import { INSTRUCTIONS } from "./instructions";

/** Reference words produced by GNU as (riscv64-unknown-elf-as -march=rv32im). */
const GOLDEN: [string, number][] = [
  ["addi t1, t1, 10", 0x00a30313],
  ["add x5, x6, x7", 0x007302b3],
  ["sub x5, x6, x7", 0x407302b3],
  ["lw x5, 8(x6)", 0x00832283],
  ["sw x5, 8(x6)", 0x00532423],
  ["lbu a0, -1(sp)", 0xfff14503],
  ["lui x5, 0x12345", 0x123452b7],
  ["auipc x5, 0x1", 0x00001297],
  ["srai x5, x6, 3", 0x40335293],
  ["slli a0, a0, 1", 0x00151513],
  ["mul a0, a1, a2", 0x02c58533],
  ["divu a0, a1, a2", 0x02c5d533],
  ["jalr x0, 0(x1)", 0x00008067],
  ["ecall", 0x00000073],
  ["ebreak", 0x00100073],
  ["fence", 0x0ff0000f],
];

describe("encoding", () => {
  it.each(GOLDEN)("%s → golden word", (src, word) => {
    const p = assemble(src);
    expect(p.errors).toEqual([]);
    expect(p.text[0].word >>> 0).toBe(word >>> 0);
  });

  it("encodes PC-relative branches and jumps", () => {
    const p = assemble(`
      beq x5, x6, skip   # +8
      nop
    skip:
      jal ra, skip2      # +8
      nop
    skip2:
      bne x0, x0, skip2  # 0
    back:
      bne zero, zero, skip2  # -4
    `);
    expect(p.errors).toEqual([]);
    expect(p.text.map((t) => t.word >>> 0)).toEqual([0x00628463, 0x00000013, 0x008000ef, 0x00000013, 0x00001063, 0xfe001ee3]);
  });

  it("round-trips every instruction through decode", () => {
    for (const def of INSTRUCTIONS) {
      const ops = { rd: 5, rs1: 6, rs2: 7, imm: def.format === "U" ? 0x12345000 : def.format === "B" || def.format === "J" ? -8 : def.syntax === "rd,rs1,shamt" ? 7 : -3 };
      const w = encode(def, ops);
      const d = decode(w);
      expect(d?.def.mnemonic, def.mnemonic).toBe(def.mnemonic);
      if (def.fixedImm === undefined && def.syntax !== "fence" && def.format !== "R") expect(d!.imm, def.mnemonic).toBe(ops.imm);
    }
  });

  it("disassembles back to the source text", () => {
    const lines = ["addi t1, t1, 10", "lw t0, 8(t1)", "sw t0, -4(sp)", "srai t0, t1, 3", "mulhu a0, a1, a2", "lui t0, 0x12345"];
    for (const l of lines) {
      const w = assemble(l).text[0].word;
      expect(disassemble(w, 0)).toBe(l);
    }
  });

  it("rejects 0x00000000 as illegal", () => {
    expect(decode(0)).toBeUndefined();
  });
});
