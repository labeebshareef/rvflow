import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, STAGES, simulatePipeline, type PipeInstr, type PipeOptions, type PipelineRun } from "./model";

type Spec = Omit<PipeInstr, "seq" | "nextPc" | "srcs" | "dsts"> & Partial<Pick<PipeInstr, "nextPc" | "srcs" | "dsts">>;

/** Build a stream; nextPc defaults to the next instruction's pc (or pc + 4 for the last one). */
function stream(specs: Spec[]): PipeInstr[] {
  return specs.map((s, i) => ({
    srcs: [],
    dsts: [],
    ...s,
    seq: i,
    nextPc: s.nextPc ?? specs[i + 1]?.pc ?? s.pc + 4,
  }));
}

const alu = (pc: number, rd: string, ...srcs: string[]): Spec => ({ pc, text: `add ${rd}`, kind: "alu", dsts: [rd], srcs });
const wp = (pc: number) => `wp@${pc.toString(16)}`;
const opts = (o: Partial<PipeOptions> = {}): PipeOptions => ({ ...DEFAULT_OPTIONS, ...o });
const run = (s: Spec[], o: Partial<PipeOptions> = {}) => simulatePipeline(stream(s), wp, opts(o));

/** Cycle in which a correct-path seq is in a given (non-stalled) stage. */
function cycleOf(r: PipelineRun, seq: number, stage: string): number {
  const row = r.rows.find((x) => x.seq === seq && !x.wrongPath)!;
  return row.cells.find((c) => c.stage === stage)!.cycle;
}

