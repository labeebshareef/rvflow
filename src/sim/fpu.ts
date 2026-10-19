/**
 * IEEE-754 binary32/binary64 arithmetic for the RISC-V F and D extensions.
 *
 * Values are raw bit patterns held in bigints (binary32 uses the low 32 bits; NaN-boxing is the
 * caller's job). Every operation is computed exactly with BigInt and then rounded once by `round`,
 * so results and fflags are correctly rounded in all five RISC-V rounding modes.
 */

export type FFmt = "S" | "D";

/** rm field encodings. 7 (DYN) must be resolved to frm by the caller. */
export const RM = { RNE: 0, RTZ: 1, RDN: 2, RUP: 3, RMM: 4 } as const;

/** fflags bits. */
export const FLAG = { NX: 1, UF: 2, OF: 4, DZ: 8, NV: 16 } as const;

export interface FResult { bits: bigint; flags: number }

export const CANONICAL_NAN: Record<FFmt, bigint> = { S: 0x7fc00000n, D: 0x7ff8000000000000n };

interface FmtInfo {
  width: number;
  fracBits: number;
  bias: number;
  /** All-ones biased exponent (inf/NaN). */
  expMax: number;
  /** Precision in bits, including the hidden bit. */
  p: number;
  mask: bigint;
  signBit: bigint;
  hidden: bigint;
}

function info(width: number, expBits: number, fracBits: number): FmtInfo {
  return {
    width, fracBits, bias: (1 << (expBits - 1)) - 1, expMax: (1 << expBits) - 1, p: fracBits + 1,
    mask: (1n << BigInt(width)) - 1n, signBit: 1n << BigInt(width - 1), hidden: 1n << BigInt(fracBits),
  };
}

const INFO: Record<FFmt, FmtInfo> = { S: info(32, 8, 23), D: info(64, 11, 52) };

type Kind = "zero" | "finite" | "inf" | "nan";

/** Exact decoded value: (-1)^sign * sig * 2^exp for finite numbers. */
interface Unpacked { sign: number; kind: Kind; sig: bigint; exp: number; snan: boolean }

function unpack(fmt: FFmt, bits: bigint): Unpacked {
  const f = INFO[fmt];
  bits &= f.mask;
  const sign = (bits & f.signBit) !== 0n ? 1 : 0;
  const biased = Number((bits >> BigInt(f.fracBits)) & BigInt(f.expMax));
  const frac = bits & (f.hidden - 1n);
  const eminLsb = 1 - f.bias - f.fracBits;
  if (biased === f.expMax) {
    if (frac === 0n) return { sign, kind: "inf", sig: 0n, exp: 0, snan: false };
    return { sign, kind: "nan", sig: 0n, exp: 0, snan: (frac & (f.hidden >> 1n)) === 0n };
  }
  if (biased === 0) {
    return { sign, kind: frac === 0n ? "zero" : "finite", sig: frac, exp: eminLsb, snan: false };
  }
  return { sign, kind: "finite", sig: frac | f.hidden, exp: biased - f.bias - f.fracBits, snan: false };
}

function bitLen(x: bigint): number {
  return x === 0n ? 0 : x.toString(2).length;
}

function pack(f: FmtInfo, sign: number, biased: number, frac: bigint): bigint {
  return (sign ? f.signBit : 0n) | (BigInt(biased) << BigInt(f.fracBits)) | frac;
}

const zeroBits = (f: FmtInfo, sign: number) => (sign ? f.signBit : 0n);
const infBits = (f: FmtInfo, sign: number) => pack(f, sign, f.expMax, 0n);

/** Drop `shift` low bits of `sig`, rounding per `rm`. shift <= 0 scales up exactly. */
function roundShift(sig: bigint, shift: number, sign: number, rm: number): { m: bigint; inexact: boolean } {
  if (shift <= 0) return { m: sig << BigInt(-shift), inexact: false };
  const s = BigInt(shift);
  const q = sig >> s;
  const rem = sig - (q << s);
  if (rem === 0n) return { m: q, inexact: false };
  const half = 1n << (s - 1n);
  let up: boolean;
  switch (rm) {
    case RM.RTZ: up = false; break;
    case RM.RDN: up = sign === 1; break;
    case RM.RUP: up = sign === 0; break;
    case RM.RMM: up = rem >= half; break;
    default: up = rem > half || (rem === half && (q & 1n) === 1n);
  }
  return { m: up ? q + 1n : q, inexact: true };
}

