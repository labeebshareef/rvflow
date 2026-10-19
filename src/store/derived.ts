/**
 * Views derived from the executed instruction history: the pipeline timing
 * stream, cache state, multi-cycle cycle counts and the program's features.
 */
import { CHOREO, STAGE_OF } from "@/anim/choreography";
import type { Program } from "@/asm/assembler";
import { disassemble, disassembleC } from "@/asm/disasm";
import { decode } from "@/isa/encoding";
import { expandC } from "@/isa/rvc";
import { Cache, type Access, type AccessResult, type CacheConfig } from "@/cache/cache";
import type { InstrKind, PipeInstr } from "@/pipeline/model";
import type { Feature } from "@/scene/layout";
import type { Memory } from "@/sim/memory";
import type { StepRecord } from "@/sim/trace";
import { find, findAll } from "@/sim/trace";

// ───────────── features ─────────────

/** Which optional parts of the datapath a program needs. */
export function programFeatures(words: { word: number; size: 2 | 4 }[]): Set<Feature> {
  const f = new Set<Feature>();
  for (const t of words) {
    if (t.size === 2) f.add("rvc");
    const d = t.size === 2 ? (() => {
      const e = expandC(t.word);
      return e ? decode(e.word) : undefined;
    })() : decode(t.word);
    if (!d) continue;
    if (d.def.ext === "F" || d.def.ext === "D") f.add("fp");
    if (d.def.ext === "V") f.add("vec");
  }
  return f;
}

export function featuresOf(p: Program): Set<Feature> {
  return programFeatures(p.text);
}

// ───────────── multi-cycle ─────────────


/** Clock cycles of one instruction in the multi-cycle implementation (by its choreography class). */
export function multiCycles(rec: StepRecord): number {
  const d = rec.decoded;
  if (!d) return rec.events.length ? 1 : 0;
  const ids = CHOREO[d.def.animClass].filter((id) => id !== "memory" || find(rec.events, "MEM_READ") || find(rec.events, "MEM_WRITE"));
  return new Set(ids.map((id) => STAGE_OF[id]).filter(Boolean)).size;
}

// ───────────── pipeline stream ─────────────

function kindOf(rec: StepRecord): InstrKind {
  const def = rec.decoded!.def;
  switch (def.animClass) {
    case "R": case "I_ALU":
      if (def.aluOp && /^(MUL|MULH)/.test(def.aluOp)) return "mul";
      if (def.aluOp && /^(DIV|REM)/.test(def.aluOp)) return "div";
      return "alu";
    case "LUI": case "AUIPC": case "VSET": case "V_ARITH": return "alu";
    case "LOAD": case "FP_LOAD": case "V_LOAD": case "LR": return "load";
    case "STORE": case "FP_STORE": case "V_STORE": return "store";
    case "AMO": case "SC": return "amo";
    case "BRANCH": return "branch";
    case "JAL": return "jal";
    case "JALR": return "jalr";
    case "CSR": return "csr";
    case "FP_OP": case "FP_FMA": case "FP_CMP": case "FP_TO_INT": case "INT_TO_FP": return "fp";
    default: return "system";
  }
}

