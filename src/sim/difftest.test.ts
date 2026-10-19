import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ABI_NAMES } from "@/isa/registers";
import { Cpu } from "./cpu";
import { parseElf } from "./elf";

/**
 * Differential tests: random programs whose expected final state was recorded
 * by QEMU (see scripts/gen-difftests.mjs and tests/difftest/manifest.json).
 */
const DIR = new URL("../../tests/difftest/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", DIR), "utf8")) as { qemu: string; tests: string[] };

function run(name: string): string {
  const img = parseElf(readFileSync(new URL(`${name}.elf`, DIR)));
  const cpu = new Cpu();
  cpu.reset(img.entry, { env: "linux", misaligned: true });
  for (const s of img.segments) cpu.mem.load(s.addr, s.bytes);
  for (let i = 0; i < 100_000 && !cpu.halted; i++) cpu.step();
  if (cpu.halted?.reason !== "exit") throw new Error(`${name}: ${cpu.halted?.message ?? "did not finish"}`);
  return Array.from(cpu.output, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

/** Name the state element at a byte offset of the dump, for readable failures. */
function where(byte: number): string {
  if (byte < 4) return "vl";
  if (byte < 8) return "vtype";
  if (byte < 12) return "fcsr";
  if (byte < 144) return `x${(byte - 12) >> 2} (${ABI_NAMES[(byte - 12) >> 2]})`;
  if (byte < 400) return `f${(byte - 144) >> 3}`;
  if (byte < 912) return `v${(byte - 400) >> 4} byte ${(byte - 400) & 15}`;
  return `buf+${byte - 912}`;
}

describe(`matches ${manifest.qemu}`, () => {
  it.each(manifest.tests)("%s", (name) => {
    const want = readFileSync(new URL(`${name}.out`, DIR), "utf8").trim();
    const got = run(name);
    if (got !== want) {
      const diffs: string[] = [];
      for (let b = 0; b < want.length / 2 && diffs.length < 8; b++) {
        if (got.slice(2 * b, 2 * b + 2) !== want.slice(2 * b, 2 * b + 2)) {
          const w = b & ~3;
          diffs.push(`${where(b)}: got ${got.slice(2 * w, 2 * w + 8)} want ${want.slice(2 * w, 2 * w + 8)}`);
          b = w + 3;
        }
      }
      expect.fail(`${name} differs from QEMU:\n${diffs.join("\n")}`);
    }
  });
});
