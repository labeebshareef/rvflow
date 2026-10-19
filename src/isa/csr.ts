/** Control and status registers implemented by the simulator (RV32, M/S/U modes). */

export interface CsrInfo {
  addr: number;
  name: string;
  description: string;
}

const C = (addr: number, name: string, description: string): CsrInfo => ({ addr, name, description });

export const CSRS: CsrInfo[] = [
  C(0x001, "fflags", "Accrued FP exception flags: NV DZ OF UF NX"),
  C(0x002, "frm", "Dynamic FP rounding mode"),
  C(0x003, "fcsr", "frm and fflags together"),
  C(0x008, "vstart", "First vector element to process"),
  C(0x009, "vxsat", "Fixed-point saturation flag"),
  C(0x00a, "vxrm", "Fixed-point rounding mode"),
  C(0x00f, "vcsr", "vxrm and vxsat together"),
  C(0xc00, "cycle", "Cycle counter (read-only shadow of mcycle)"),
  C(0xc01, "time", "Real-time counter (mtime)"),
  C(0xc02, "instret", "Instructions retired"),
  C(0xc80, "cycleh", "Upper 32 bits of cycle"),
  C(0xc81, "timeh", "Upper 32 bits of time"),
  C(0xc82, "instreth", "Upper 32 bits of instret"),
  C(0xc20, "vl", "Vector length"),
  C(0xc21, "vtype", "Vector type: vill, vma, vta, vsew, vlmul"),
  C(0xc22, "vlenb", "VLEN in bytes"),
  C(0x100, "sstatus", "Supervisor view of mstatus"),
  C(0x104, "sie", "Supervisor interrupt enable"),
  C(0x105, "stvec", "Supervisor trap vector base"),
  C(0x106, "scounteren", "Counters visible to U-mode"),
  C(0x10a, "senvcfg", "Supervisor environment configuration"),
  C(0x140, "sscratch", "Supervisor scratch register"),
  C(0x141, "sepc", "Supervisor exception PC"),
  C(0x142, "scause", "Supervisor trap cause"),
  C(0x143, "stval", "Supervisor trap value"),
  C(0x144, "sip", "Supervisor interrupt pending"),
  C(0x180, "satp", "Address translation (bare mode only)"),
  C(0xf11, "mvendorid", "Vendor ID (0: non-commercial)"),
  C(0xf12, "marchid", "Architecture ID"),
  C(0xf13, "mimpid", "Implementation ID"),
  C(0xf14, "mhartid", "Hardware thread ID"),
  C(0xf15, "mconfigptr", "Configuration structure pointer"),
  C(0x300, "mstatus", "Machine status: MIE, MPIE, MPP, FS, VS…"),
  C(0x301, "misa", "ISA and extensions"),
  C(0x302, "medeleg", "Exceptions delegated to S-mode"),
  C(0x303, "mideleg", "Interrupts delegated to S-mode"),
  C(0x304, "mie", "Machine interrupt enable"),
  C(0x305, "mtvec", "Machine trap vector base (+ mode)"),
  C(0x306, "mcounteren", "Counters visible to S/U-mode"),
  C(0x30a, "menvcfg", "Machine environment configuration"),
  C(0x310, "mstatush", "Upper half of mstatus"),
  C(0x31a, "menvcfgh", "Upper half of menvcfg"),
  C(0x320, "mcountinhibit", "Stops counters"),
  C(0x340, "mscratch", "Machine scratch register"),
  C(0x341, "mepc", "Machine exception PC"),
  C(0x342, "mcause", "Machine trap cause"),
  C(0x343, "mtval", "Machine trap value"),
  C(0x344, "mip", "Machine interrupt pending"),
  C(0x34a, "mtinst", "Trapped instruction (0)"),
  C(0x34b, "mtval2", "Second trap value (0)"),
  C(0xb00, "mcycle", "Machine cycle counter"),
  C(0xb02, "minstret", "Machine instructions-retired counter"),
  C(0xb80, "mcycleh", "Upper 32 bits of mcycle"),
  C(0xb82, "minstreth", "Upper 32 bits of minstret"),
  C(0x7a0, "tselect", "Debug trigger select (no triggers)"),
  C(0x7a1, "tdata1", "Debug trigger data 1"),
  C(0x7a2, "tdata2", "Debug trigger data 2"),
  C(0x7a3, "tdata3", "Debug trigger data 3"),
  C(0x7a4, "tinfo", "Trigger info"),
];
for (let i = 0; i < 16; i++) CSRS.push(C(0x3a0 + i, `pmpcfg${i}`, "PMP configuration (stored, not enforced)"));
for (let i = 0; i < 64; i++) CSRS.push(C(0x3b0 + i, `pmpaddr${i}`, "PMP address (stored, not enforced)"));
for (let i = 3; i < 32; i++) {
  CSRS.push(C(0xc00 + i, `hpmcounter${i}`, "Hardware performance counter (always 0)"));
  CSRS.push(C(0xc80 + i, `hpmcounter${i}h`, "Upper half of hpmcounter"));
  CSRS.push(C(0xb00 + i, `mhpmcounter${i}`, "Machine performance counter (always 0)"));
  CSRS.push(C(0xb80 + i, `mhpmcounter${i}h`, "Upper half of mhpmcounter"));
  CSRS.push(C(0x320 + i, `mhpmevent${i}`, "Performance event selector (always 0)"));
}

export const CSR_BY_ADDR = new Map(CSRS.map((c) => [c.addr, c]));
export const CSR_BY_NAME = new Map(CSRS.map((c) => [c.name, c]));

export function csrName(addr: number): string {
  return CSR_BY_ADDR.get(addr)?.name ?? `0x${addr.toString(16).padStart(3, "0")}`;
}

export const CAUSES: Record<number, string> = {
  0: "instruction address misaligned", 1: "instruction access fault", 2: "illegal instruction", 3: "breakpoint",
  4: "load address misaligned", 5: "load access fault", 6: "store/AMO address misaligned", 7: "store/AMO access fault",
  8: "environment call from U-mode", 9: "environment call from S-mode", 11: "environment call from M-mode",
  12: "instruction page fault", 13: "load page fault", 15: "store/AMO page fault",
};

export const INTERRUPTS: Record<number, string> = {
  1: "supervisor software interrupt", 3: "machine software interrupt", 5: "supervisor timer interrupt",
  7: "machine timer interrupt", 9: "supervisor external interrupt", 11: "machine external interrupt",
};

/** mstatus bit positions. */
export const MSTATUS = {
  SIE: 1 << 1, MIE: 1 << 3, SPIE: 1 << 5, UBE: 1 << 6, MPIE: 1 << 7, SPP: 1 << 8, VS: 3 << 9, MPP: 3 << 11, FS: 3 << 13,
  XS: 3 << 15, MPRV: 1 << 17, SUM: 1 << 18, MXR: 1 << 19, TVM: 1 << 20, TW: 1 << 21, TSR: 1 << 22, SD: 1 << 31,
} as const;

export const PRIV_NAMES = ["U", "S", "H", "M"] as const;
export type Priv = 0 | 1 | 3;
