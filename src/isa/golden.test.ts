import { describe, expect, it } from "vitest";
import { assemble } from "@/asm/assembler";
import { disassemble } from "@/asm/disasm";
import { decode } from "./encoding";
import { expandC } from "./rvc";
import golden from "./golden.json";
import { INSTRUCTIONS } from "./instructions";

/**
 * Reference encodings produced by llvm-mc (see scripts/gen-golden.mjs).
 * Every instruction row and every compressed form is covered.
 */
const hex = (v: number, n = 8) => `0x${(v >>> 0).toString(16).padStart(n, "0")}`;

describe(`encodings match ${golden.generator}`, () => {
  it.each(golden.base as [string, number][])("%s", (line, word) => {
    const p = assemble(line);
    expect(p.errors).toEqual([]);
    expect(p.text).toHaveLength(1);
    expect(hex(p.text[0].word)).toBe(hex(word));
    // Decode back to the same instruction and re-assemble the disassembly.
    const d = decode(word);
    expect(d, line).toBeDefined();
    expect(d!.def.mnemonic).toBe(line.split(" ")[0].replace(/\.(aqrl|aq|rl)$/, ""));
    const again = assemble(disassemble(word, 0)!);
    expect(again.errors).toEqual([]);
    expect(hex(again.text[0].word)).toBe(hex(word));
  });

  it.each(golden.compressed as [string, number][])("%s", (line, half) => {
    const p = assemble(line);
    expect(p.errors).toEqual([]);
    expect(p.text[0].size).toBe(2);
    expect(hex(p.text[0].word, 4)).toBe(hex(half, 4));
    expect(expandC(half)?.mnemonic).toBe(line.split(" ")[0]);
  });

  it("covers every instruction row", () => {
    const seen = new Set((golden.base as [string, number][]).map(([l]) => l.split(" ")[0].replace(/\.(aqrl|aq|rl)$/, "")));
    expect(INSTRUCTIONS.filter((d) => !seen.has(d.mnemonic)).map((d) => d.mnemonic)).toEqual([]);
  });
});
