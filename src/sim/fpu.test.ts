import { describe, expect, it } from "vitest";
import {
  CANONICAL_NAN, FLAG, RM, describe as fdescribe, fadd, fclass, fcvtFmt, fcvtFromInt, fcvtToInt, fdiv, feq,
  ffma, fle, flt, fmax, fmin, fmul, fromNumber, fsgnj, fsqrt, fsub, toNumber, type FFmt,
} from "./fpu";

const { NX, UF, OF, DZ, NV } = FLAG;
const S = (x: number) => fromNumber("S", x);
const D = (x: number) => fromNumber("D", x);
const enc = (fmt: FFmt, x: number) => fromNumber(fmt, x);

const S_INF = 0x7f800000n;
const S_NINF = 0xff800000n;
const S_SNAN = 0x7f800001n;
const S_QNAN = 0x7fc00000n;
const S_MAX = 0x7f7fffffn;
const S_MINSUB = 0x00000001n;
const S_MINNORM = 0x00800000n;
const D_SNAN = 0x7ff0000000000001n;
const D_INF = 0x7ff0000000000000n;

const hex = (b: bigint) => "0x" + b.toString(16);

/** Deterministic xorshift PRNG. */
function rng(seed: number) {
  let s = BigInt(seed) | 1n;
  const M = (1n << 64n) - 1n;
  return () => {
    s ^= (s << 13n) & M;
    s ^= s >> 7n;
    s ^= (s << 17n) & M;
    return s;
  };
}

/** Random finite-ish double bits with varied exponent profiles. */
function randBits(fmt: FFmt, r: () => bigint): bigint {
  const w = fmt === "S" ? 32n : 64n;
  const fracBits = fmt === "S" ? 23n : 52n;
  const expMax = fmt === "S" ? 0xffn : 0x7ffn;
  const x = r();
  const sign = (x >> 63n) & 1n;
  const frac = r() & ((1n << fracBits) - 1n);
  let exp: bigint;
  switch (Number(x & 7n)) {
    case 0: exp = 0n; break; // subnormal / zero
    case 1: exp = 1n + ((x >> 8n) % 4n); break; // near underflow
    case 2: exp = expMax - 1n - ((x >> 8n) % 4n); break; // near overflow
    case 3: exp = expMax; break; // inf/NaN
    default: exp = (x >> 8n) % expMax;
  }
  return ((sign << (w - 1n)) | (exp << fracBits) | frac);
}

function sameNum(got: number, want: number): boolean {
  return Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want));
}