function overflow(f: FmtInfo, sign: number, rm: number): FResult {
  const toInf = rm === RM.RTZ ? false : rm === RM.RDN ? sign === 1 : rm === RM.RUP ? sign === 0 : true;
  const bits = toInf ? infBits(f, sign) : pack(f, sign, f.expMax - 1, f.hidden - 1n);
  return { bits, flags: FLAG.OF | FLAG.NX };
}

/**
 * Round the exact value (-1)^sign * sig * 2^exp to `fmt`. Callers that truncated their value must
 * append a sticky 1 bit below at least p+2 significant bits so the rounding decision is unaffected.
 */
function round(fmt: FFmt, sign: number, sig: bigint, exp: number, rm: number): FResult {
  const f = INFO[fmt];
  if (sig === 0n) return { bits: zeroBits(f, sign), flags: 0 };
  const e = exp + bitLen(sig) - 1; // value in [2^e, 2^(e+1))
  const emin = 1 - f.bias;
  let lsb = Math.max(e, emin) - f.fracBits;
  const r = roundShift(sig, lsb - exp, sign, rm);
  let m = r.m;
  let flags = r.inexact ? FLAG.NX : 0;
  if (m >> BigInt(f.p)) { m >>= 1n; lsb++; } // rounding carried into a new bit (exact shift)
  // Tininess is detected after rounding: round to p bits with unbounded exponent, check < 2^emin.
  if (r.inexact && e < emin) {
    let tiny = true;
    if (e === emin - 1) tiny = roundShift(sig, e - f.fracBits - exp, sign, rm).m < 1n << BigInt(f.p);
    if (tiny) flags |= FLAG.UF;
  }
  let biased = 0;
  let frac = m;
  if (m >= f.hidden) { biased = lsb + f.fracBits + f.bias; frac = m - f.hidden; }
  if (biased >= f.expMax) return overflow(f, sign, rm);
  return { bits: pack(f, sign, biased, frac), flags };
}

/** NaN result if any operand is NaN (canonical; NV when any is signaling), else null. */
function nanCheck(fmt: FFmt, ...ops: Unpacked[]): FResult | null {
  if (!ops.some((o) => o.kind === "nan")) return null;
  return { bits: CANONICAL_NAN[fmt], flags: ops.some((o) => o.snan) ? FLAG.NV : 0 };
}

const invalid = (fmt: FFmt): FResult => ({ bits: CANONICAL_NAN[fmt], flags: FLAG.NV });

/** Exact sum of two finite values followed by one rounding. */
function addExact(fmt: FFmt, s1: number, m1: bigint, e1: number, s2: number, m2: bigint, e2: number, rm: number): FResult {
  const e = Math.min(e1, e2);
  const a = m1 << BigInt(e1 - e);
  const b = m2 << BigInt(e2 - e);
  const sum = (s1 ? -a : a) + (s2 ? -b : b);
  if (sum === 0n) {
    const sign = s1 === s2 ? s1 : rm === RM.RDN ? 1 : 0;
    return { bits: zeroBits(INFO[fmt], sign), flags: 0 };
  }
  return sum < 0n ? round(fmt, 1, -sum, e, rm) : round(fmt, 0, sum, e, rm);
}

export function fadd(fmt: FFmt, a: bigint, b: bigint, rm: number): FResult {
  const f = INFO[fmt];
  const A = unpack(fmt, a);
  const B = unpack(fmt, b);
  const n = nanCheck(fmt, A, B);
  if (n) return n;
  if (A.kind === "inf" && B.kind === "inf" && A.sign !== B.sign) return invalid(fmt);
  if (A.kind === "inf") return { bits: infBits(f, A.sign), flags: 0 };
  if (B.kind === "inf") return { bits: infBits(f, B.sign), flags: 0 };
  return addExact(fmt, A.sign, A.sig, A.exp, B.sign, B.sig, B.exp, rm);
}

