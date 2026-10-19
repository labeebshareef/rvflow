/** Default memory map for programs assembled in the app (RARS "compact, text at 0"). */
export const TEXT_BASE = 0x00000000;
export const DATA_BASE = 0x00010000;
export const STACK_TOP = 0x0003fff0;

/** Core-local interruptor (CLINT): memory-mapped timer and software interrupt. */
export const CLINT = {
  BASE: 0x02000000,
  MSIP: 0x02000000,
  MTIMECMP: 0x02004000,
  MTIME: 0x0200bff8,
  END: 0x02010000,
} as const;
