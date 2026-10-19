// Adapts preprocessed riscv-tests assembly to LLVM's assembler, which is
// stricter than GNU as in three ways (stdin -> stdout):
//  1. `li` with a 64-bit literal: GNU as keeps the low 32 bits on RV32.
//  2. `.weak sym` followed by `.global sym`: GNU as lets the global win.
//  3. CSR names LLVM 18 does not know (tcontrol).
let src = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (src += c));
process.stdin.on("end", () => {
  const globals = new Set([...src.matchAll(/\.glob(?:a)?l\s+([\w.$]+)/g)].map((m) => m[1]));
  let out = src.replace(/\.weak\s+([\w.$]+)\s*;?/g, (all, sym) => (globals.has(sym) ? "" : all));
  out = out.replace(/\bli\s+([\w]+),\s*(-?0x[0-9a-fA-F]+|-?\d+)\b/g, (all, reg, lit) => {
    const v = BigInt(lit);
    if (v >= -(2n ** 31n) && v < 2n ** 32n) return all;
    return `li ${reg}, 0x${BigInt.asUintN(32, v).toString(16)}`;
  });
  out = out.replace(/\btcontrol\b/g, "0x7a5");
  process.stdout.write(out);
});
