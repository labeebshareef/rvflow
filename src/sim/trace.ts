import type { AluOp, BranchOp, Format } from "@/isa/instructions";
import type { Decoded } from "@/isa/encoding";
import type { Control } from "./control";

/**
 * Micro-events: everything the datapath did during one instruction.
 * The animation timeline is compiled from these — never from the instruction itself.
 */
export type MicroEvent =
  | { kind: "FETCH"; pc: number; word: number }
  | { kind: "DECODE"; decoded: Decoded; ctrl: Control }
  | { kind: "REG_READ"; port: 1 | 2; reg: number; value: number }
  | { kind: "IMM"; format: Format; value: number; shamt?: boolean }
  | { kind: "MUX"; id: MuxId; sel: string; value: number }
  | { kind: "ALU"; op: AluOp; a: number; b: number; out: number }
  | { kind: "BRANCH"; op: BranchOp; a: number; b: number; taken: boolean; target: number }
  | { kind: "TARGET"; base: number; offset: number; target: number }
  | { kind: "MEM_READ"; addr: number; size: 1 | 2 | 4; raw: number; value: number; bytes: number[]; unsigned: boolean }
  | { kind: "MEM_WRITE"; addr: number; size: 1 | 2 | 4; value: number; oldBytes: number[]; bytes: number[] }
  | { kind: "REG_WRITE"; reg: number; old: number; value: number; ignored: boolean }
  | { kind: "PC"; old: number; next: number; source: "pc4" | "branch" | "jal" | "jalr" }
  | { kind: "SYSCALL"; service: number; name: string; output?: string; exit?: number }
  | { kind: "TRAP"; cause: number; name: string; tval: number; message: string };

export type MuxId = "aluSrcA" | "aluSrcB" | "wbSel" | "pcSel";

export type EventOf<K extends MicroEvent["kind"]> = Extract<MicroEvent, { kind: K }>;

/** One executed instruction. Holds enough to undo it exactly. */
export interface StepRecord {
  index: number;
  pc: number;
  word: number;
  decoded?: Decoded;
  ctrl?: Control;
  events: MicroEvent[];
  nextPc: number;
  /** Undo info. */
  regUndo?: { reg: number; old: number };
  memUndo?: { addr: number; oldBytes: number[] };
  outputBefore: number;
  halted?: HaltInfo;
}

export interface HaltInfo {
  reason: "exit" | "ebreak" | "trap" | "end";
  message: string;
  code?: number;
}

export function find<K extends MicroEvent["kind"]>(events: MicroEvent[], kind: K): EventOf<K> | undefined {
  return events.find((e) => e.kind === kind) as EventOf<K> | undefined;
}

export function findAll<K extends MicroEvent["kind"]>(events: MicroEvent[], kind: K): EventOf<K>[] {
  return events.filter((e) => e.kind === kind) as EventOf<K>[];
}

export const EXCEPTION_NAMES: Record<number, string> = {
  0: "instruction address misaligned",
  1: "instruction access fault",
  2: "illegal instruction",
  3: "breakpoint",
  4: "load address misaligned",
  5: "load access fault",
  6: "store address misaligned",
  7: "store access fault",
  11: "environment call from M-mode",
};
