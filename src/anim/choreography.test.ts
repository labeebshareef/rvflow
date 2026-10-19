import { describe, expect, it } from "vitest";
import { assemble } from "@/asm/assembler";
import { parseRegister } from "@/isa/registers";
import { EXAMPLES } from "@/lessons/examples";
import { Cpu } from "@/sim/cpu";
import { WIRE_BY_ID, UNIT_BY_ID } from "@/scene/layout";
import { CHOREO, compileTimeline } from "./choreography";

function runExample(src: string, setup: Record<string, number> = {}) {
  const p = assemble(src);
  expect(p.errors).toEqual([]);
  const cpu = new Cpu();
  cpu.reset(p.entry);
  for (const t of p.text) cpu.mem.write(t.addr, t.size, t.word);
  cpu.mem.load(p.dataBase, p.data);
  cpu.textEnd = p.textEnd;
  for (const [k, v] of Object.entries(setup)) cpu.regs[parseRegister(k)!] = v;
  const recs = [];
  for (let i = 0; i < 5000 && !cpu.halted; i++) recs.push(cpu.step());
  return { cpu, recs };
}

describe("choreography", () => {
  it("compiles the blueprint's addi example into the documented segments", () => {
    const { recs } = runExample("addi t1, t1, 10", { t1: 32 });
    const segs = compileTimeline(recs[0], "addi t1, t1, 10");
    expect(segs.map((s) => s.id)).toEqual(CHOREO.I_ALU);
    expect(segs[0].narration).toContain("0x00A30313");
    expect(segs.find((s) => s.id === "execute")!.narration).toBe("32 + 10 = 42.");
    expect(segs.find((s) => s.id === "writeBack")!.narration).toBe("t1 ← 42 (was 32).");
    expect(segs.find((s) => s.id === "memory")!.narration).toBe("No memory access.");
  });

  it.each(EXAMPLES.map((e) => [e.id, e] as const))("lesson %s runs and every segment references real wires/units", (_, ex) => {
    const { cpu, recs } = runExample(ex.source, ex.setup);
    if (ex.id === "bug") expect(cpu.halted?.reason).toBe("trap");
    else expect(cpu.halted?.reason === "trap").toBe(false);
    for (const rec of recs) {
      const segs = compileTimeline(rec);
      if (rec.events.length) expect(segs.length).toBeGreaterThan(0);
      for (const s of segs) {
        for (const w of s.wires) expect(WIRE_BY_ID.has(w), w).toBe(true);
        for (const u of s.units) expect(UNIT_BY_ID.has(u), u).toBe(true);
        for (const p of s.packets) {
          expect(WIRE_BY_ID.has(p.wire), p.wire).toBe(true);
          // 3D labels use a Latin-only font; anything else triggers a remote font fetch.
          expect(/^[\x20-\x7e]*$/.test(p.label), p.label).toBe(true);
        }
        expect(s.narration.length).toBeGreaterThan(3);
      }
    }
  });

  it("produces the expected output for the program lessons", () => {
    const out = (id: string) => runExample(EXAMPLES.find((e) => e.id === id)!.source).cpu.output;
    expect(out("loop")).toBe("55");
    expect(out("fib")).toBe("0 1 1 2 3 5 8 13 21 34 55 89 ");
    expect(out("call")).toBe("120");
    expect(out("hello")).toBe("Hello, RISC-V!\n");
    expect(out("trap")).toBe("40");
    expect(out("timer")).toBe("3");
    expect(out("umode")).toBe("0x00000828");
    expect(out("float")).toBe("0.30000000000000004");
    expect(out("vadd")).toBe("110");
    expect(out("vdot")).toBe("120");
    expect(out("atomics")).toBe("5");
    expect(out("bits")).toBe("400");
    expect(out("rvc")).toBe("30");
    expect(out("hazards")).toBe("126");
  });

  it("asks predict questions with the right answers", () => {
    const { recs } = runExample("li t0, 1\nli t1, 2\nblt t0, t1, end\nnop\nend: add zero, t0, t1");
    const br = compileTimeline(recs[2]).find((s) => s.id === "pcUpdate")!;
    expect(br.predict?.answer).toBe("taken");
    const wb = compileTimeline(recs[3]).find((s) => s.id === "writeBack")!;
    expect(wb.predict?.answer).toBe("none (x0)");
    expect(wb.narration).toMatch(/zero wall/);
  });

  it("ends the timeline with a trap segment on a misaligned load", () => {
    const { recs } = runExample("li t0, 2\nlw a0, 0(t0)");
    const segs = compileTimeline(recs[recs.length - 1]);
    expect(segs[segs.length - 1].id).toBe("trap");
    expect(segs.some((s) => s.id === "writeBack")).toBe(false);
  });
});
