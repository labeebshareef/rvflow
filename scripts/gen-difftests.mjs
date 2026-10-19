// Differential tests against QEMU (an independent RISC-V implementation).
//
// Generates seeded random programs that exercise RV32IMAFDC, Zba/Zbb/Zbc/Zbs,
// Zicsr and the vector subset, builds them with clang, runs them under
// qemu-riscv32 (Linux user mode), and records QEMU's final architectural
// state (integer, FP and vector registers, fcsr, vl/vtype and a data buffer).
// The ELF files and expected outputs are committed to tests/difftest/ so the
// test suite (src/sim/difftest.test.ts) runs without QEMU.
//
//   node scripts/gen-difftests.mjs [count=40] [length=220]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const COUNT = Number(process.argv[2] ?? 40);
const LENGTH = Number(process.argv[3] ?? 220);
const OUT = new URL("../tests/difftest/", import.meta.url).pathname;
const MARCH = "rv32imafdcv_zicsr_zba_zbb_zbc_zbs";
export const QEMU_CPU = "rv32,v=true,vext_spec=v1.0,vlen=128,elen=64,zba=true,zbb=true,zbc=true,zbs=true";

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const X = ["t0", "t1", "t2", "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4", "t5"];
const RMS = ["rne", "rtz", "rdn", "rup", "rmm", "dyn"];
const S_SPECIAL = [0x00000000, 0x80000000, 0x3f800000, 0xbf800000, 0x3fc00000, 0x40490fdb, 0x00000001, 0x00800000, 0x7f7fffff,
  0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 0x4f000000, 0xcf000000, 0x4f800000, 0x3f000000, 0x40200000, 0xc0200000, 0x7149f2ca];
const D_SPECIAL = ["0x0000000000000000", "0x8000000000000000", "0x3ff0000000000000", "0xbff0000000000000", "0x400921fb54442d18",
  "0x0000000000000001", "0x0010000000000000", "0x7fefffffffffffff", "0x7ff0000000000000", "0xfff0000000000000", "0x7ff8000000000000",
  "0x7ff0000000000001", "0x41e0000000000000", "0xc1e0000000100000", "0x41efffffffe00000", "0x3fe0000000000000", "0x4004000000000000",
  "0xc004000000000000", "0x46293e5939a08cea", "0x3e45798ee2308c3a"];

