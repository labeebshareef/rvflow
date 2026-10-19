// Generates src/isa/golden.json: reference encodings from llvm-mc for every
// instruction row, with varied operands. Run: node scripts/gen-golden.mjs
// (needs llvm-mc with the RISC-V target; the output is committed).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { INSTRUCTIONS } = await server.ssrLoadModule("/src/isa/instructions.ts");
const { C_DEFS } = await server.ssrLoadModule("/src/isa/rvc.ts");
await server.close();

const X = ["a0", "t1", "s2", "sp", "ra", "t6", "a5", "s11"];
const F = ["fa0", "ft1", "fs2", "f31", "fa7", "ft11", "fs0", "f5"];
const XP = ["s0", "a0", "a5", "s1"];
const FP = ["fs0", "fa0", "fa5", "fs1"];
const RMS = ["rtz", "rup", "rdn", "rmm", "rne"];
const CSRS = ["mstatus", "mtvec", "fcsr", "cycle", "sscratch", "0x7c0"];

function operands(syntax, k, mnemonic) {
  if (!syntax) return [""];
  const pick = (arr, j) => arr[(k + j) % arr.length];
  const out = [];
  const variants = [];
  for (const [j, raw] of syntax.split(",").entries()) {
    const tok = raw.replace("?", "");
    const optional = raw.endsWith("?");
    switch (tok) {
      case "rd": case "rs1": case "rs2": case "rs3": out.push(pick(X, j)); break;
      case "fd": case "fs1": case "fs2": case "fs3": out.push(pick(F, j)); break;
      case "vd": case "vs1": case "vs2": case "vs3": out.push(`v${tok === "vd" || tok === "vs3" ? 8 * (1 + (k % 3)) : (k * 4 + j * 8) % 32}`); break;
      case "imm": out.push(String([-2048, 2047, -1, 37][k % 4])); break;
      case "uimm20": out.push(["0x12345", "0xfffff", "0x1", "0x80000"][k % 4]); break;
      case "offB": out.push(String([-4096, 4094, 8, -2][k % 4])); break;
      case "offJ": out.push(String([-1048576, 1048574, 2048, -20][k % 4])); break;
      case "mem": case "memS": out.push(`${[-2048, 2047, 0, -4][k % 4]}(${pick(X, j)})`); break;
      case "(rs1)": out.push(`(${pick(X, j + 1)})`); break;
      case "shamt": out.push(String([0, 31, 7, 16][k % 4])); break;
      case "csr": out.push(pick(CSRS, j)); break;
      case "zimm": out.push(String([0, 31, 5][k % 3])); break;
      case "simm5": out.push(String([-16, 15, -1][k % 3])); break;
      case "uimm5": out.push(String([0, 31, 3][k % 3])); break;
      case "vtypei": out.push(["e32, m1, ta, ma", "e8, m8, tu, mu", "e16, mf2, ta, mu", "e32, m4, tu, ma"][k % 4]); break;
      case "v0": out.push("v0"); break;
      case "rm": if (optional) variants.push("rm"); break;
      case "vm": if (optional) variants.push("vm"); break;
      case "fence": out.push("rw", "io"); break;
    }
  }
  const lines = [out.join(", ")];
  if (variants.includes("rm")) lines.push([...out, pick(RMS, 0)].join(", "));
  if (variants.includes("vm")) lines.push([...out, "v0.t"].join(", "));
  return lines;
}

const lines32 = [];
INSTRUCTIONS.forEach((d, k) => {
  if (d.mnemonic === "sfence.vma") {
    lines32.push("sfence.vma", "sfence.vma a0, a1");
    return;
  }
  for (const ops of operands(d.syntax, k, d.mnemonic)) lines32.push(`${d.mnemonic}${ops ? " " + ops : ""}`.trim());
  if (d.ext === "A") lines32.push(`${d.mnemonic}.aqrl ${operands(d.syntax, k + 1)[0]}`, `${d.mnemonic}.aq ${operands(d.syntax, k + 2)[0]}`);
});

const linesC = [];
C_DEFS.forEach((d, k) => {
  const toks = d.syntax ? d.syntax.split(",") : [];
  const variants = [0, 1].map((v) => toks.map((t) => {
    switch (t) {
      case "rd'": case "rs1'": case "rs2'": return XP[(k + v) % 4];
      case "fd'": case "fs2'": return FP[(k + v) % 4];
      case "rd": case "rs1": case "rs2": return ["a0", "t2", "s3", "ra"][(k + v) % 4];
      case "fd": case "fs2": return ["fa0", "ft3", "fs7", "f30"][(k + v) % 4];
      case "sp": return "sp";
      case "imm": return d.mnemonic === "c.addi16sp" ? ["-512", "496"][v] : ["-32", "31"][v];
      case "uimm": return d.mnemonic === "c.addi4spn" ? ["4", "1020"][v] : ["1", "31"][v];
      case "uimm20": return ["1", "0xfffe0"][v];
      case "mem'": return d.mnemonic.endsWith("d") ? [`0(${XP[k % 4]})`, `248(${XP[(k + 1) % 4]})`][v] : [`0(${XP[k % 4]})`, `124(${XP[(k + 1) % 4]})`][v];
      case "memsp": return d.mnemonic.includes("d") && !d.mnemonic.includes("add") ? ["0(sp)", "504(sp)"][v] : ["0(sp)", "252(sp)"][v];
      case "offB": return ["-256", "254"][v];
      case "offJ": return ["-2048", "2046"][v];
    }
    return "?";
  }).join(", "));
  for (const ops of variants) linesC.push(`${d.mnemonic}${ops ? " " + ops : ""}`);
});

function mc(lines, attrs) {
  const out = execFileSync("llvm-mc", ["-triple=riscv32", `-mattr=${attrs}`, "-show-encoding"], {
    input: lines.join("\n") + "\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  const enc = [...out.matchAll(/encoding: \[([^\]]+)\]/g)].map((m) => m[1].split(",").map((b) => parseInt(b.trim(), 16)));
  if (enc.length !== lines.length) throw new Error(`llvm-mc produced ${enc.length} encodings for ${lines.length} lines`);
  return lines.map((l, i) => [l, enc[i].reduceRight((a, b) => a * 256 + b, 0)]);
}

const base = "+m,+a,+f,+d,+zicsr,+zifencei,+zba,+zbb,+zbc,+zbs,+v";
const golden = { generator: execFileSync("llvm-mc", ["--version"], { encoding: "utf8" }).split("\n").find((l) => /version/.test(l)).trim(),
  base: mc(lines32, base), compressed: mc(linesC, base + ",+c") };
writeFileSync("src/isa/golden.json", JSON.stringify(golden, null, 1) + "\n");
console.log(`wrote ${golden.base.length} + ${golden.compressed.length} reference encodings`);