describe("riscv-tests vectors (rv64uf/rv64ud)", () => {
  const cases: [string, (fmt: FFmt, a: bigint, b: bigint) => { bits: bigint; flags: number }, number, number, number, number][] = [
    ["fadd", (f, a, b) => fadd(f, a, b, RM.RNE), 3.5, 2.5, 1.0, 0],
    ["fadd", (f, a, b) => fadd(f, a, b, RM.RNE), -1234, -1235.1, 1.1, NX],
    ["fadd", (f, a, b) => fadd(f, a, b, RM.RNE), 3.14159265, 3.14159265, 0.00000001, NX], // rv64ud: 3.14159266
    ["fsub", (f, a, b) => fsub(f, a, b, RM.RNE), 1.5, 2.5, 1.0, 0],
    ["fsub", (f, a, b) => fsub(f, a, b, RM.RNE), -1234, -1235.1, -1.1, NX],
    ["fsub", (f, a, b) => fsub(f, a, b, RM.RNE), 3.14159265, 3.14159265, 0.00000001, NX], // rv64ud: 3.14159264
    ["fmul", (f, a, b) => fmul(f, a, b, RM.RNE), 2.5, 2.5, 1.0, 0],
    ["fmul", (f, a, b) => fmul(f, a, b, RM.RNE), 1358.61, -1235.1, -1.1, NX],
    ["fmul", (f, a, b) => fmul(f, a, b, RM.RNE), 3.14159265e-8, 3.14159265, 0.00000001, NX],
    ["fdiv", (f, a, b) => fdiv(f, a, b, RM.RNE), 1.1557273520668288, 3.14159265, 2.71828182, NX],
    ["fdiv", (f, a, b) => fdiv(f, a, b, RM.RNE), -0.9991093838555584, -1234, 1235.1, NX],
    ["fdiv", (f, a, b) => fdiv(f, a, b, RM.RNE), 3.14159265, 3.14159265, 1.0, 0],
  ];
  for (const fmt of ["S", "D"] as FFmt[]) {
    for (const [name, op, want0, a, b, flags] of cases) {
      it(`${name}.${fmt.toLowerCase()} ${a}, ${b}`, () => {
        let want = want0;
        const r = op(fmt, enc(fmt, a), enc(fmt, b));
        if (fmt === "D" && name === "fadd" && b === 0.00000001) want = 3.14159266;
        if (fmt === "D" && name === "fsub" && b === 0.00000001) want = 3.14159264;
        // The D-suite expected values are decimal literals, not exact doubles; compare to 1e-12 rel.
        const got = toNumber(fmt, r.bits);
        if (fmt === "S") expect(r.bits).toBe(S(want));
        else expect(Math.abs(got - want) <= Math.abs(want) * 1e-12).toBe(true);
        expect(r.flags).toBe(flags);
      });
    }
  }

  it("fsub.s inf - inf is canonical NaN with NV", () => {
    expect(fsub("S", S_INF, S_INF, RM.RNE)).toEqual({ bits: S_QNAN, flags: NV });
    expect(fsub("D", D_INF, D_INF, RM.RNE)).toEqual({ bits: CANONICAL_NAN.D, flags: NV });
  });

  it("fsqrt", () => {
    expect(fsqrt("S", S(3.14159265), RM.RNE)).toEqual({ bits: S(1.7724538498928541), flags: NX });
    expect(fsqrt("S", S(10000), RM.RNE)).toEqual({ bits: S(100), flags: 0 });
    expect(fsqrt("S", S(-1.0), RM.RNE)).toEqual({ bits: S_QNAN, flags: NV });
    expect(fsqrt("S", S(171.0), RM.RNE)).toEqual({ bits: S(13.076696), flags: NX });
    expect(fsqrt("D", D(3.14159265), RM.RNE)).toEqual({ bits: D(1.7724538498928541), flags: NX });
    expect(fsqrt("D", D(10000), RM.RNE)).toEqual({ bits: D(100), flags: 0 });
    expect(fsqrt("D", D(-1.0), RM.RNE)).toEqual({ bits: CANONICAL_NAN.D, flags: NV });
    expect(fsqrt("D", D(171.0), RM.RNE)).toEqual({ bits: D(13.076696830622021), flags: NX });
    expect(fsqrt("D", D(1.60795e-7), RM.RNE)).toEqual({ bits: D(4.0099251863345283320e-04), flags: NX });
  });

  const fmaCases: [boolean, boolean, number, number, number, number, number][] = [
    // negProduct, negAddend, want, a, b, c, flags
    [false, false, 3.5, 1.0, 2.5, 1.0, 0],
    [false, false, 1236.2, -1.0, -1235.1, 1.1, NX],
    [false, false, -12.0, 2.0, -5.0, -2.0, 0],
    [true, true, -3.5, 1.0, 2.5, 1.0, 0],
    [true, true, -1236.2, -1.0, -1235.1, 1.1, NX],
    [true, true, 12.0, 2.0, -5.0, -2.0, 0],
    [false, true, 1.5, 1.0, 2.5, 1.0, 0],
    [false, true, 1234, -1.0, -1235.1, 1.1, NX],
    [false, true, -8.0, 2.0, -5.0, -2.0, 0],
    [true, false, -1.5, 1.0, 2.5, 1.0, 0],
    [true, false, -1234, -1.0, -1235.1, 1.1, NX],
    [true, false, 8.0, 2.0, -5.0, -2.0, 0],
  ];
  for (const [np, na, want, a, b, c, flags] of fmaCases) {
    it(`fma(np=${np}, na=${na}) ${a}*${b}+${c}`, () => {
      expect(ffma("S", S(a), S(b), S(c), RM.RNE, np, na)).toEqual({ bits: S(want), flags });
      const d = ffma("D", D(a), D(b), D(c), RM.RNE, np, na);
      expect(Math.abs(toNumber("D", d.bits) - want) <= Math.abs(want) * 1e-12).toBe(true);
      expect(d.flags).toBe(flags);
    });
  }

  it("fcvt.w.s / fcvt.wu.s (rtz)", () => {
    const w: [number, number, number][] = [
      [-1.1, -1, NX], [-1.0, -1, 0], [-0.9, 0, NX], [0.9, 0, NX], [1.0, 1, 0], [1.1, 1, NX],
      [-3e9, -0x80000000, NV], [3e9, 0x7fffffff, NV],
    ];
    for (const [x, v, fl] of w) expect(fcvtToInt("S", S(x), RM.RTZ, true), `w ${x}`).toEqual({ value: v, flags: fl });
    const wu: [number, number, number][] = [
      [-3.0, 0, NV], [-1.0, 0, NV], [-0.9, 0, NX], [0.9, 0, NX], [1.0, 1, 0], [1.1, 1, NX],
      [-3e9, 0, NV], [3e9, 3000000000 | 0, 0],
    ];
    for (const [x, v, fl] of wu) expect(fcvtToInt("S", S(x), RM.RTZ, false), `wu ${x}`).toEqual({ value: v, flags: fl });
    for (const fmt of ["S", "D"] as FFmt[]) {
      for (const [x, v, fl] of w) expect(fcvtToInt(fmt, enc(fmt, x), RM.RTZ, true)).toEqual({ value: v, flags: fl });
    }
    expect(fcvtToInt("D", D(3e9), RM.RTZ, false)).toEqual({ value: 3000000000 | 0, flags: 0 });
  });

  it("fcvt.w special inputs (NaN, inf)", () => {
    for (const nan of [0xffffffffn, 0x7fffffffn]) {
      expect(fcvtToInt("S", nan, RM.RNE, true)).toEqual({ value: 0x7fffffff, flags: NV });
      expect(fcvtToInt("S", nan, RM.RNE, false)).toEqual({ value: -1, flags: NV });
    }
    expect(fcvtToInt("S", S_NINF, RM.RNE, true)).toEqual({ value: -0x80000000, flags: NV });
    expect(fcvtToInt("S", S_INF, RM.RNE, true)).toEqual({ value: 0x7fffffff, flags: NV });
    expect(fcvtToInt("S", S_NINF, RM.RNE, false)).toEqual({ value: 0, flags: NV });
    expect(fcvtToInt("S", S_INF, RM.RNE, false)).toEqual({ value: -1, flags: NV });
    expect(fcvtToInt("D", D(NaN), RM.RNE, true)).toEqual({ value: 0x7fffffff, flags: NV });
  });

  it("fmin/fmax", () => {
    expect(fmin("S", S(2.5), S(1.0))).toEqual({ bits: S(1.0), flags: 0 });
    expect(fmin("S", S(-1235.1), S(1.1))).toEqual({ bits: S(-1235.1), flags: 0 });
    expect(fmin("S", S(1.1), S(-1235.1))).toEqual({ bits: S(-1235.1), flags: 0 });
    expect(fmin("S", S_QNAN, S(-1235.1))).toEqual({ bits: S(-1235.1), flags: 0 });
    expect(fmin("S", S(-1.0), S(-2.0))).toEqual({ bits: S(-2.0), flags: 0 });
    expect(fmax("S", S(2.5), S(1.0))).toEqual({ bits: S(2.5), flags: 0 });
    expect(fmax("S", S_QNAN, S(-1235.1))).toEqual({ bits: S(-1235.1), flags: 0 });
    expect(fmax("S", S_SNAN, S(1.0))).toEqual({ bits: S(1.0), flags: NV });
    expect(fmax("S", 0xffffffffn, 0x7fffffffn)).toEqual({ bits: S_QNAN, flags: 0 });
    expect(fmin("S", S(-0), S(0))).toEqual({ bits: S(-0), flags: 0 });
    expect(fmin("S", S(0), S(-0))).toEqual({ bits: S(-0), flags: 0 });
    expect(fmax("S", S(-0), S(0))).toEqual({ bits: S(0), flags: 0 });
    expect(fmax("S", S(0), S(-0))).toEqual({ bits: S(0), flags: 0 });
    expect(fmin("D", D_SNAN, D_SNAN)).toEqual({ bits: CANONICAL_NAN.D, flags: NV });
    expect(fmax("D", D(-1e300), D(-Infinity))).toEqual({ bits: D(-1e300), flags: 0 });
  });

  it("feq/flt/fle", () => {
    for (const fmt of ["S", "D"] as FFmt[]) {
      const a = enc(fmt, -1.36);
      const b = enc(fmt, -1.37);
      expect(feq(fmt, a, a)).toEqual({ value: 1, flags: 0 });
      expect(fle(fmt, a, a)).toEqual({ value: 1, flags: 0 });
      expect(flt(fmt, a, a)).toEqual({ value: 0, flags: 0 });
      expect(feq(fmt, b, a)).toEqual({ value: 0, flags: 0 });
      expect(fle(fmt, b, a)).toEqual({ value: 1, flags: 0 });
      expect(flt(fmt, b, a)).toEqual({ value: 1, flags: 0 });
      const q = CANONICAL_NAN[fmt];
      const s = fmt === "S" ? S_SNAN : D_SNAN;
      const z = enc(fmt, 0);
      expect(feq(fmt, q, z)).toEqual({ value: 0, flags: 0 });
      expect(feq(fmt, q, q)).toEqual({ value: 0, flags: 0 });
      expect(feq(fmt, s, z)).toEqual({ value: 0, flags: NV });
      expect(flt(fmt, q, z)).toEqual({ value: 0, flags: NV });
      expect(fle(fmt, q, z)).toEqual({ value: 0, flags: NV });
      expect(feq(fmt, enc(fmt, 0), enc(fmt, -0))).toEqual({ value: 1, flags: 0 });
      expect(flt(fmt, enc(fmt, -0), enc(fmt, 0))).toEqual({ value: 0, flags: 0 });
    }
  });

  it("fclass all 10 classes", () => {
    const s: [bigint, number][] = [
      [0xff800000n, 0], [0xbf800000n, 1], [0x807fffffn, 2], [0x80000000n, 3], [0x00000000n, 4],
      [0x007fffffn, 5], [0x3f800000n, 6], [0x7f800000n, 7], [0x7f800001n, 8], [0x7fc00000n, 9],
    ];
    for (const [b, i] of s) expect(fclass("S", b), hex(b)).toBe(1 << i);
    const d: [bigint, number][] = [
      [0xfff0000000000000n, 0], [0xbff0000000000000n, 1], [0x800fffffffffffffn, 2], [0x8000000000000000n, 3],
      [0n, 4], [0x000fffffffffffffn, 5], [0x3ff0000000000000n, 6], [0x7ff0000000000000n, 7],
      [0x7ff0000000000001n, 8], [0x7ff8000000000000n, 9],
    ];
    for (const [b, i] of d) expect(fclass("D", b), hex(b)).toBe(1 << i);
  });

  it("fcvt.s.w / fcvt.s.wu / fcvt.s.d / fcvt.d.s", () => {
    expect(fcvtFromInt("S", 2, true, RM.RNE)).toEqual({ bits: S(2), flags: 0 });
    expect(fcvtFromInt("S", -2, true, RM.RNE)).toEqual({ bits: S(-2), flags: 0 });
    expect(fcvtFromInt("S", 2, false, RM.RNE)).toEqual({ bits: S(2), flags: 0 });
    expect(fcvtFromInt("S", -2, false, RM.RNE)).toEqual({ bits: S(4.2949673e9), flags: NX });
    expect(fcvtFromInt("D", -2, false, RM.RNE)).toEqual({ bits: D(4294967294), flags: 0 });
    expect(fcvtFromInt("D", -0x80000000, true, RM.RNE)).toEqual({ bits: D(-2147483648), flags: 0 });
    expect(fcvtFromInt("S", 0, true, RM.RDN)).toEqual({ bits: 0n, flags: 0 });
    expect(fcvtFmt("D", "S", D(-1.5), RM.RNE)).toEqual({ bits: S(-1.5), flags: 0 });
    expect(fcvtFmt("S", "D", S(-1.5), RM.RNE)).toEqual({ bits: D(-1.5), flags: 0 });
    expect(fcvtFmt("D", "S", D(1.1), RM.RNE)).toEqual({ bits: S(1.1), flags: NX });
    expect(fcvtFmt("S", "D", S_SNAN, RM.RNE)).toEqual({ bits: CANONICAL_NAN.D, flags: NV });
    expect(fcvtFmt("S", "D", 0xffc12345n, RM.RNE)).toEqual({ bits: CANONICAL_NAN.D, flags: 0 });
    expect(fcvtFmt("D", "S", D_SNAN, RM.RNE)).toEqual({ bits: S_QNAN, flags: NV });
    expect(fcvtFmt("D", "S", D(1e300), RM.RNE)).toEqual({ bits: S_INF, flags: OF | NX });
    expect(fcvtFmt("D", "S", D(1e300), RM.RTZ)).toEqual({ bits: S_MAX, flags: OF | NX });
    expect(fcvtFmt("D", "S", D(-0), RM.RNE)).toEqual({ bits: 0x80000000n, flags: 0 });
    expect(fcvtFmt("D", "S", D(-Infinity), RM.RNE)).toEqual({ bits: S_NINF, flags: 0 });
  });
});

