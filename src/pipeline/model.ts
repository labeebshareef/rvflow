/**
 * Trace-driven, cycle-accurate timing model of the classic 5-stage RISC-V
 * pipeline (IF, ID, EX, MEM, WB; Patterson & Hennessy style).
 *
 * The functional simulator has already produced the correct-path dynamic
 * instruction stream; this model only decides *when* each instruction occupies
 * each stage. Wrong-path instructions (fetched after a misprediction) are
 * looked up by address, carry no semantics and are always squashed.
 *
 * Conventions:
 * - The register file writes in the first half of WB and reads in the second
 *   half of ID, so a WB -> ID dependency in the same cycle needs no stall.
 * - `srcs[0]` is rs1 and `srcs[1]` is rs2 (for a store: base, data).
 * - A slot is "stalled" when it is held over in the same stage from the
 *   previous cycle; a stall detected in cycle t holds IF/ID and puts a bubble
 *   into EX in cycle t+1.
 * - A flush detected in cycle t marks the younger slots `squashed` in cycle t;
 *   the redirected fetch happens in cycle t+1.
 */

export type Stage = "IF" | "ID" | "EX" | "MEM" | "WB";
export const STAGES: Stage[] = ["IF", "ID", "EX", "MEM", "WB"];

export type InstrKind = "alu" | "mul" | "div" | "load" | "store" | "branch" | "jal" | "jalr" | "system" | "fp" | "csr" | "amo";

export interface PipeInstr {
  /** Index in the correct-path stream (0..). */
  seq: number;
  pc: number;
  /** Disassembly, ASCII. */
  text: string;
  /** Registers read, e.g. ["x5","x6"] or ["f1"]; never "x0". srcs[0] = rs1, srcs[1] = rs2. */
  srcs: string[];
  /** Registers written (never "x0"). */
  dsts: string[];
  kind: InstrKind;
  /** Branches: actual outcome. */
  taken?: boolean;
  /** Actual next PC. */
  nextPc: number;
  /** trap / mret / ecall into a handler / fence.i: flush everything younger when it reaches EX. */
  serializing?: boolean;
}

export type Predictor = "not-taken" | "taken" | "1-bit" | "2-bit";

export interface PipeOptions {
  /** EX/MEM and MEM/WB -> EX forwarding (P&H conditions); load-use still stalls 1. */
  forwarding: boolean;
  /** Branch direction at IF. Predicting taken needs a BTB hit (target learned on the first taken execution). */
  predictor: Predictor;
  /** Power of two, indexed by (pc >> 2) & (n-1). */
  bhtEntries: number;
  /** EX cycles for kind "mul" (1 = normal). */
  mulLatency: number;
  /** EX cycles for kind "div". */
  divLatency: number;
}

export const DEFAULT_OPTIONS: PipeOptions = {
  forwarding: true,
  predictor: "2-bit",
  bhtEntries: 16,
  mulLatency: 1,
  divLatency: 1,
};

export interface Slot {
  /** Row in the pipeline diagram; -1 for bubbles. */
  rowId: number;
  seq?: number;
  pc: number;
  text: string;
  wrongPath: boolean;
  bubble?: boolean;
  /** Being flushed this cycle. */
  squashed?: boolean;
  /** Held in this stage from the previous cycle because of a stall. */
  stalled?: boolean;
}

export interface Forward {
  from: "EX/MEM" | "MEM/WB";
  operand: "rs1" | "rs2";
  reg: string;
  producerRow: number;
  consumerRow: number;
  /** Stage that consumes the value: EX (ALU / compare operands) or MEM (store data). */
  to: "EX" | "MEM";
}

export type StallReason = "load-use" | "data" | "structural" | "multi-cycle";
export type FlushReason = "mispredict" | "jump" | "serialize";

