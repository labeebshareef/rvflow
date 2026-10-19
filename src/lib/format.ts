/** Number formatting helpers shared by the simulator narration and the UI. */

export const hex32 = (v: number): string => "0x" + (v >>> 0).toString(16).padStart(8, "0").toUpperCase();

export const hex = (v: number, digits = 0): string =>
  "0x" + (v >>> 0).toString(16).toUpperCase().padStart(digits, "0");

export const hexByte = (v: number): string => (v & 0xff).toString(16).padStart(2, "0").toUpperCase();

export const bin = (v: number, width = 32): string => (v >>> 0).toString(2).padStart(width, "0").slice(-width);

/** Binary grouped in nibbles for readability: 0000_0000_… */
export const binGrouped = (v: number, width = 32): string => bin(v, width).replace(/(.{4})(?=.)/g, "$1_");

export const signed = (v: number): number => v | 0;
export const unsigned = (v: number): number => v >>> 0;

export type Radix = "hex" | "dec" | "udec" | "bin";

export function fmtValue(v: number, radix: Radix): string {
  switch (radix) {
    case "hex":
      return hex32(v);
    case "dec":
      return String(v | 0);
    case "udec":
      return String(v >>> 0);
    case "bin":
      return binGrouped(v);
  }
}

/** Compact value for narration: decimal when small, hex otherwise. */
export function friendly(v: number): string {
  const s = v | 0;
  if (s >= -4096 && s <= 4096) return String(s);
  return hex32(v);
}