describe("rounding modes", () => {
  it("ties on int->float conversion", () => {
    const t = 2 ** 24 + 1; // halfway between 2^24 and 2^24+2
    const want: Record<number, [number, number]> = {
      [RM.RNE]: [2 ** 24, -(2 ** 24)],
      [RM.RTZ]: [2 ** 24, -(2 ** 24)],
      [RM.RDN]: [2 ** 24, -(2 ** 24 + 2)],
      [RM.RUP]: [2 ** 24 + 2, -(2 ** 24)],
      [RM.RMM]: [2 ** 24 + 2, -(2 ** 24 + 2)],
    };
    for (const rm of [0, 1, 2, 3, 4]) {
      expect(fcvtFromInt("S", t, true, rm), `rm ${rm}`).toEqual({ bits: S(want[rm][0]), flags: NX });
      expect(fcvtFromInt("S", -t, true, rm), `rm ${rm} neg`).toEqual({ bits: S(want[rm][1]), flags: NX });
    }
    // Tie to even goes up when the lower neighbour is odd.
    expect(fcvtFromInt("S", 2 ** 24 + 3, true, RM.RNE).bits).toBe(S(2 ** 24 + 4));
  });

  it("ties on addition (binary64)", () => {
    const one = D(1);
    const halfUlp = D(2 ** -53);
    expect(fadd("D", one, halfUlp, RM.RNE).bits).toBe(one);
    expect(fadd("D", one, halfUlp, RM.RMM).bits).toBe(D(1 + 2 ** -52));
    expect(fadd("D", one, halfUlp, RM.RUP).bits).toBe(D(1 + 2 ** -52));
    expect(fadd("D", one, halfUlp, RM.RDN).bits).toBe(one);
    expect(fadd("D", one, halfUlp, RM.RTZ).bits).toBe(one);
    const odd = D(1 + 2 ** -52);
    expect(fadd("D", odd, halfUlp, RM.RNE).bits).toBe(D(1 + 2 ** -51));
    // Just below 1: ulp is 2^-53, so subtracting 2^-54 is a tie.
    expect(fsub("D", one, D(2 ** -54), RM.RNE).bits).toBe(one);
    expect(fsub("D", one, D(2 ** -54), RM.RTZ).bits).toBe(D(1 - 2 ** -53));
    expect(fsub("D", one, D(2 ** -54), RM.RDN).bits).toBe(D(1 - 2 ** -53));
    expect(fadd("D", D(-1), D(-(2 ** -53)), RM.RDN).bits).toBe(D(-(1 + 2 ** -52)));
    expect(fadd("D", D(-1), D(-(2 ** -53)), RM.RUP).bits).toBe(D(-1));
  });

  it("directed rounding of division", () => {
    const third = 1 / 3;
    expect(fdiv("D", D(1), D(3), RM.RNE)).toEqual({ bits: D(third), flags: NX });
    expect(fdiv("D", D(1), D(3), RM.RTZ).bits).toBe(D(third));
    expect(fdiv("D", D(1), D(3), RM.RDN).bits).toBe(D(third));
    expect(fdiv("D", D(1), D(3), RM.RUP).bits).toBe(D(third) + 1n);
    expect(fdiv("D", D(-1), D(3), RM.RDN).bits).toBe(D(-third) + 1n);
    expect(fdiv("D", D(-1), D(3), RM.RUP).bits).toBe(D(-third));
  });

  it("fcvt to int with RMM, RNE, RDN, RUP", () => {
    expect(fcvtToInt("S", S(-0.5), RM.RNE, true)).toEqual({ value: 0, flags: NX });
    expect(fcvtToInt("S", S(-0.5), RM.RMM, true)).toEqual({ value: -1, flags: NX });
    expect(fcvtToInt("S", S(2.5), RM.RNE, true)).toEqual({ value: 2, flags: NX });
    expect(fcvtToInt("S", S(2.5), RM.RMM, true)).toEqual({ value: 3, flags: NX });
    expect(fcvtToInt("S", S(3.5), RM.RNE, true)).toEqual({ value: 4, flags: NX });
    expect(fcvtToInt("S", S(-2.5), RM.RMM, true)).toEqual({ value: -3, flags: NX });
    expect(fcvtToInt("S", S(-2.1), RM.RDN, true)).toEqual({ value: -3, flags: NX });
    expect(fcvtToInt("S", S(-2.1), RM.RUP, true)).toEqual({ value: -2, flags: NX });
    expect(fcvtToInt("S", S(2.1), RM.RUP, true)).toEqual({ value: 3, flags: NX });
    expect(fcvtToInt("S", S(-0.4), RM.RTZ, false)).toEqual({ value: 0, flags: NX });
    expect(fcvtToInt("S", S(-0.4), RM.RDN, false)).toEqual({ value: 0, flags: NV });
    expect(fcvtToInt("S", S(-0.0), RM.RNE, false)).toEqual({ value: 0, flags: 0 });
    // Rounding up to 2^31 is out of range even though the input is below it.
    expect(fcvtToInt("D", D(2147483647.5), RM.RNE, true)).toEqual({ value: 0x7fffffff, flags: NV });
    expect(fcvtToInt("D", D(2147483647.4), RM.RNE, true)).toEqual({ value: 0x7fffffff, flags: NX });
    expect(fcvtToInt("D", D(-2147483648.4), RM.RNE, true)).toEqual({ value: -0x80000000, flags: NX });
    expect(fcvtToInt("D", D(-2147483648.6), RM.RNE, true)).toEqual({ value: -0x80000000, flags: NV });
    expect(fcvtToInt("D", D(4294967295.4), RM.RTZ, false)).toEqual({ value: -1, flags: NX });
    expect(fcvtToInt("D", D(1e300), RM.RTZ, false)).toEqual({ value: -1, flags: NV });
    expect(fcvtToInt("D", D(5e-324), RM.RUP, true)).toEqual({ value: 1, flags: NX });
  });
});