export interface CycleState {
  /** 1-based. */
  cycle: number;
  /** Contents during this cycle (bubble slots for stalls and flushes, null when empty). */
  stages: Record<Stage, Slot | null>;
  forwards: Forward[];
  stall: { row: number; reason: StallReason } | null;
  flush: { row: number; squashedRows: number[]; reason: FlushReason } | null;
  /** Correct-path instructions that completed WB by the end of this cycle. */
  retired: number;
  /** Short ASCII narration. */
  notes: string[];
  /** Predictor counters snapshot at the end of the cycle (2-bit: 0..3, 1-bit: 0..1). */
  bht?: number[];
}

export interface RowCell {
  cycle: number;
  stage: Stage | "stall" | "flush";
}

export interface Row {
  rowId: number;
  seq?: number;
  pc: number;
  text: string;
  wrongPath: boolean;
  cells: RowCell[];
}

export interface PipeStats {
  cycles: number;
  instructions: number;
  cpi: number;
  stallCycles: number;
  loadUseStalls: number;
  dataStalls: number;
  flushes: number;
  squashed: number;
  branches: number;
  mispredicts: number;
  /** Fraction of correctly predicted conditional branches (1 when there are none). */
  accuracy: number;
}

export interface PipelineRun {
  cycles: CycleState[];
  rows: Row[];
  stats: PipeStats;
  complete: boolean;
}

// ---------------------------------------------------------------------------

interface Entry {
  rowId: number;
  pc: number;
  text: string;
  wrongPath: boolean;
  bubble: boolean;
  instr?: PipeInstr;
  /** The fetch-time prediction was wrong (or the instruction serializes). */
  mispredict: boolean;
  resolveAt?: "ID" | "EX";
  predictedNext: number;
  /** Remaining EX cycles, set on entry to EX. */
  exLeft: number;
  /** Cycles spent in EX so far. */
  exCycles: number;
  held: boolean;
  /** Store data whose producer was a load in MEM while the store was in EX: forward from MEM/WB in MEM. */
  pendingStoreFwd?: { reg: string; producerRow: number };
}

const isLoadLike = (k: InstrKind) => k === "load" || k === "amo";
const hex = (v: number) => "0x" + (v >>> 0).toString(16);

function bubbleEntry(): Entry {
  return { rowId: -1, pc: 0, text: "bubble", wrongPath: false, bubble: true, mispredict: false, predictedNext: 0, exLeft: 0, exCycles: 0, held: false };
}

function latency(kind: InstrKind, opts: PipeOptions): number {
  if (kind === "mul") return Math.max(1, Math.floor(opts.mulLatency));
  if (kind === "div") return Math.max(1, Math.floor(opts.divLatency));
  return 1;
}

/** Correct-path, real instruction (not a bubble, not wrong-path). */
function real(e: Entry | null): e is Entry & { instr: PipeInstr } {
  return !!e && !e.bubble && !e.wrongPath && !!e.instr;
}

/** Operand name for the i-th source register. */
const operandOf = (i: number): "rs1" | "rs2" => (i === 0 ? "rs1" : "rs2");

