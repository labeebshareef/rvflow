import { beforeEach, describe, expect, it } from "vitest";
import { EXAMPLES } from "@/lessons/examples";
import { cpu, displayedPc, displayedRegs, segmentApplied, useSim } from "./sim";

const ex = (id: string) => EXAMPLES.find((e) => e.id === id)!;

describe("playback store", () => {
  beforeEach(() => {
    useSim.setState({ skipAnimation: false, predictMode: false, pauseEachSegment: true });
    useSim.getState().loadExample(ex("addi"));
  });

  it("applies the example's register setup", () => {
    expect(cpu.regs[6]).toBe(32);
  });

  it("hides the register write until the write-back segment is revealed", () => {
    const s = useSim.getState();
    s.stepSegment(); // executes and starts segment 0
    const st = useSim.getState();
    expect(cpu.regs[6]).toBe(42);
    expect(displayedRegs(st).regs[6]).toBe(32);
    expect(displayedRegs(st).pending).toBe(6);
    expect(displayedPc(st)).toBe(0);
    const wb = st.segments.findIndex((x) => x.id === "writeBack");
    st.seek(wb, 1);
    expect(segmentApplied(useSim.getState(), "writeBack")).toBe(true);
    expect(displayedRegs(useSim.getState()).regs[6]).toBe(42);
    expect(displayedRegs(useSim.getState()).changed).toBe(6);
  });

  it("steps back through segments and undoes the instruction", () => {
    const s = useSim.getState();
    s.stepSegment();
    s.seek(2, 1);
    s.backSegment();
    expect(useSim.getState().segIndex).toBe(1);
    useSim.getState().seek(0, 0);
    useSim.getState().backSegment();
    expect(useSim.getState().history.length).toBe(0);
    expect(cpu.regs[6]).toBe(32);
    expect(cpu.pc).toBe(0);
  });

  it("pauses at predict questions and scores the answer", () => {
    useSim.setState({ predictMode: true });
    const s = useSim.getState();
    s.stepSegment();
    const wb = useSim.getState().segments.findIndex((x) => x.id === "writeBack");
    useSim.getState().seek(wb - 1, 1);
    useSim.getState().play();
    const p = useSim.getState().predict;
    expect(p?.answer).toBe("t1");
    useSim.getState().answerPredict("t1");
    expect(useSim.getState().score).toEqual({ right: 1, total: 1 });
  });

  it("runs to the end and stops at breakpoints", () => {
    useSim.getState().loadExample(ex("loop"));
    const line = ex("loop").source.split("\n").findIndex((l) => l.includes("li   a7, 1")) + 1;
    useSim.getState().toggleBreakpoint(line);
    useSim.getState().runToEnd();
    expect(useSim.getState().status).toMatch(/Breakpoint/);
    expect(cpu.regs[10]).toBe(55);
    useSim.getState().toggleBreakpoint(line);
    useSim.getState().runToEnd();
    expect(cpu.output).toBe("55");
    expect(cpu.halted?.reason).toBe("exit");
  });

  it("reports assembler errors without loading", () => {
    useSim.getState().setSource("addi t0, t0");
    expect(useSim.getState().assembleAndLoad()).toBe(false);
    expect(useSim.getState().errors[0].line).toBe(1);
  });
});