describe("overflow and underflow", () => {
  it("overflow result depends on rounding mode", () => {
    const two = S(2);
    expect(fmul("S", S_MAX, two, RM.RNE)).toEqual({ bits: S_INF, flags: OF | NX });
    expect(fmul("S", S_MAX, two, RM.RMM)).toEqual({ bits: S_INF, flags: OF | NX });
    expect(fmul("S", S_MAX, two, RM.RTZ)).toEqual({ bits: S_MAX, flags: OF | NX });
    expect(fmul("S", S_MAX, two, RM.RDN)).toEqual({ bits: S_MAX, flags: OF | NX });
    expect(fmul("S", S_MAX, two, RM.RUP)).toEqual({ bits: S_INF, flags: OF | NX });
    const nmax = S_MAX | 0x80000000n;
    expect(fmul("S", nmax, two, RM.RDN)).toEqual({ bits: S_NINF, flags: OF | NX });
    expect(fmul("S", nmax, two, RM.RUP)).toEqual({ bits: nmax, flags: OF | NX });
    expect(fmul("S", nmax, two, RM.RTZ)).toEqual({ bits: nmax, flags: OF | NX });
    // Rounding up into overflow: max + half ulp.
    expect(fadd("S", S_MAX, S(2 ** 103), RM.RNE)).toEqual({ bits: S_INF, flags: OF | NX });
    expect(fadd("S", S_MAX, S(2 ** 102), RM.RNE)).toEqual({ bits: S_MAX, flags: NX });
    expect(fmul("D", D(1e308), D(10), RM.RNE)).toEqual({ bits: D_INF, flags: OF | NX });
  });

  it("exact subnormal results raise nothing", () => {
    expect(fmul("S", S_MINNORM, S(0.5), RM.RNE)).toEqual({ bits: 0x00400000n, flags: 0 });
    expect(fsub("S", S_MINNORM, S_MINSUB, RM.RNE)).toEqual({ bits: 0x007fffffn, flags: 0 });
    expect(fdiv("D", D(2 ** -1022), D(2 ** 52), RM.RNE)).toEqual({ bits: 1n, flags: 0 });
  });

  it("inexact tiny results raise UF|NX", () => {
    expect(fmul("S", S_MINSUB, S(0.5), RM.RNE)).toEqual({ bits: 0n, flags: UF | NX });
    expect(fmul("S", S_MINSUB, S(0.5), RM.RUP)).toEqual({ bits: S_MINSUB, flags: UF | NX });
    expect(fmul("S", S_MINSUB | 0x80000000n, S(0.5), RM.RNE)).toEqual({ bits: 0x80000000n, flags: UF | NX });
    expect(fmul("S", S_MINSUB, S(0.75), RM.RNE)).toEqual({ bits: S_MINSUB, flags: UF | NX });
    expect(fdiv("D", D(5e-324), D(3), RM.RNE)).toEqual({ bits: 0n, flags: UF | NX });
    expect(fmul("D", D(1e-200), D(1e-200), RM.RNE)).toEqual({ bits: 0n, flags: UF | NX });
  });

  it("tininess is detected after rounding", () => {
    // 2^-126 - 2^-151: rounds to 2^-126 with an unbounded exponent too -> not tiny, NX only.
    expect(fcvtFmt("D", "S", D(2 ** -126 - 2 ** -151), RM.RNE)).toEqual({ bits: S_MINNORM, flags: NX });
    // 2^-126 - 2^-150: representable with unbounded exponent (still tiny), rounds up -> UF|NX.
    expect(fcvtFmt("D", "S", D(2 ** -126 - 2 ** -150), RM.RNE)).toEqual({ bits: S_MINNORM, flags: UF | NX });
    // (1 - 2^-24) * 2^-126 = 2^-126 - 2^-150 via fmul.
    expect(fmul("S", 0x3f7fffffn, S_MINNORM, RM.RNE)).toEqual({ bits: S_MINNORM, flags: UF | NX });
    expect(fmul("S", 0x3f7fffffn, S_MINNORM, RM.RTZ)).toEqual({ bits: 0x007fffffn, flags: UF | NX });
    // Value just below 2^-126 that rounds up under RUP in both precisions.
    expect(fcvtFmt("D", "S", D(2 ** -126 - 2 ** -160), RM.RUP)).toEqual({ bits: S_MINNORM, flags: NX });
    expect(fcvtFmt("D", "S", D(2 ** -126 - 2 ** -160), RM.RDN)).toEqual({ bits: 0x007fffffn, flags: UF | NX });
  });
});