export function simulatePipeline(
  stream: PipeInstr[],
  wrongPathAt: (pc: number) => string | null,
  opts: PipeOptions,
  maxCycles = 20000,
): PipelineRun {
  const N = stream.length;
  const rows: Row[] = [];
  const cycles: CycleState[] = [];
  const stats: PipeStats = {
    cycles: 0,
    instructions: N,
    cpi: 0,
    stallCycles: 0,
    loadUseStalls: 0,
    dataStalls: 0,
    flushes: 0,
    squashed: 0,
    branches: 0,
    mispredicts: 0,
    accuracy: 1,
  };
  if (N === 0) return { cycles, rows, stats, complete: true };

  const usesBht = opts.predictor === "1-bit" || opts.predictor === "2-bit";
  const bhtN = Math.max(1, 2 ** Math.round(Math.log2(Math.max(1, opts.bhtEntries | 0))));
  const bht: number[] = new Array(bhtN).fill(opts.predictor === "2-bit" ? 1 : 0);
  const bhtIndex = (pc: number) => (pc >>> 2) & (bhtN - 1);
  /** Branch / jal target buffer: pc -> target, learned on resolution. Not used by the static not-taken scheme. */
  const btb = new Map<number, number>();
  const useBtb = opts.predictor !== "not-taken";

  let fetch: { mode: "correct"; next: number } | { mode: "wrong"; pc: number } = { mode: "correct", next: 0 };

  const newRow = (pc: number, text: string, wrongPath: boolean, seq?: number): number => {
    const rowId = rows.length;
    rows.push({ rowId, seq, pc, text, wrongPath, cells: [] });
    return rowId;
  };

  function predictTaken(pc: number): boolean {
    switch (opts.predictor) {
      case "not-taken":
        return false;
      case "taken":
        return true;
      case "1-bit":
        return bht[bhtIndex(pc)] >= 1;
      case "2-bit":
        return bht[bhtIndex(pc)] >= 2;
    }
  }

  function doFetch(): Entry | null {
    if (fetch.mode === "wrong") {
      const pc = fetch.pc;
      fetch = { mode: "wrong", pc: (pc + 4) >>> 0 };
      const text = wrongPathAt(pc);
      if (text === null) return { ...bubbleEntry(), pc, wrongPath: true };
      return {
        rowId: newRow(pc, text, true),
        pc,
        text,
        wrongPath: true,
        bubble: false,
        mispredict: false,
        predictedNext: (pc + 4) >>> 0,
        exLeft: 0,
        exCycles: 0,
        held: false,
      };
    }
    if (fetch.next >= N) return null;
    const ins = stream[fetch.next];
    const fall = (ins.pc + 4) >>> 0;
    let predicted = fall;
    if (ins.kind === "branch") {
      const t = btb.get(ins.pc);
      if (useBtb && t !== undefined && predictTaken(ins.pc)) predicted = t;
    } else if (ins.kind === "jal") {
      const t = btb.get(ins.pc);
      if (useBtb && t !== undefined) predicted = t;
    }
    const mispredict = !!ins.serializing || predicted !== ins.nextPc >>> 0;
    const resolveAt: "ID" | "EX" | undefined = mispredict ? (ins.kind === "jal" && !ins.serializing ? "ID" : "EX") : undefined;
    const e: Entry = {
      rowId: newRow(ins.pc, ins.text, false, ins.seq),
      pc: ins.pc,
      text: ins.text,
      wrongPath: false,
      bubble: false,
      instr: ins,
      mispredict,
      resolveAt,
      predictedNext: predicted,
      exLeft: 0,
      exCycles: 0,
      held: false,
    };
    fetch = mispredict ? { mode: "wrong", pc: predicted } : { mode: "correct", next: fetch.next + 1 };
    return e;
  }

  let st: Record<Stage, Entry | null> = { IF: doFetch(), ID: null, EX: null, MEM: null, WB: null };
  let retired = 0;
  let complete = false;

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const notes: string[] = [];
    const forwards: Forward[] = [];
    const { IF, ID, EX, MEM, WB } = st;
    const squashedSet = new Set<Entry>();
    let flush: CycleState["flush"] = null;
    let stall: CycleState["stall"] = null;

    // --- WB: register write (first half of the cycle) ---
    if (real(WB)) {
      retired++;
      notes.push(WB.instr.dsts.length ? `WB: ${WB.text} writes ${WB.instr.dsts.join(", ")}` : `WB: ${WB.text} completes`);
    }

    // --- MEM: store data forwarded from MEM/WB ---
    if (real(MEM) && MEM.pendingStoreFwd) {
      const f = MEM.pendingStoreFwd;
      forwards.push({ from: "MEM/WB", operand: "rs2", reg: f.reg, producerRow: f.producerRow, consumerRow: MEM.rowId, to: "MEM" });
      notes.push(`Forward ${f.reg} from MEM/WB to store data of ${MEM.text}`);
      MEM.pendingStoreFwd = undefined;
    }

    // --- EX: operand forwarding, branch / jump resolution ---
    let flushEX = false;
    let exBusy = false;
    if (real(EX)) {
      EX.exCycles++;
      const ins = EX.instr;
      if (EX.exCycles === 1) {
        if (opts.forwarding) {
          ins.srcs.forEach((reg, i) => {
            const operand = operandOf(i);
            if (real(MEM) && MEM.instr.dsts.includes(reg)) {
              if (isLoadLike(MEM.instr.kind)) {
                // Only store data can wait for a load still in MEM (forwarded next cycle from MEM/WB).
                EX.pendingStoreFwd = { reg, producerRow: MEM.rowId };
                return;
              }
              forwards.push({ from: "EX/MEM", operand, reg, producerRow: MEM.rowId, consumerRow: EX.rowId, to: "EX" });
              notes.push(`Forward ${reg} from EX/MEM to ${operand} of ${EX.text}`);
            } else if (real(WB) && WB.instr.dsts.includes(reg)) {
              forwards.push({ from: "MEM/WB", operand, reg, producerRow: WB.rowId, consumerRow: EX.rowId, to: "EX" });
              notes.push(`Forward ${reg} from MEM/WB to ${operand} of ${EX.text}`);
            }
          });
        }
        if (ins.kind === "branch") {
          stats.branches++;
          const wrong = EX.predictedNext !== ins.nextPc >>> 0;
          if (wrong) stats.mispredicts++;
          if (ins.taken) btb.set(ins.pc, ins.nextPc >>> 0);
          if (usesBht) {
            const i = bhtIndex(ins.pc);
            const before = bht[i];
            bht[i] = opts.predictor === "2-bit" ? (ins.taken ? Math.min(3, before + 1) : Math.max(0, before - 1)) : ins.taken ? 1 : 0;
            if (bht[i] !== before) notes.push(`BHT[${i}]: ${before} -> ${bht[i]}`);
          }
          notes.push(`EX: ${ins.text} ${ins.taken ? "taken" : "not taken"}, predicted ${EX.predictedNext !== ((ins.pc + 4) >>> 0) ? "taken" : "not taken"}${wrong ? " - mispredict" : ""}`);
        }
        if (EX.mispredict && EX.resolveAt === "EX") flushEX = true;
      }
      exBusy = EX.exLeft > 1;
      if (exBusy) notes.push(`EX: ${EX.text} busy (${EX.exCycles}/${EX.exCycles + EX.exLeft - 1})`);
    }

    if (flushEX && real(EX)) {
      const ins = EX.instr;
      const reason: FlushReason = ins.serializing ? "serialize" : ins.kind === "branch" ? "mispredict" : "jump";
      const victims = [ID, IF].filter((e): e is Entry => !!e && !e.bubble);
      for (const e of [ID, IF]) if (e) squashedSet.add(e);
      flush = { row: EX.rowId, squashedRows: victims.map((e) => e.rowId), reason };
      notes.push(`Flush ${victims.length} younger (${reason}); fetch ${hex(ins.nextPc)}`);
    }

    // --- ID: hazard detection unit ---
    let stallID = false;
    if (!flushEX) {
      if (exBusy) {
        stallID = true;
        stall = { row: real(ID) ? ID.rowId : EX!.rowId, reason: "multi-cycle" };
      } else if (real(ID)) {
        const ins = ID.instr;
        let reason: StallReason | null = null;
        ins.srcs.forEach((reg, i) => {
          if (opts.forwarding) {
            // Store data is needed in MEM and can come from MEM/WB next cycle.
            const neededInEx = !(ins.kind === "store" && i === 1);
            if (neededInEx && real(EX) && isLoadLike(EX.instr.kind) && EX.instr.dsts.includes(reg)) reason = "load-use";
          } else {
            for (const p of [EX, MEM]) {
              if (real(p) && p.instr.dsts.includes(reg)) {
                const r: StallReason = isLoadLike(p.instr.kind) ? "load-use" : "data";
                if (reason !== "load-use") reason = r;
              }
            }
          }
        });
        if (reason) {
          stallID = true;
          stall = { row: ID.rowId, reason };
        }
      }
      if (stall) {
        stats.stallCycles++;
        if (stall.reason === "load-use") stats.loadUseStalls++;
        if (stall.reason === "data") stats.dataStalls++;
        notes.push(
          stall.reason === "multi-cycle"
            ? `Stall: IF/ID held while ${EX!.text} is in EX`
            : `Stall (${stall.reason}): ${ID!.text} waits in ID; bubble into EX`,
        );
      }
    }

    // --- ID: jal resolves here (PC-relative target) ---
    let flushID = false;
    if (!flushEX && !stallID && real(ID) && ID.instr.kind === "jal") {
      btb.set(ID.pc, ID.instr.nextPc >>> 0);
      if (ID.mispredict && ID.resolveAt === "ID") {
        flushID = true;
        const victims = IF && !IF.bubble ? [IF.rowId] : [];
        if (IF) squashedSet.add(IF);
        flush = { row: ID.rowId, squashedRows: victims, reason: "jump" };
        notes.push(`ID: ${ID.text} redirects to ${hex(ID.instr.nextPc)}; flush ${victims.length}`);
      }
    }
    if (flush) {
      stats.flushes++;
      stats.squashed += flush.squashedRows.length;
    }

    // --- Record this cycle ---
    const stages = {} as Record<Stage, Slot | null>;
    for (const s of STAGES) {
      const e = st[s];
      if (!e) {
        stages[s] = null;
        continue;
      }
      const slot: Slot = { rowId: e.rowId, pc: e.pc, text: e.text, wrongPath: e.wrongPath };
      if (e.instr && !e.wrongPath) slot.seq = e.instr.seq;
      if (e.bubble) slot.bubble = true;
      if (squashedSet.has(e)) slot.squashed = true;
      else if (e.held) slot.stalled = true;
      stages[s] = slot;
      if (e.rowId >= 0) rows[e.rowId].cells.push({ cycle, stage: slot.squashed ? "flush" : slot.stalled ? "stall" : s });
    }
    cycles.push({ cycle, stages, forwards, stall, flush, retired, notes, ...(usesBht ? { bht: bht.slice() } : {}) });

    if (retired >= N) {
      complete = true;
      break;
    }

    // --- Advance to the next cycle ---
    const next: Record<Stage, Entry | null> = { IF: null, ID: null, EX: null, MEM: null, WB: null };
    const move = (e: Entry | null): Entry | null => (e ? ((e.held = false), e) : null);
    const hold = (e: Entry | null): Entry | null => (e ? ((e.held = true), e) : null);
    next.WB = move(MEM);
    if (exBusy) {
      next.MEM = bubbleEntry();
      EX!.exLeft--;
      next.EX = EX;
      EX!.held = false;
    } else {
      next.MEM = move(EX);
      if (flushEX) next.EX = ID ? bubbleEntry() : null;
      else if (stallID) next.EX = bubbleEntry();
      else {
        next.EX = move(ID);
        if (real(next.EX)) {
          next.EX.exLeft = latency(next.EX.instr.kind, opts);
          next.EX.exCycles = 0;
        }
      }
    }
    if (flushEX || flushID) {
      // The squashed IF slot becomes a bubble in ID (for a jal, the jal itself moved on to EX).
      next.ID = IF ? bubbleEntry() : null;
      const resolver = flushEX ? EX! : ID!;
      fetch = { mode: "correct", next: resolver.instr!.seq + 1 };
      next.IF = doFetch();
    } else if (stallID) {
      next.ID = hold(ID);
      next.IF = hold(IF);
    } else {
      next.ID = move(IF);
      next.IF = doFetch();
    }
    st = next;
  }

  stats.cycles = cycles.length;
  stats.cpi = N ? stats.cycles / N : 0;
  stats.accuracy = stats.branches ? (stats.branches - stats.mispredicts) / stats.branches : 1;
  return { cycles, rows, stats, complete };
}