describe("simulatePipeline", () => {
  it("runs N independent ALU instructions in N + 4 cycles", () => {
    for (const n of [1, 5, 12]) {
      const r = run(Array.from({ length: n }, (_, i) => alu(i * 4, `x${i + 1}`)));
      expect(r.complete).toBe(true);
      expect(r.stats.cycles).toBe(n + 4);
      expect(r.stats.cpi).toBeCloseTo((n + 4) / n);
      expect(r.stats.stallCycles).toBe(0);
      expect(r.cycles.at(-1)!.retired).toBe(n);
    }
  });

  it("handles an empty stream", () => {
    const r = run([]);
    expect(r.complete).toBe(true);
    expect(r.cycles).toHaveLength(0);
  });

  it("ALU -> ALU: no stall with forwarding, 2 stalls without", () => {
    const s = [alu(0, "x5"), alu(4, "x6", "x5")];
    const fw = run(s);
    expect(fw.stats.cycles).toBe(6);
    expect(fw.stats.stallCycles).toBe(0);
    const nofw = run(s, { forwarding: false });
    expect(nofw.stats.cycles).toBe(8);
    expect(nofw.stats.dataStalls).toBe(2);
    // The consumer reads the register file in the cycle the producer writes back.
    expect(cycleOf(nofw, 0, "WB")).toBe(5);
    expect(cycleOf(nofw, 1, "EX")).toBe(6);
    expect(nofw.cycles.every((c) => c.forwards.length === 0)).toBe(true);
  });

  it("a producer two ahead needs one stall without forwarding and none with a WB/ID overlap after that", () => {
    const s = [alu(0, "x5"), alu(4, "x7"), alu(8, "x6", "x5")];
    expect(run(s, { forwarding: false }).stats.stallCycles).toBe(1);
    const s3 = [alu(0, "x5"), alu(4, "x7"), alu(8, "x8"), alu(12, "x6", "x5")];
    expect(run(s3, { forwarding: false }).stats.stallCycles).toBe(0);
  });

  it("load-use: 1 stall with forwarding, 2 without", () => {
    const s: Spec[] = [{ pc: 0, text: "lw x5, 0(x1)", kind: "load", srcs: ["x1"], dsts: ["x5"] }, alu(4, "x6", "x5")];
    const fw = run(s);
    expect(fw.stats.cycles).toBe(7);
    expect(fw.stats.loadUseStalls).toBe(1);
    const st = fw.cycles.find((c) => c.stall)!;
    expect(st.stall).toEqual({ row: 1, reason: "load-use" });
    // Next cycle: a bubble in EX, the consumer held in ID.
    const after = fw.cycles[st.cycle];
    expect(after.stages.EX?.bubble).toBe(true);
    expect(after.stages.ID?.stalled).toBe(true);
    // The consumer then gets the loaded value from MEM/WB.
    const f = fw.cycles.flatMap((c) => c.forwards);
    expect(f).toEqual([{ from: "MEM/WB", operand: "rs1", reg: "x5", producerRow: 0, consumerRow: 1, to: "EX" }]);
    const nofw = run(s, { forwarding: false });
    expect(nofw.stats.cycles).toBe(8);
    expect(nofw.stats.loadUseStalls).toBe(2);
  });

  it("load -> store data is forwarded from MEM/WB into MEM without a stall", () => {
    const s: Spec[] = [
      { pc: 0, text: "lw x5, 0(x1)", kind: "load", srcs: ["x1"], dsts: ["x5"] },
      { pc: 4, text: "sw x5, 4(x1)", kind: "store", srcs: ["x1", "x5"] },
    ];
    const r = run(s);
    expect(r.stats.stallCycles).toBe(0);
    expect(r.stats.cycles).toBe(6);
    const f = r.cycles.flatMap((c) => c.forwards.map((x) => ({ ...x, cycle: c.cycle })));
    expect(f).toEqual([{ from: "MEM/WB", operand: "rs2", reg: "x5", producerRow: 0, consumerRow: 1, to: "MEM", cycle: 5 }]);
    // But a load feeding the store's base address stalls.
    const base: Spec[] = [s[0], { pc: 4, text: "sw x2, 0(x5)", kind: "store", srcs: ["x5", "x2"] }];
    expect(run(base).stats.loadUseStalls).toBe(1);
  });

  it("forwarding: EX/MEM vs MEM/WB, the most recent producer wins", () => {
    const r = run([alu(0, "x5"), alu(4, "x6"), alu(8, "x7", "x5", "x6")]);
    const f = r.cycles.flatMap((c) => c.forwards);
    expect(f).toEqual([
      { from: "MEM/WB", operand: "rs1", reg: "x5", producerRow: 0, consumerRow: 2, to: "EX" },
      { from: "EX/MEM", operand: "rs2", reg: "x6", producerRow: 1, consumerRow: 2, to: "EX" },
    ]);
    const both = run([alu(0, "x5"), alu(4, "x5"), alu(8, "x7", "x5")]);
    expect(both.cycles.flatMap((c) => c.forwards)).toEqual([
      { from: "EX/MEM", operand: "rs1", reg: "x5", producerRow: 1, consumerRow: 2, to: "EX" },
    ]);
    expect(both.cycles.some((c) => c.notes.includes("Forward x5 from EX/MEM to rs1 of add x7"))).toBe(true);
  });

  it("a mispredicted taken branch with not-taken prediction costs 2 and squashes 2 wrong-path rows", () => {
    const s: Spec[] = [
      { pc: 0, text: "beq x1, x2, L", kind: "branch", srcs: ["x1", "x2"], taken: true, nextPc: 0x20 },
      alu(0x20, "x5"),
    ];
    const r = run(s, { predictor: "not-taken" });
    expect(r.stats.cycles).toBe(2 + 4 + 2);
    expect(r.stats.mispredicts).toBe(1);
    expect(r.stats.flushes).toBe(1);
    expect(r.stats.squashed).toBe(2);
    const wrong = r.rows.filter((x) => x.wrongPath);
    expect(wrong.map((x) => x.text)).toEqual(["wp@4", "wp@8"]);
    expect(wrong.every((x) => x.cells.at(-1)!.stage === "flush")).toBe(true);
    const fc = r.cycles.find((c) => c.flush)!;
    expect(fc.cycle).toBe(3);
    expect(fc.flush).toEqual({ row: 0, squashedRows: [wrong[0].rowId, wrong[1].rowId], reason: "mispredict" });
    expect(fc.stages.ID?.squashed && fc.stages.IF?.squashed).toBe(true);
    expect(r.cycles[3].stages.IF?.pc).toBe(0x20);
    // A correctly predicted not-taken branch costs nothing.
    const nt = run([{ ...s[0], taken: false, nextPc: 4 }, alu(4, "x5")], { predictor: "not-taken" });
    expect(nt.stats.cycles).toBe(6);
    expect(nt.stats.accuracy).toBe(1);
  });

  it("treats a null wrong-path fetch as a bubble", () => {
    const s = stream([
      { pc: 0, text: "beq", kind: "branch", taken: true, nextPc: 0x20 },
      alu(0x20, "x5"),
    ]);
    const r = simulatePipeline(s, () => null, opts({ predictor: "not-taken" }));
    expect(r.stats.cycles).toBe(8);
    expect(r.rows.filter((x) => x.wrongPath)).toHaveLength(0);
    expect(r.cycles[1].stages.IF?.bubble).toBe(true);
  });

  it("2-bit predictor learns a loop", () => {
    const iters = 10;
    const specs: Spec[] = [];
    for (let i = 0; i < iters; i++) {
      specs.push({ pc: 8, text: "addi x5, x5, -1", kind: "alu", srcs: ["x5"], dsts: ["x5"] });
      const last = i === iters - 1;
      specs.push({ pc: 12, text: "bne x5, x0, loop", kind: "branch", srcs: ["x5"], taken: !last, nextPc: last ? 16 : 8 });
    }
    specs.push(alu(16, "x6"));
    const r = run(specs);
    expect(r.stats.branches).toBe(iters);
    // Cold miss (BTB has no target yet) + loop exit.
    expect(r.stats.mispredicts).toBe(2);
    expect(r.stats.accuracy).toBeCloseTo(0.8);
    expect(r.cycles.at(-1)!.bht![(12 >> 2) & 15]).toBe(2);
    // The branch is forwarded its operand from the addi each iteration: no stalls.
    expect(r.stats.stallCycles).toBe(0);
    const nt = run(specs, { predictor: "not-taken" });
    expect(nt.stats.mispredicts).toBe(iters - 1);
    expect(nt.stats.cycles - r.stats.cycles).toBe(2 * (iters - 1 - 2));
    // Static taken also needs the BTB: the same cold miss and exit.
    expect(run(specs, { predictor: "taken" }).stats.mispredicts).toBe(2);
  });

  it("2-bit hysteresis beats 1-bit on a nested loop", () => {
    const specs: Spec[] = [];
    for (let o = 0; o < 4; o++) {
      for (let i = 0; i < 4; i++) {
        specs.push(alu(8, "x5", "x5"));
        const last = i === 3;
        specs.push({ pc: 12, text: "bne inner", kind: "branch", srcs: ["x5"], taken: !last, nextPc: last ? 16 : 8 });
      }
      specs.push({ pc: 16, text: "j outer", kind: "jal", nextPc: 8 });
    }
    const one = run(specs, { predictor: "1-bit" }).stats.mispredicts;
    const two = run(specs, { predictor: "2-bit" }).stats.mispredicts;
    expect(two).toBeLessThan(one);
  });

  it("jal costs 1 cycle when not predicted, 0 once the BTB knows it", () => {
    const s: Spec[] = [{ pc: 0, text: "jal x1, f", kind: "jal", dsts: ["x1"], nextPc: 0x40 }, alu(0x40, "x5")];
    const r = run(s, { predictor: "not-taken" });
    expect(r.stats.cycles).toBe(7);
    const fc = r.cycles.find((c) => c.flush)!;
    expect(fc.cycle).toBe(2);
    expect(fc.flush!.reason).toBe("jump");
    expect(fc.flush!.squashedRows).toHaveLength(1);
    // "j ." three times: the 2nd and 3rd hit the BTB with 2-bit, not with not-taken.
    const spin: Spec[] = [0, 1, 2].map(() => ({ pc: 0, text: "j .", kind: "jal", nextPc: 0 }));
    expect(run(spin, { predictor: "not-taken" }).stats.cycles).toBe(3 + 4 + 2);
    expect(run(spin).stats.cycles).toBe(3 + 4 + 1);
  });

  it("jalr resolves in EX: 2-cycle penalty", () => {
    const r = run([{ pc: 0, text: "jalr x0, 0(x1)", kind: "jalr", srcs: ["x1"], nextPc: 0x40 }, alu(0x40, "x5")]);
    expect(r.stats.cycles).toBe(8);
    expect(r.cycles.find((c) => c.flush)!.flush).toMatchObject({ reason: "jump", row: 0 });
    expect(r.stats.squashed).toBe(2);
  });

  it("serializing instructions flush everything younger at EX", () => {
    const s: Spec[] = [
      { pc: 0, text: "ecall", kind: "system", nextPc: 0x100, serializing: true },
      alu(0x100, "x5"),
    ];
    const r = run(s);
    expect(r.stats.cycles).toBe(8);
    const fc = r.cycles.find((c) => c.flush)!;
    expect(fc.cycle).toBe(3);
    expect(fc.flush!.reason).toBe("serialize");
    // Even when the next PC is pc + 4 (fence.i).
    const fence = run([{ pc: 0, text: "fence.i", kind: "system", serializing: true }, alu(4, "x5")]);
    expect(fence.stats.cycles).toBe(8);
    // Every stream instruction appears exactly once on the correct path.
    expect(r.rows.filter((x) => !x.wrongPath).map((x) => x.seq)).toEqual([0, 1]);
  });

  it("multi-cycle mul stalls younger instructions", () => {
    const s: Spec[] = [{ pc: 0, text: "mul x5, x6, x7", kind: "mul", srcs: ["x6", "x7"], dsts: ["x5"] }, alu(4, "x8"), alu(8, "x9", "x5")];
    expect(run(s).stats.cycles).toBe(7);
    const r = run(s, { mulLatency: 4 });
    expect(r.stats.cycles).toBe(7 + 3);
    expect(r.stats.stallCycles).toBe(3);
    expect(r.cycles.filter((c) => c.stall?.reason === "multi-cycle")).toHaveLength(3);
    const mulRow = r.rows[0];
    expect(mulRow.cells.filter((c) => c.stage === "EX")).toHaveLength(4);
    // A bubble follows the mul into MEM while it is busy.
    expect(r.cycles[3].stages.MEM?.bubble).toBe(true);
    // div latency applies to div only.
    expect(run([{ ...s[0], kind: "div" }, s[1], s[2]], { mulLatency: 4, divLatency: 2 }).stats.cycles).toBe(8);
  });

  it("stops at maxCycles with complete = false", () => {
    const r = simulatePipeline(stream(Array.from({ length: 50 }, (_, i) => alu(i * 4, "x5"))), wp, DEFAULT_OPTIONS, 10);
    expect(r.complete).toBe(false);
    expect(r.cycles).toHaveLength(10);
  });

  it("row cells are consistent with cycle states and correct-path order is preserved", () => {
    const specs: Spec[] = [
      { pc: 0, text: "lw x5, 0(x1)", kind: "load", srcs: ["x1"], dsts: ["x5"] },
      { pc: 4, text: "beq x5, x0, L", kind: "branch", srcs: ["x5"], taken: true, nextPc: 0x20 },
      { pc: 0x20, text: "mul x6, x5, x5", kind: "mul", srcs: ["x5", "x5"], dsts: ["x6"] },
      { pc: 0x24, text: "jal x0, M", kind: "jal", nextPc: 0x40 },
      { pc: 0x40, text: "sw x6, 0(x1)", kind: "store", srcs: ["x1", "x6"] },
      { pc: 0x44, text: "ecall", kind: "system", serializing: true, nextPc: 0x80 },
      alu(0x80, "x7", "x6"),
    ];
    for (const forwarding of [true, false]) {
      for (const predictor of ["not-taken", "taken", "1-bit", "2-bit"] as const) {
        const r = run(specs, { forwarding, predictor, mulLatency: 3 });
        expect(r.complete).toBe(true);
        const correct = r.rows.filter((x) => !x.wrongPath);
        expect(correct.map((x) => x.seq)).toEqual(specs.map((_, i) => i));
        // Fetch order and WB order follow program order.
        const wb = correct.map((x) => x.cells.find((c) => c.stage === "WB")!.cycle);
        expect([...wb].sort((a, b) => a - b)).toEqual(wb);
        expect(new Set(wb).size).toBe(wb.length);
        expect(r.rows.filter((x) => x.wrongPath).every((x) => x.cells.at(-1)!.stage === "flush")).toBe(true);
        // Each cycle's occupied slots match exactly one cell of their row.
        const seen = new Map<number, number>();
        for (const c of r.cycles) {
          for (const s of STAGES) {
            const slot = c.stages[s];
            if (!slot || slot.rowId < 0) continue;
            const cell = r.rows[slot.rowId].cells.find((x) => x.cycle === c.cycle)!;
            expect(cell.stage).toBe(slot.squashed ? "flush" : slot.stalled ? "stall" : s);
            seen.set(slot.rowId, (seen.get(slot.rowId) ?? 0) + 1);
          }
        }
        for (const row of r.rows) expect(seen.get(row.rowId)).toBe(row.cells.length);
        expect(r.stats.cycles).toBe(r.cycles.length);
        expect(r.cycles.at(-1)!.stages.WB?.seq).toBe(specs.length - 1);
      }
    }
  });
});