describe("special values", () => {
  it("signed zeros", () => {
    const pz = 0n;
    const nz = 0x80000000n;
    expect(fadd("S", pz, nz, RM.RNE).bits).toBe(pz);
    expect(fadd("S", pz, nz, RM.RDN).bits).toBe(nz);
    expect(fadd("S", nz, nz, RM.RNE).bits).toBe(nz);
    expect(fadd("S", nz, nz, RM.RUP).bits).toBe(nz);
    expect(fadd("S", pz, pz, RM.RDN).bits).toBe(pz);
    expect(fadd("S", S(1), S(-1), RM.RNE)).toEqual({ bits: pz, flags: 0 });
    expect(fadd("S", S(1), S(-1), RM.RDN)).toEqual({ bits: nz, flags: 0 });
    expect(fsub("S", S(1), S(1), RM.RTZ).bits).toBe(pz);
    expect(fsub("S", nz, pz, RM.RNE).bits).toBe(nz);
    expect(fmul("S", nz, S(5), RM.RNE).bits).toBe(nz);
    expect(fmul("S", nz, nz, RM.RNE).bits).toBe(pz);
    expect(fdiv("S", pz, S(-3), RM.RNE).bits).toBe(nz);
    expect(fdiv("S", S(3), S_NINF, RM.RNE).bits).toBe(nz);
    expect(fsqrt("S", nz, RM.RNE)).toEqual({ bits: nz, flags: 0 });
    expect(fsqrt("D", 0x8000000000000000n, RM.RNE)).toEqual({ bits: 0x8000000000000000n, flags: 0 });
    // fma: -1*0 + 0 = +0 (RNE) or -0 (RDN); -0 + -0 = -0.
    expect(ffma("S", S(-1), pz, pz, RM.RNE, false, false).bits).toBe(pz);
    expect(ffma("S", S(-1), pz, pz, RM.RDN, false, false).bits).toBe(nz);
    expect(ffma("S", S(-1), pz, nz, RM.RNE, false, false).bits).toBe(nz);
    expect(ffma("S", S(2), S(3), S(-6), RM.RNE, false, false).bits).toBe(pz);
    expect(ffma("S", S(2), S(3), S(-6), RM.RDN, false, false).bits).toBe(nz);
    expect(ffma("S", S(2), S(3), S(6), RM.RNE, true, false).bits).toBe(pz);
  });

  it("NaN handling", () => {
    for (const fmt of ["S", "D"] as FFmt[]) {
      const q = CANONICAL_NAN[fmt];
      const qp = fmt === "S" ? 0xffc0beefn : 0xfff800000000beefn; // payload, negative
      const s = fmt === "S" ? S_SNAN : D_SNAN;
      const one = enc(fmt, 1);
      for (const op of [fadd, fsub, fmul, fdiv]) {
        expect(op(fmt, qp, one, RM.RNE)).toEqual({ bits: q, flags: 0 });
        expect(op(fmt, one, qp, RM.RNE)).toEqual({ bits: q, flags: 0 });
        expect(op(fmt, s, one, RM.RNE)).toEqual({ bits: q, flags: NV });
        expect(op(fmt, qp, s, RM.RNE)).toEqual({ bits: q, flags: NV });
      }
      expect(fsqrt(fmt, qp, RM.RNE)).toEqual({ bits: q, flags: 0 });
      expect(fsqrt(fmt, s, RM.RNE)).toEqual({ bits: q, flags: NV });
      expect(ffma(fmt, one, one, qp, RM.RNE, false, false)).toEqual({ bits: q, flags: 0 });
      expect(ffma(fmt, one, one, s, RM.RNE, false, false)).toEqual({ bits: q, flags: NV });
    }
  });

  it("invalid operations", () => {
    const inf = S_INF;
    const zero = 0n;
    expect(fadd("S", inf, S_NINF, RM.RNE)).toEqual({ bits: S_QNAN, flags: NV });
    expect(fadd("S", inf, inf, RM.RNE)).toEqual({ bits: inf, flags: 0 });
    expect(fadd("S", S_NINF, S(1e30), RM.RNE)).toEqual({ bits: S_NINF, flags: 0 });
    expect(fmul("S", inf, zero, RM.RNE)).toEqual({ bits: S_QNAN, flags: NV });
    expect(fmul("S", inf, S(-2), RM.RNE)).toEqual({ bits: S_NINF, flags: 0 });
    expect(fdiv("S", zero, zero, RM.RNE)).toEqual({ bits: S_QNAN, flags: NV });
    expect(fdiv("S", inf, S_NINF, RM.RNE)).toEqual({ bits: S_QNAN, flags: NV });
    expect(fdiv("S", S(1), zero, RM.RNE)).toEqual({ bits: inf, flags: DZ });
    expect(fdiv("S", S(-1), zero, RM.RNE)).toEqual({ bits: S_NINF, flags: DZ });
    expect(fdiv("S", S(1), 0x80000000n, RM.RNE)).toEqual({ bits: S_NINF, flags: DZ });
    expect(fdiv("S", inf, zero, RM.RNE)).toEqual({ bits: inf, flags: 0 });
    expect(fdiv("D", D(1), 0n, RM.RNE)).toEqual({ bits: D_INF, flags: DZ });
    expect(fsqrt("S", S(-1e-30), RM.RNE)).toEqual({ bits: S_QNAN, flags: NV });
    expect(fsqrt("S", S_NINF, RM.RNE)).toEqual({ bits: S_QNAN, flags: NV });
    expect(fsqrt("S", inf, RM.RNE)).toEqual({ bits: inf, flags: 0 });
    expect(ffma("S", inf, zero, S_QNAN, RM.RNE, false, false)).toEqual({ bits: S_QNAN, flags: NV });
    expect(ffma("S", zero, inf, S(1), RM.RNE, false, false)).toEqual({ bits: S_QNAN, flags: NV });
    expect(ffma("S", inf, S(1), S_NINF, RM.RNE, false, false)).toEqual({ bits: S_QNAN, flags: NV });
    expect(ffma("S", inf, S(1), S_INF, RM.RNE, false, true)).toEqual({ bits: S_QNAN, flags: NV });
    expect(ffma("S", inf, S(1), S_INF, RM.RNE, false, false)).toEqual({ bits: inf, flags: 0 });
    expect(ffma("S", S(1), S(1), S_NINF, RM.RNE, false, false)).toEqual({ bits: S_NINF, flags: 0 });
    expect(ffma("S", inf, S(1), S(1), RM.RNE, true, false)).toEqual({ bits: S_NINF, flags: 0 });
  });

  it("fma rounds once", () => {
    // (1 + 2^-12)^2 - 1 = 2^-11 + 2^-24 exactly; a separate multiply would lose the 2^-24 term.
    const a = S(1 + 2 ** -12);
    expect(ffma("S", a, a, S(-1), RM.RNE, false, false)).toEqual({ bits: S(2 ** -11 + 2 ** -24), flags: 0 });
    expect(fsub("S", fmul("S", a, a, RM.RNE).bits, S(1), RM.RNE).bits).toBe(S(2 ** -11));
    // Huge exponent gap between product and addend: result is the addend, inexact.
    expect(ffma("D", D(1e-300), D(1e-300), D(1), RM.RNE, false, false)).toEqual({ bits: D(1), flags: NX });
    expect(ffma("D", D(1e-300), D(1e-300), D(1), RM.RUP, false, false)).toEqual({ bits: D(1) + 1n, flags: NX });
  });

  it("fsgnj", () => {
    expect(fsgnj("S", S(1), S(-2), "j")).toBe(S(-1));
    expect(fsgnj("S", S(-1), S(2), "j")).toBe(S(1));
    expect(fsgnj("S", S(1), S(-2), "n")).toBe(S(1));
    expect(fsgnj("S", S(1), S(2), "n")).toBe(S(-1));
    expect(fsgnj("S", S(-1), S(-2), "x")).toBe(S(1));
    expect(fsgnj("S", S(-1), S(2), "x")).toBe(S(-1));
    expect(fsgnj("D", D(3), D(-0), "j")).toBe(D(-3));
    expect(fsgnj("S", S_SNAN, S(-1), "j")).toBe(S_SNAN | 0x80000000n); // NaN passes through untouched
  });

  it("helpers", () => {
    expect(toNumber("S", S(1.5))).toBe(1.5);
    expect(toNumber("D", D(Math.PI))).toBe(Math.PI);
    expect(fromNumber("S", 0.1)).toBe(0x3dcccccdn);
    expect(fdescribe("S", 0x3f800000n)).toEqual({ sign: 0, exponent: 127, mantissa: 0n, kind: "normal", value: 1 });
    expect(fdescribe("S", 0x80000001n).kind).toBe("subnormal");
    expect(fdescribe("S", 0x80000000n)).toMatchObject({ sign: 1, kind: "zero" });
    expect(fdescribe("S", S_INF).kind).toBe("inf");
    expect(fdescribe("S", S_QNAN).kind).toBe("qnan");
    expect(fdescribe("D", D_SNAN).kind).toBe("snan");
  });
});

