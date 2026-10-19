import type { AluOp, BranchOp, Format } from "@/isa/instructions";
import type { Decoded } from "@/isa/encoding";
import type { Priv } from "@/isa/csr";
import type { Control } from "./control";

/**
 * Micro-events: everything the datapath did during one instruction.
 * The animation timeline is compiled from these — never from the instruction itself.
 */
export type MicroEvent =
  | { kind: "FETCH"; pc: number; word: number; size: 2 | 4 }
  | { kind: "EXPAND"; half: number; word: number; mnemonic: string }
  | { kind: "DECODE"; decoded: Decoded; ctrl: Control }
  | { kind: "REG_READ"; port: 1 | 2; reg: number; value: number }
  | { kind: "IMM"; format: Format; value: number; shamt?: boolean }
  | { kind: "MUX"; id: MuxId; sel: string; value: number }
  | { kind: "ALU"; op: AluOp; a: number; b: number; out: number }
  | { kind: "BRANCH"; op: BranchOp; a: number; b: number; taken: boolean; target: number }
  | { kind: "TARGET"; base: number; offset: number; target: number }
  | { kind: "MEM_READ"; addr: number; size: 1 | 2 | 4 | 8; raw: number; value: number; bytes: number[]; unsigned: boolean }
  | { kind: "MEM_WRITE"; addr: number; size: 1 | 2 | 4 | 8; value: number; oldBytes: number[]; bytes: number[] }
  | { kind: "REG_WRITE"; reg: number; old: number; value: number; ignored: boolean }
  | { kind: "CSR_READ"; csr: number; name: string; value: number }
  | { kind: "CSR_WRITE"; csr: number; name: string; old: number; value: number }
  | { kind: "FREG_READ"; port: 1 | 2 | 3; reg: number; fmt: "S" | "D"; bits: bigint }
  | { kind: "FREG_WRITE"; reg: number; fmt: "S" | "D"; old: bigint; bits: bigint }
  | { kind: "FPU"; op: string; fmt: "S" | "D"; inputs: bigint[]; out: bigint | number; flags: number; rm: number; toInt?: boolean }
  | { kind: "AMO"; op: string; addr: number; memOld: number; operand: number; memNew: number; success?: boolean }
  | { kind: "VSET"; avl: number; vl: number; vtype: number; vlmax: number; sew: number; lmul: string; vill: boolean }
  | { kind: "VEC"; op: string; sew: number; vl: number; lanes: VecLane[]; scalar?: number; maskOut?: boolean }
  | { kind: "VMEM"; write: boolean; base: number; stride: number; sew: number; addrs: number[]; values: number[] }
  | { kind: "VREG_WRITE"; reg: number; regs: number }
  | { kind: "PC"; old: number; next: number; source: "pc4" | "branch" | "jal" | "jalr" | "trap" | "xret" }
  | { kind: "SYSCALL"; service: number; name: string; output?: string; exit?: number }
  | { kind: "PRIV"; op: string; from: Priv; to: Priv; target: number }
  | { kind: "TRAP"; cause: number; interrupt: boolean; name: string; tval: number; message: string; handler?: number; to?: Priv; from?: Priv };

export interface VecLane {
  i: number;
  a: number;
  b: number;
  out: number;
  active: boolean;
}

export type MuxId = "aluSrcA" | "aluSrcB" | "wbSel" | "pcSel";

export type EventOf<K extends MicroEvent["kind"]> = Extract<MicroEvent, { kind: K }>;

/** One executed instruction (or a taken interrupt). Holds enough to undo it exactly. */
export interface StepRecord {
  index: number;
  pc: number;
  /** Fetched bits: the 32-bit word, or the 16-bit halfword for compressed instructions. */
  word: number;
  decoded?: Decoded;
  ctrl?: Control;
  events: MicroEvent[];
  nextPc: number;
  priv: Priv;
  /** Undo journal, applied in reverse by Cpu.undo. */
  journal: (() => void)[];
  halted?: HaltInfo;
  /** True when this step retired an instruction (false for a trap taken instead). */
  retired: boolean;
}

export interface HaltInfo {
  reason: "exit" | "ebreak" | "trap" | "end" | "pass" | "fail" | "limit";
  message: string;
  code?: number;
}

export function find<K extends MicroEvent["kind"]>(events: MicroEvent[], kind: K): EventOf<K> | undefined {
  return events.find((e) => e.kind === kind) as EventOf<K> | undefined;
}

export function findAll<K extends MicroEvent["kind"]>(events: MicroEvent[], kind: K): EventOf<K>[] {
  return events.filter((e) => e.kind === kind) as EventOf<K>[];
}

export { CAUSES as EXCEPTION_NAMES } from "@/isa/csr";
