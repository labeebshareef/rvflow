import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Cpu } from "./cpu";
import { parseElf } from "./elf";

/**
 * The official riscv-tests, built by scripts/build-riscv-tests.sh. Each test
 * runs bare-metal from reset and reports through the HTIF `tohost` word.
 */
const DIR = new URL("../../tests/riscv-tests/", import.meta.url);
const tests = readdirSync(DIR).filter((f) => f.endsWith(".elf")).sort();

/** Tests that assume hardware support for misaligned loads/stores (Spike's --misaligned). */
const MISALIGNED = new Set(["rv32ui-p-ma_data"]);

/** Tests that need features the simulator deliberately leaves out. */
const EXPECTED_FAIL: Record<string, string> = {
  "rv32si-p-dirty": "needs Sv32 virtual memory (satp is bare-only)",
};

function runElf(file: string, maxSteps = 200_000) {
  const img = parseElf(readFileSync(new URL(file, DIR)));
  const cpu = new Cpu();
  const misaligned = MISALIGNED.has(file.replace(/\.elf$/, ""));
  cpu.reset(img.entry, { env: "bare", misaligned, tohost: img.symbols.get("tohost") });
  for (const s of img.segments) cpu.mem.load(s.addr, s.bytes);
  let steps = 0;
  while (!cpu.halted && steps < maxSteps) {
    cpu.step();
    steps++;
  }
  return { cpu, steps };
}

describe("riscv-tests", () => {
  it("has the ELF fixtures", () => expect(tests.length).toBeGreaterThan(100));
  it.each(tests)("%s", (file) => {
    const name = file.replace(/\.elf$/, "");
    const { cpu, steps } = runElf(file);
    if (EXPECTED_FAIL[name]) {
      expect(cpu.halted?.reason, EXPECTED_FAIL[name]).not.toBe("pass");
      return;
    }
    expect(cpu.halted?.message ?? `no result after ${steps} steps`).toBe("riscv-tests: PASS (tohost = 1).");
  });
});