function program(seed) {
  const r = rng(seed * 7919 + 17);
  const int = (n) => Math.floor(r() * n);
  const pick = (a) => a[int(a.length)];
  const x = () => pick(X);
  const f = () => `f${int(32)}`;
  const imm12 = () => pick([0, 1, -1, 2047, -2048, int(4096) - 2048, int(64) - 32]);
  const val32 = () => pick([0, 1, -1, 0x7fffffff, 0x80000000, 0x55555555, 0xaaaaaaaa, int(2 ** 32), int(256), -int(1000)]);
  const lines = [];
  const L = (s) => lines.push(`  ${s}`);
  let label = 0;
  let vsew = 32;
  let vlmul = 1;
  let vconfigured = false;

  L("la s0, buf");
  L("la s1, dump");
  for (const reg of X) L(`li ${reg}, ${val32() | 0}`);
  for (let i = 0; i < 32; i++) {
    if (i % 2) L(`flw f${i}, ${4 * int(S_SPECIAL.length)}(s0)`);
    else L(`fld f${i}, ${256 + 8 * int(D_SPECIAL.length)}(s0)`);
  }
  L(`fsrmi ${int(5)}`);
  L("vsetivli zero, 16, e8, m1, ta, ma");
  L("vle8.v v0, (s0)");

  const vgroup = (avoid = []) => {
    const opts = [];
    for (let v = 0; v < 32; v += vlmul) if (!avoid.some((a) => a >= v && a < v + vlmul)) opts.push(v);
    return pick(opts);
  };

  const gens = {
    alu: () => {
      const op = pick(["add", "sub", "sll", "slt", "sltu", "xor", "srl", "sra", "or", "and", "mul", "mulh", "mulhsu", "mulhu",
        "div", "divu", "rem", "remu", "sh1add", "sh2add", "sh3add", "andn", "orn", "xnor", "max", "maxu", "min", "minu", "rol", "ror",
        "clmul", "clmulh", "clmulr", "bclr", "bext", "binv", "bset"]);
      L(`${op} ${x()}, ${x()}, ${x()}`);
    },
    imm: () => {
      const k = int(4);
      if (k === 0) L(`${pick(["addi", "slti", "sltiu", "xori", "ori", "andi"])} ${x()}, ${x()}, ${imm12()}`);
      else if (k === 1) L(`${pick(["slli", "srli", "srai", "rori", "bclri", "bexti", "binvi", "bseti"])} ${x()}, ${x()}, ${int(32)}`);
      else if (k === 2) L(`${pick(["clz", "ctz", "cpop", "sext.b", "sext.h", "zext.h", "orc.b", "rev8"])} ${x()}, ${x()}`);
      else L(`${pick(["lui", "auipc"])} ${x()}, ${int(0x100000)}`);
    },
    mem: () => {
      const w = pick([1, 2, 4]);
      const misaligned = r() < 0.1;
      const off = int((256 - 8) / w) * w + (misaligned && w > 1 ? 1 : 0);
      if (r() < 0.5) L(`${{ 1: pick(["lb", "lbu"]), 2: pick(["lh", "lhu"]), 4: "lw" }[w]} ${x()}, ${off}(s0)`);
      else L(`${{ 1: "sb", 2: "sh", 4: "sw" }[w]} ${x()}, ${off}(s0)`);
    },
    branch: () => {
      const n = label++;
      L(`${pick(["beq", "bne", "blt", "bge", "bltu", "bgeu"])} ${x()}, ${x()}, 9${n}f`);
      for (let i = 0; i <= int(2); i++) gens.alu();
      lines.push(`9${n}:`);
    },
    jump: () => {
      const n = label++;
      L(`jal ${x()}, 8${n}f`);
      gens.imm();
      lines.push(`8${n}:`);
    },
    amo: () => {
      L(`addi t6, s0, ${4 * int(60)}`);
      const k = int(12);
      if (k === 0) {
        L(`lr.w ${x()}, (t6)`);
        if (r() < 0.6) L(`sc.w ${x()}, ${x()}, (t6)`);
      } else if (k === 1) L(`sc.w ${x()}, ${x()}, (t6)`);
      else L(`${pick(["amoswap.w", "amoadd.w", "amoxor.w", "amoand.w", "amoor.w", "amomin.w", "amomax.w", "amominu.w", "amomaxu.w"])}${pick(["", ".aq", ".rl", ".aqrl"])} ${x()}, ${x()}, (t6)`);
    },
    fp: () => {
      const p = pick(["s", "d"]);
      const rm = pick(RMS);
      const k = int(12);
      if (k <= 2) L(`${pick(["fadd", "fsub", "fmul", "fdiv"])}.${p} ${f()}, ${f()}, ${f()}, ${rm}`);
      else if (k === 3) L(`fsqrt.${p} ${f()}, ${f()}, ${rm}`);
      else if (k === 4) L(`${pick(["fmadd", "fmsub", "fnmsub", "fnmadd"])}.${p} ${f()}, ${f()}, ${f()}, ${f()}, ${rm}`);
      else if (k === 5) L(`${pick(["fsgnj", "fsgnjn", "fsgnjx", "fmin", "fmax"])}.${p} ${f()}, ${f()}, ${f()}`);
      else if (k === 6) L(`${pick(["feq", "flt", "fle"])}.${p} ${x()}, ${f()}, ${f()}`);
      else if (k === 7) L(`fclass.${p} ${x()}, ${f()}`);
      else if (k === 8) L(`fcvt.${pick(["w", "wu"])}.${p} ${x()}, ${f()}, ${rm}`);
      else if (k === 9) L(`fcvt.${p}.${pick(["w", "wu"])} ${f()}, ${x()}, ${rm}`);
      else if (k === 10) L(p === "s" ? `${pick(["fmv.x.w", "fmv.w.x"]) === "fmv.x.w" ? `fmv.x.w ${x()}, ${f()}` : `fmv.w.x ${f()}, ${x()}`}` : `fcvt.${pick(["s.d", "d.s"])} ${f()}, ${f()}, ${rm}`);
      else {
        const off = 8 * int(31);
        L(r() < 0.5 ? `${p === "s" ? "flw" : "fld"} ${f()}, ${off}(s0)` : `${p === "s" ? "fsw" : "fsd"} ${f()}, ${off}(s0)`);
      }
    },
    csr: () => {
      const k = int(4);
      if (k === 0) L(`csrr ${x()}, ${pick(["fflags", "frm", "fcsr"])}`);
      else if (k === 1) L(`fsflagsi ${int(32)}`);
      else if (k === 2) L(`fsrmi ${int(5)}`);
      else {
        // Keep frm legal (≤ 4) so dynamic-rounding instructions stay valid.
        L(`andi t6, ${x()}, 0x9f`);
        L(`csrrw ${x()}, fcsr, t6`);
      }
    },
    vset: () => {
      vsew = pick([8, 16, 32]);
      vlmul = pick([1, 1, 2, 4]);
      vconfigured = true;
      const pol = `${pick(["ta", "tu"])}, ${pick(["ma", "mu"])}`;
      // AVL is kept ≥ 1: with vl = 0, QEMU 8.2 still writes vd[0] of reductions, whereas RVV 1.0
      // (and rvflow) leave the destination untouched, so vl = 0 is not a useful comparison.
      if (r() < 0.5) L(`vsetivli ${x()}, ${1 + int(31)}, e${vsew}, m${vlmul}, ${pol}`);
      else {
        L(`ori t6, ${x()}, 1`);
        L(`vsetvli ${x()}, t6, e${vsew}, m${vlmul}, ${pol}`);
      }
    },
    vec: () => {
      if (!vconfigured) return gens.vset();
      const vm = r() < 0.3 ? ", v0.t" : "";
      const dst = () => (vm ? vgroup([0]) : vgroup());
      const k = int(14);
      if (k <= 4) {
        const op = pick(["vadd", "vsub", "vand", "vor", "vxor", "vminu", "vmin", "vmaxu", "vmax", "vmul", "vmulh", "vmulhu",
          "vdivu", "vdiv", "vremu", "vrem", "vsll", "vsrl", "vsra"]);
        const form = pick(["vv", "vx", ...(["vadd", "vand", "vor", "vxor", "vsll", "vsrl", "vsra"].includes(op) ? ["vi"] : [])]);
        const b = form === "vv" ? `v${vgroup()}` : form === "vx" ? x() : String(op.startsWith("vs") ? int(32) : int(32) - 16);
        L(`${op}.${form} v${dst()}, v${vgroup()}, ${b}${vm}`);
      } else if (k === 5) {
        const op = pick(["vmseq", "vmsne", "vmsltu", "vmslt", "vmsleu", "vmsle", "vmsgtu", "vmsgt"]);
        const src = vgroup();
        const d = pick([...Array(32).keys()].filter((v) => v < src || v >= src + vlmul));
        const form = ["vmsgtu", "vmsgt"].includes(op) ? "vx" : pick(["vv", "vx"]);
        const b = form === "vv" ? `v${vgroup()}` : x();
        if (form === "vv" && vlmul > 1) return L(`${op}.vx v${d}, v${src}, ${x()}`);
        L(`${op}.${form} v${d}, v${src}, ${b}`);
      } else if (k === 6) {
        L(`${pick(["vredsum", "vredand", "vredor", "vredxor", "vredminu", "vredmin", "vredmaxu", "vredmax"])}.vs v${vm ? 1 + int(31) : int(32)}, v${vgroup()}, v${int(32)}${vm}`);
      } else if (k === 7) {
        L(r() < 0.5 ? `vmv.x.s ${x()}, v${int(32)}` : `vmv.s.x v${int(32)}, ${x()}`);
      } else if (k === 8) {
        L(r() < 0.5 ? `vcpop.m ${x()}, v${int(32)}${vm}` : `vfirst.m ${x()}, v${int(32)}${vm}`);
      } else if (k === 9) {
        L(`vid.v v${dst()}${vm}`);
      } else if (k === 10) {
        const src = vgroup();
        const d = vgroup(vm ? [0, ...Array.from({ length: vlmul }, (_, i) => src + i)] : Array.from({ length: vlmul }, (_, i) => src + i));
        L(`${pick(["vslideup", "vslidedown"])}.${pick(["vx", "vi"])} v${d}, v${src}, ${r() < 0.5 ? x() : int(20)}${vm}`.replace(/\.vi (v\d+, v\d+), ([a-z]\w*)/, ".vx $1, $2").replace(/\.vx (v\d+, v\d+), (\d+)/, ".vi $1, $2"));
      } else if (k === 11) {
        const form = pick(["vvm", "vxm", "vim"]);
        const b = form === "vvm" ? `v${vgroup()}` : form === "vxm" ? x() : String(int(32) - 16);
        L(`vmerge.${form} v${vgroup([0])}, v${vgroup()}, ${b}, v0`);
      } else if (k === 12) {
        const op = pick(["vmacc", "vnmsac"]);
        L(`${op}.${pick(["vv", "vx"])} v${dst()}, ${r() < 0.5 ? `v${vgroup()}` : x()}, v${vgroup()}${vm}`.replace(/\.vv (v\d+), ([a-z]\w*),/, ".vx $1, $2,").replace(/\.vx (v\d+), (v\d+),/, ".vv $1, $2,"));
      } else {
        L(`${pick(["vmand", "vmor", "vmxor", "vmandn", "vmorn", "vmnand", "vmnor", "vmxnor"])}.mm v${int(32)}, v${int(32)}, v${int(32)}`);
      }
    },
    vmem: () => {
      if (!vconfigured) return gens.vset();
      const eew = pick([8, 16, 32]);
      const emul = (eew / vsew) * vlmul;
      if (emul < 1 || emul > 8) return gens.vec();
      const grp = () => {
        const o = [];
        for (let v = emul; v < 32; v += emul) o.push(v);
        return pick(o);
      };
      const vm = r() < 0.3 ? ", v0.t" : "";
      if (r() < 0.25 && vlmul === 1) {
        L(`addi t6, s0, ${int(8) * 16}`);
        L(`li a7, ${pick([1, 2, 4, 8]) * (eew / 8)}`);
        L(`${pick(["vlse", "vsse"])}${eew}.v v${grp()}, (t6), a7${vm}`);
        return;
      }
      L(`addi t6, s0, ${int(12) * 16}`);
      L(`${pick(["vle", "vse"])}${eew}.v v${grp()}, (t6)${vm}`);
    },
  };
  const weights = [["alu", 18], ["imm", 14], ["mem", 10], ["branch", 5], ["jump", 2], ["amo", 5], ["fp", 18], ["csr", 4], ["vset", 3], ["vec", 16], ["vmem", 5]];
  const total = weights.reduce((a, [, w]) => a + w, 0);
  for (let i = 0; i < LENGTH; i++) {
    let t = r() * total;
    for (const [name, w] of weights) {
      t -= w;
      if (t < 0) {
        gens[name]();
        break;
      }
    }
  }

  // Dump the architectural state, then write it and the data buffer to stdout.
  L("csrr t6, vl");
  L("sw t6, 0(s1)");
  L("csrr t6, vtype");
  L("sw t6, 4(s1)");
  L("csrr t6, fcsr");
  L("sw t6, 8(s1)");
  for (let i = 1; i < 32; i++) if (![2, 3, 4, 9].includes(i)) L(`sw x${i}, ${12 + 4 * i}(s1)`);
  for (let i = 0; i < 32; i++) L(`fsd f${i}, ${144 + 8 * i}(s1)`);
  L("vsetvli t6, zero, e8, m8, ta, ma");
  for (let i = 0; i < 4; i++) {
    L(`addi t6, s1, ${400 + 128 * i}`);
    L(`vse8.v v${8 * i}, (t6)`);
  }
  L("li a0, 1");
  L("mv a1, s1");
  L("li a2, 912");
  L("li a7, 64");
  L("ecall");
  L("li a0, 1");
  L("mv a1, s0");
  L("li a2, 512");
  L("li a7, 64");
  L("ecall");
  L("li a0, 0");
  L("li a7, 93");
  L("ecall");

  const data = [];
  for (let i = 0; i < 64; i++) data.push(`.word ${S_SPECIAL[i % S_SPECIAL.length]}`);
  for (let i = 0; i < 32; i++) data.push(`.dword ${D_SPECIAL[i % D_SPECIAL.length]}`);
  const rand = [];
  for (let i = 0; i < 128; i++) rand.push(val32() >>> 0);
  return [
    `# rvflow differential test ${seed} (generated by scripts/gen-difftests.mjs)`,
    ".text", ".globl _start", "_start:", ...lines,
    ".data", ".balign 64", "buf:", ...data.map((d) => `  ${d}`), ...rand.map((v) => `  .word ${v}`),
    ".balign 64", "dump:", "  .zero 1024", "",
  ].join("\n");
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const qemuVersion = execFileSync("qemu-riscv32", ["--version"], { encoding: "utf8" }).split("\n")[0];
const manifest = { qemu: qemuVersion, cpu: QEMU_CPU, march: MARCH, tests: [] };
for (let seed = 1; seed <= COUNT; seed++) {
  const name = `diff${String(seed).padStart(3, "0")}`;
  writeFileSync(`${OUT}${name}.S`, program(seed));
  execFileSync("clang", ["--target=riscv32-unknown-elf", `-march=${MARCH}`, "-mabi=ilp32", "-nostdlib", "-static", "-fuse-ld=lld",
    `${OUT}${name}.S`, "-o", `${OUT}${name}.elf`]);
  const out = execFileSync("qemu-riscv32", ["-cpu", QEMU_CPU, `${OUT}${name}.elf`], { stdio: ["ignore", "pipe", "pipe"] });
  if (out.length !== 912 + 512) throw new Error(`${name}: unexpected output length ${out.length}`);
  writeFileSync(`${OUT}${name}.out`, out.toString("hex") + "\n");
  manifest.tests.push(name);
}
writeFileSync(`${OUT}manifest.json`, JSON.stringify(manifest, null, 1) + "\n");
console.log(`generated ${COUNT} differential tests with ${qemuVersion}`);
