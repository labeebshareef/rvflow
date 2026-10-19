/** ABI names for x0–x31, indexed by register number. */
export const ABI_NAMES = [
  "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2",
  "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
  "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7",
  "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6",
] as const;

export const REG_ROLES: string[] = [
  "hardwired zero", "return address", "stack pointer", "global pointer", "thread pointer",
  "temporary", "temporary", "temporary", "saved / frame pointer", "saved",
  "argument / return", "argument / return", "argument", "argument", "argument",
  "argument", "argument", "argument (syscall no.)", "saved", "saved", "saved", "saved",
  "saved", "saved", "saved", "saved", "saved", "saved", "temporary", "temporary",
  "temporary", "temporary",
];

const NAME_TO_NUM = new Map<string, number>();
ABI_NAMES.forEach((n, i) => NAME_TO_NUM.set(n, i));
NAME_TO_NUM.set("fp", 8);
for (let i = 0; i < 32; i++) NAME_TO_NUM.set(`x${i}`, i);

/** Parse a register name (x5, t0, fp…). Returns undefined if it is not a register. */
export function parseRegister(name: string): number | undefined {
  return NAME_TO_NUM.get(name.trim().toLowerCase());
}

export function regName(n: number, abi = true): string {
  return abi ? ABI_NAMES[n] : `x${n}`;
}

/** "t1 (x6)" style label used in narration. */
export function regLabel(n: number): string {
  return `${ABI_NAMES[n]} (x${n})`;
}

/** ABI names for f0–f31. */
export const FP_ABI_NAMES = [
  "ft0", "ft1", "ft2", "ft3", "ft4", "ft5", "ft6", "ft7",
  "fs0", "fs1", "fa0", "fa1", "fa2", "fa3", "fa4", "fa5",
  "fa6", "fa7", "fs2", "fs3", "fs4", "fs5", "fs6", "fs7",
  "fs8", "fs9", "fs10", "fs11", "ft8", "ft9", "ft10", "ft11",
] as const;

const F_NAME_TO_NUM = new Map<string, number>();
FP_ABI_NAMES.forEach((n, i) => F_NAME_TO_NUM.set(n, i));
for (let i = 0; i < 32; i++) F_NAME_TO_NUM.set(`f${i}`, i);

/** Parse an FP register name (f3, fa0, ft11…). */
export function parseFRegister(name: string): number | undefined {
  return F_NAME_TO_NUM.get(name.trim().toLowerCase());
}

/** Parse a vector register name (v0–v31). */
export function parseVRegister(name: string): number | undefined {
  const m = name.trim().toLowerCase().match(/^v(\d{1,2})$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n < 32 ? n : undefined;
}

export function fregName(n: number, abi = true): string {
  return abi ? FP_ABI_NAMES[n] : `f${n}`;
}