export function fsub(fmt: FFmt, a: bigint, b: bigint, rm: number): FResult {
  return fadd(fmt, a, (b & INFO[fmt].mask) ^ INFO[fmt].signBit, rm);
}

export function fmul(fmt: FFmt, a: bigint, b: bigint, rm: number): FResult {
  const f = INFO[fmt];
  const A = unpack(fmt, a);
  const B = unpack(fmt, b);
  const n = nanCheck(fmt, A, B);
  if (n) return n;
  const sign = A.sign ^ B.sign;
  if ((A.kind === "inf" && B.kind === "zero") || (A.kind === "zero" && B.kind === "inf")) return invalid(fmt);
  if (A.kind === "inf" || B.kind === "inf") return { bits: infBits(f, sign), flags: 0 };
  return round(fmt, sign, A.sig * B.sig, A.exp + B.exp, rm);
}

/** Shift a finite nonzero significand left so it has exactly p bits. */
function normalize(f: FmtInfo, u: Unpacked): { sig: bigint; exp: number } {
  const s = f.p - bitLen(u.sig);
  return { sig: u.sig << BigInt(s), exp: u.exp - s };
}

export function fdiv(fmt: FFmt, a: bigint, b: bigint, rm: number): FResult {
  const f = INFO[fmt];
  const A = unpack(fmt, a);
  const B = unpack(fmt, b);
  const n = nanCheck(fmt, A, B);
  if (n) return n;
  const sign = A.sign ^ B.sign;
  if ((A.kind === "inf" && B.kind === "inf") || (A.kind === "zero" && B.kind === "zero")) return invalid(fmt);
  if (A.kind === "inf") return { bits: infBits(f, sign), flags: 0 };
  if (B.kind === "inf" || A.kind === "zero") return { bits: zeroBits(f, sign), flags: 0 };
  if (B.kind === "zero") return { bits: infBits(f, sign), flags: FLAG.DZ };
  const x = normalize(f, A);
  const y = normalize(f, B);
  const k = f.p + 3; // quotient gets >= p+3 bits
  const num = x.sig << BigInt(k);
  const q = num / y.sig;
  const sticky = num % y.sig !== 0n ? 1n : 0n;
  return round(fmt, sign, (q << 1n) | sticky, x.exp - y.exp - k - 1, rm);
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((bitLen(n) >> 1) + 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

export function fsqrt(fmt: FFmt, a: bigint, rm: number): FResult {
  const f = INFO[fmt];
  const A = unpack(fmt, a);
  const n = nanCheck(fmt, A);
  if (n) return n;
  if (A.kind === "zero") return { bits: zeroBits(f, A.sign), flags: 0 };
  if (A.sign) return invalid(fmt);
  if (A.kind === "inf") return { bits: infBits(f, 0), flags: 0 };
  let { sig, exp } = normalize(f, A);
  if (exp % 2 !== 0) { sig <<= 1n; exp -= 1; }
  const k = f.p + 3; // root gets >= p+3 bits
  const s = sig << BigInt(2 * k);
  const r = isqrt(s);
  const sticky = s !== r * r ? 1n : 0n;
  return round(fmt, 0, (r << 1n) | sticky, (exp - 2 * k) / 2 - 1, rm);
}

/** Fused a*b+c with a single rounding. negProduct/negAddend select fmadd/fmsub/fnmsub/fnmadd:
 *  fmadd: (a*b)+c  fmsub: (a*b)-c  fnmsub: -(a*b)+c  fnmadd: -(a*b)-c */
export function ffma(fmt: FFmt, a: bigint, b: bigint, c: bigint, rm: number, negProduct: boolean, negAddend: boolean): FResult {
  const f = INFO[fmt];
  const A = unpack(fmt, a);
  const B = unpack(fmt, b);
  const C = unpack(fmt, c);
  // inf*0 is invalid even when the addend is a quiet NaN.
  if ((A.kind === "inf" && B.kind === "zero") || (A.kind === "zero" && B.kind === "inf")) return invalid(fmt);
  const n = nanCheck(fmt, A, B, C);
  if (n) return n;
  const ps = A.sign ^ B.sign ^ (negProduct ? 1 : 0);
  const cs = C.sign ^ (negAddend ? 1 : 0);
  if (A.kind === "inf" || B.kind === "inf") {
    if (C.kind === "inf" && cs !== ps) return invalid(fmt);
    return { bits: infBits(f, ps), flags: 0 };
  }
  if (C.kind === "inf") return { bits: infBits(f, cs), flags: 0 };
  return addExact(fmt, ps, A.sig * B.sig, A.exp + B.exp, cs, C.sig, C.exp, rm);
}

/** Total-order key for non-NaN values (both zeros map to 0). */
function key(fmt: FFmt, bits: bigint): bigint {
  const f = INFO[fmt];
  const mag = bits & (f.signBit - 1n);
  return bits & f.signBit ? -mag : mag;
}

function minMax(fmt: FFmt, a: bigint, b: bigint, max: boolean): FResult {
  const f = INFO[fmt];
  a &= f.mask;
  b &= f.mask;
  const A = unpack(fmt, a);
  const B = unpack(fmt, b);
  const flags = A.snan || B.snan ? FLAG.NV : 0;
  if (A.kind === "nan" && B.kind === "nan") return { bits: CANONICAL_NAN[fmt], flags };
  if (A.kind === "nan") return { bits: b, flags };
  if (B.kind === "nan") return { bits: a, flags };
  const ka = key(fmt, a);
  const kb = key(fmt, b);
  if (ka === kb) return { bits: (A.sign === 1) !== max ? a : b, flags }; // -0 < +0
  return { bits: (ka < kb) !== max ? a : b, flags };
}

/** minimumNumber semantics (RISC-V 2.2+): NaN operands are ignored, -0 < +0. */
export function fmin(fmt: FFmt, a: bigint, b: bigint): FResult {
  return minMax(fmt, a, b, false);
}

export function fmax(fmt: FFmt, a: bigint, b: bigint): FResult {
  return minMax(fmt, a, b, true);
}

function compare(fmt: FFmt, a: bigint, b: bigint, quiet: boolean, test: (ka: bigint, kb: bigint) => boolean) {
  a &= INFO[fmt].mask;
  b &= INFO[fmt].mask;
  const A = unpack(fmt, a);
  const B = unpack(fmt, b);
  if (A.kind === "nan" || B.kind === "nan") {
    return { value: 0, flags: !quiet || A.snan || B.snan ? FLAG.NV : 0 };
  }
  return { value: test(key(fmt, a), key(fmt, b)) ? 1 : 0, flags: 0 };
}

/** Quiet equality: NV only for signaling NaNs. */
export function feq(fmt: FFmt, a: bigint, b: bigint): { value: number; flags: number } {
  return compare(fmt, a, b, true, (x, y) => x === y);
}

/** Signaling less-than: NV for any NaN. */
export function flt(fmt: FFmt, a: bigint, b: bigint): { value: number; flags: number } {
  return compare(fmt, a, b, false, (x, y) => x < y);
}

/** Signaling less-or-equal: NV for any NaN. */
export function fle(fmt: FFmt, a: bigint, b: bigint): { value: number; flags: number } {
  return compare(fmt, a, b, false, (x, y) => x <= y);
}

/** 10-bit RISC-V fclass mask. */
export function fclass(fmt: FFmt, a: bigint): number {
  const f = INFO[fmt];
  const u = unpack(fmt, a);
  if (u.kind === "nan") return u.snan ? 1 << 8 : 1 << 9;
  const sub = u.kind === "finite" && u.sig < f.hidden;
  const i = u.kind === "inf" ? 0 : u.kind === "zero" ? 3 : sub ? 2 : 1;
  return u.sign ? 1 << i : 1 << (7 - i);
}

/** fsgnj / fsgnjn / fsgnjx: magnitude of a with a sign derived from b. */
export function fsgnj(fmt: FFmt, a: bigint, b: bigint, mode: "j" | "n" | "x"): bigint {
  const f = INFO[fmt];
  a &= f.mask;
  const sb = b & f.signBit;
  switch (mode) {
    case "j": return (a & ~f.signBit) | sb;
    case "n": return (a & ~f.signBit) | (sb ^ f.signBit);
    case "x": return a ^ sb;
  }
}

/** Float -> integer (fcvt.w[u].s/d). Returns the 32-bit result as a JS number holding the int32 bit pattern (use |0). RISC-V rules: NaN -> max positive (0x7fffffff / 0xffffffff); out of range saturates; NV raised on invalid; NX when inexact but in range. */
export function fcvtToInt(fmt: FFmt, a: bigint, rm: number, signed: boolean): { value: number; flags: number } {
  const max = signed ? 0x7fffffffn : 0xffffffffn;
  const min = signed ? -0x80000000n : 0n;
  const u = unpack(fmt, a);
  if (u.kind === "nan") return { value: Number(max) | 0, flags: FLAG.NV };
  if (u.kind === "inf") return { value: Number(u.sign ? min : max) | 0, flags: FLAG.NV };
  const r = roundShift(u.sig, -u.exp, u.sign, rm);
  const v = u.sign ? -r.m : r.m;
  if (v > max) return { value: Number(max) | 0, flags: FLAG.NV };
  if (v < min) return { value: Number(min) | 0, flags: FLAG.NV };
  return { value: Number(v) | 0, flags: r.inexact ? FLAG.NX : 0 };
}

/** Integer -> float (fcvt.s/d.w[u]); x is a JS number; interpret as int32 (signed) or uint32 (unsigned). */
export function fcvtFromInt(fmt: FFmt, x: number, signed: boolean, rm: number): FResult {
  const v = BigInt(signed ? x | 0 : x >>> 0);
  return v < 0n ? round(fmt, 1, -v, 0, rm) : round(fmt, 0, v, 0, rm);
}

/** fcvt.s.d / fcvt.d.s. NaN inputs give the canonical NaN of the destination; sNaN raises NV. */
export function fcvtFmt(from: FFmt, to: FFmt, a: bigint, rm: number): FResult {
  const u = unpack(from, a);
  const n = nanCheck(to, u);
  if (n) return n;
  if (u.kind === "inf") return { bits: infBits(INFO[to], u.sign), flags: 0 };
  return round(to, u.sign, u.sig, u.exp, rm);
}

const view = new DataView(new ArrayBuffer(8));

/** Decode to a JS number (binary32 via Float32 conversion, which is exact). */
export function toNumber(fmt: FFmt, bits: bigint): number {
  if (fmt === "S") {
    view.setUint32(0, Number(bits & 0xffffffffn));
    return view.getFloat32(0);
  }
  view.setBigUint64(0, bits & INFO.D.mask);
  return view.getFloat64(0);
}

/** Encode a JS number (binary32 rounds like Math.fround). */
export function fromNumber(fmt: FFmt, x: number): bigint {
  if (fmt === "S") {
    view.setFloat32(0, x);
    return BigInt(view.getUint32(0));
  }
  view.setFloat64(0, x);
  return view.getBigUint64(0);
}

/** Field breakdown for UIs. */
export function describe(fmt: FFmt, bits: bigint): {
  sign: number; exponent: number; mantissa: bigint;
  kind: "zero" | "subnormal" | "normal" | "inf" | "qnan" | "snan"; value: number;
} {
  const f = INFO[fmt];
  bits &= f.mask;
  const u = unpack(fmt, bits);
  const exponent = Number((bits >> BigInt(f.fracBits)) & BigInt(f.expMax));
  const mantissa = bits & (f.hidden - 1n);
  const kind = u.kind === "nan" ? (u.snan ? "snan" : "qnan")
    : u.kind === "finite" ? (exponent === 0 ? "subnormal" : "normal") : u.kind;
  return { sign: u.sign, exponent, mantissa, kind, value: toNumber(fmt, bits) };
}