describe("randomized cross-check against native arithmetic (RNE)", () => {
  type Op = "add" | "sub" | "mul" | "div" | "sqrt" | "fma0" | "fma1";
  const native: Record<Op, (x: number, y: number) => number> = {
    add: (x, y) => x + y, sub: (x, y) => x - y, mul: (x, y) => x * y, div: (x, y) => x / y,
    sqrt: (x) => Math.sqrt(x), fma0: (x, y) => x * y, fma1: (x, y) => x + y,
  };
  const ours = (fmt: FFmt, op: Op, a: bigint, b: bigint): bigint => {
    switch (op) {
      case "add": return fadd(fmt, a, b, RM.RNE).bits;
      case "sub": return fsub(fmt, a, b, RM.RNE).bits;
      case "mul": return fmul(fmt, a, b, RM.RNE).bits;
      case "div": return fdiv(fmt, a, b, RM.RNE).bits;
      case "sqrt": return fsqrt(fmt, a, RM.RNE).bits;
      case "fma0": return ffma(fmt, a, b, 0x8000000000000000n >> (fmt === "S" ? 32n : 0n), RM.RNE, false, false).bits;
      case "fma1": return ffma(fmt, a, enc(fmt, 1), b, RM.RNE, false, false).bits;
    }
  };
  const N = 3000;
  for (const fmt of ["D", "S"] as FFmt[]) {
    for (const op of Object.keys(native) as Op[]) {
      it(`${fmt} ${op}`, () => {
        const r = rng(0x9e3779b9 + op.length * 7919 + (fmt === "S" ? 1 : 0));
        for (let i = 0; i < N; i++) {
          const a = randBits(fmt, r);
          let b = randBits(fmt, r);
          // Bias towards nearby exponents for add/sub to exercise cancellation.
          if ((op === "add" || op === "sub") && i % 3 === 0) b = a ^ (r() & (fmt === "S" ? 0x8000ffffn : 0x80000000ffffffffn));
          const x = toNumber(fmt, a);
          const y = toNumber(fmt, b);
          let want = native[op](x, y);
          if (fmt === "S") want = Math.fround(want);
          const got = toNumber(fmt, ours(fmt, op, a, b));
          if (!sameNum(got, want)) {
            throw new Error(`${fmt} ${op}(${hex(a)}, ${hex(b)}) = ${got}, want ${want}`);
          }
        }
      });
    }
  }

  it("binary32 NX flag matches exactness of the double result", () => {
    // For mul and div/sqrt the double result is exact iff the float32 op is; for mul the
    // 48-bit product always fits in a double, so compare Math.fround(x*y) === x*y.
    const r = rng(12345);
    for (let i = 0; i < N; i++) {
      const a = randBits("S", r);
      const b = randBits("S", r);
      const x = toNumber("S", a);
      const y = toNumber("S", b);
      const p = x * y;
      if (!Number.isFinite(p) || Number.isNaN(p)) continue;
      const res = fmul("S", a, b, RM.RNE);
      expect((res.flags & NX) !== 0, `${hex(a)}*${hex(b)}`).toBe(Math.fround(p) !== p);
    }
  });
});