/** Convert executed instructions into the timing model's input. */
export function pipeStream(history: StepRecord[], textOf: (rec: StepRecord) => string): PipeInstr[] {
  const out: PipeInstr[] = [];
  for (const rec of history) {
    const d = rec.decoded;
    if (!d || !rec.retired && !find(rec.events, "TRAP")) continue;
    const ev = rec.events;
    const srcs: string[] = [];
    const r1 = ev.find((e) => e.kind === "REG_READ" && e.port === 1);
    const r2 = ev.find((e) => e.kind === "REG_READ" && e.port === 2);
    // The timing model treats srcs[0] as rs1 and srcs[1] as rs2.
    for (const e of [r1, r2]) if (e && e.kind === "REG_READ" && e.reg !== 0) srcs.push(`x${e.reg}`);
    for (const e of findAll(ev, "FREG_READ")) srcs.push(`f${e.reg}`);
    if (d.def.ext === "V") for (const k of ["vs1", "vs2", "vs3"]) if (d.f[k] !== undefined && d.def.syntax.includes(k)) srcs.push(`v${d.f[k]}`);
    const dsts: string[] = [];
    for (const e of findAll(ev, "REG_WRITE")) if (!e.ignored) dsts.push(`x${e.reg}`);
    for (const e of findAll(ev, "FREG_WRITE")) dsts.push(`f${e.reg}`);
    for (const e of findAll(ev, "VREG_WRITE")) dsts.push(`v${e.reg}`);
    const br = find(ev, "BRANCH");
    const priv = find(ev, "PRIV");
    const trap = find(ev, "TRAP");
    out.push({
      seq: out.length,
      pc: rec.pc,
      text: textOf(rec),
      srcs,
      dsts,
      kind: kindOf(rec),
      taken: br?.taken,
      nextPc: rec.nextPc,
      serializing: !!trap?.handler || priv?.op === "mret" || priv?.op === "sret" || d.def.mnemonic === "fence.i",
    });
  }
  return out;
}

/** Disassembly at an address, for wrong-path fetches in the pipeline view. */
export function textAt(mem: Memory, pc: number, labels?: Map<number, string>): string | null {
  const lo = mem.read(pc, 2);
  if ((lo & 3) !== 3) return disassembleC(lo, pc, { labels })?.c ?? null;
  return disassemble(mem.read(pc, 4), pc, { labels });
}

// ───────────── caches ─────────────

/** Memory accesses performed by one step: instruction fetch, data loads/stores, vector elements. */
export function accessesOf(rec: StepRecord): { fetch: Access[]; data: Access[] } {
  const fetch: Access[] = [];
  const data: Access[] = [];
  for (const e of rec.events) {
    if (e.kind === "FETCH") fetch.push({ addr: e.pc, size: e.size, write: false, kind: "fetch" });
    else if (e.kind === "MEM_READ") data.push({ addr: e.addr, size: e.size, write: false, kind: "load" });
    else if (e.kind === "MEM_WRITE") data.push({ addr: e.addr, size: e.size, write: true, kind: "store" });
    else if (e.kind === "VMEM") for (const a of e.addrs) data.push({ addr: a, size: e.sew / 8, write: e.write, kind: e.write ? "store" : "load" });
  }
  return { fetch, data };
}

export interface CacheSnapshot {
  caches: [Cache, Cache];
  last: [AccessResult | undefined, AccessResult | undefined];
  steps: number;
}

let snap: { cfgs: [CacheConfig, CacheConfig]; lastRec: StepRecord | undefined; s: CacheSnapshot } | null = null;

/** Cache state after the given history, updated incrementally when the history only grew. */
export function cachesFor(history: StepRecord[], cfgs: [CacheConfig, CacheConfig]): CacheSnapshot {
  // The history array is mutated in place, so remember the last record seen to detect undo + redo.
  const reuse = snap && snap.cfgs === cfgs && snap.s.steps <= history.length && history[snap.s.steps - 1] === snap.lastRec;
  if (!reuse) {
    snap = { cfgs, lastRec: undefined, s: { caches: [new Cache(cfgs[0]), new Cache(cfgs[1])], last: [undefined, undefined], steps: 0 } };
  }
  const s = snap!.s;
  for (let i = s.steps; i < history.length; i++) {
    const { fetch, data } = accessesOf(history[i]);
    let li: AccessResult | undefined;
    let ld: AccessResult | undefined;
    for (const a of fetch) li = s.caches[0].access(a);
    for (const a of data) ld = s.caches[1].access(a);
    s.last = [li, ld];
  }
  if (history.length && !accessesOf(history[history.length - 1]).data.length) s.last = [s.last[0], undefined];
  s.steps = history.length;
  snap!.lastRec = history[history.length - 1];
  return s;
}
