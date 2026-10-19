import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assemble } from "@/asm/assembler";
import { compileTimeline } from "@/anim/choreography";
import { Cpu } from "@/sim/cpu";

describe("self-test program", () => {
  it("assembles, runs and passes every check", () => {
    const src = readFileSync(new URL("./selftest.s", import.meta.url), "utf8");
    const p = assemble(src);
    expect(p.errors).toEqual([]);
    const cpu = new Cpu();
    cpu.reset(p.entry);
    for (const t of p.text) cpu.mem.write(t.addr, 4, t.word);
    cpu.mem.load(p.dataBase, p.data);
    cpu.textEnd = p.textEnd;
    let steps = 0;
    while (!cpu.halted && steps < 200_000) {
      const rec = cpu.step();
      for (const s of compileTimeline(rec)) for (const pk of s.packets) expect(/^[\x20-\x7e]*$/.test(pk.label)).toBe(true);
      steps++;
    }
    console.log(cpu.output, `\n${p.text.length} instructions, ${steps} executed`);
    expect(cpu.output).toContain("passed: 47  failed: 0");
    expect(cpu.halted).toMatchObject({ reason: "exit", code: 0 });
  });
});
