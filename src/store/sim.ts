import { create } from "zustand";
import { compileTimeline, type Segment } from "@/anim/choreography";
import { assemble, type AsmError, type Program, type TextEntry } from "@/asm/assembler";
import { parseRegister } from "@/isa/registers";
import type { Radix } from "@/lib/format";
import { DEFAULT_EXAMPLE, EXAMPLES, type Example } from "@/lessons/examples";
import { formatInstr } from "@/asm/disasm";
import { DEFAULT_DCACHE, DEFAULT_ICACHE, type CacheConfig } from "@/cache/cache";
import { DEFAULT_OPTIONS, simulatePipeline, type PipelineRun, type PipeOptions } from "@/pipeline/model";
import type { Feature } from "@/scene/layout";
import { Cpu, type Env } from "@/sim/cpu";
import { parseElf, type ElfImage } from "@/sim/elf";
import type { StepRecord } from "@/sim/trace";
import { find } from "@/sim/trace";
import { featuresOf, pipeStream, programFeatures, textAt } from "./derived";

/** Upper bound on retained history (undo depth) for long runs. */
const MAX_HISTORY = 20_000;
const RUN_LIMIT = 200_000;
/** Instructions simulated ahead for the pipeline view. */
const PIPE_LIMIT = 2_000;

export type Arch = "single" | "multi" | "pipeline";

export type PlayMode = "segment" | "instruction" | "run";

export interface PredictState {
  question: string;
  options: string[];
  answer: string;
  explain: string;
  chosen?: string;
}

export interface SimState {
  source: string;
  exampleId: string | null;
  program: Program | null;
  errors: AsmError[];
  /** Bumped whenever CPU state changes, to re-render consumers. */
  version: number;

  history: StepRecord[];
  segments: Segment[];
  segIndex: number;
  /** Progress through the current segment, 0..1. */
  segT: number;
  playing: boolean;
  /** How far playback continues: one segment, one instruction, or the whole program. */
  mode: PlayMode;
  speed: number;

  pauseEachSegment: boolean;
  skipAnimation: boolean;
  predictMode: boolean;
  predict: PredictState | null;
  score: { right: number; total: number };
  answered: Set<string>;

  breakpoints: Set<number>;
  radix: Radix;
  abiNames: boolean;
  showControl: boolean;
  explainOpen: boolean;
  theme: "dark" | "light";
  status: string | null;

  /** Which implementation is shown: single-cycle, multi-cycle or 5-stage pipeline. */
  arch: Arch;
  pipeOptions: PipeOptions;
  pipeRun: PipelineRun | null;
  /** Pipeline cycle shown (1-based). */
  pipeCycle: number;
  cacheCfgs: [CacheConfig, CacheConfig];
  /** Optional datapath parts the program needs (FP/vector lane, RVC expander). */
  features: Set<Feature>;
  /** Name of the loaded ELF file, when running a binary instead of the editor's source. */
  elfName: string | null;

  setSource(src: string): void;
  loadExample(ex: Example): void;
  assembleAndLoad(): boolean;
  reset(): void;
  stepInstruction(): void;
  stepSegment(): void;
  backSegment(): void;
  undoInstruction(): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  runToEnd(): void;
  seek(segIndex: number, t?: number): void;
  answerPredict(choice: string): void;
  toggleBreakpoint(line: number): void;
  setArch(a: Arch): void;
  setPipeOptions(o: Partial<PipeOptions>): void;
  seekCycle(c: number): void;
  loadElf(bytes: Uint8Array, name: string): void;
  set<K extends keyof SimState>(key: K, value: SimState[K]): void;
}

/** The CPU is mutable and lives outside React state; `version` signals changes. */
export const cpu = new Cpu();

let textByAddr = new Map<number, TextEntry>();

export function entryAt(addr: number): TextEntry | undefined {
  return textByAddr.get(addr >>> 0);
}

function sourceFor(rec: StepRecord): string | undefined {
  const e = entryAt(rec.pc);
  return e?.asm;
}

/** Text for an executed instruction: the listing entry, or a fresh disassembly. */
function textOf(rec: StepRecord): string {
  const e = entryAt(rec.pc);
  if (e) return e.asm;
  const d = rec.decoded;
  return d ? (d.compressed ? d.compressed.mnemonic : formatInstr(d.def, d.f, rec.pc)) : "?";
}

let elfImage: ElfImage | null = null;

function envFor(): { env: Env; misaligned: boolean; tohost?: number } {
  if (!elfImage) return { env: "rars", misaligned: false };
  const tohost = elfImage.symbols.get("tohost");
  return tohost !== undefined ? { env: "bare", misaligned: false, tohost } : { env: "linux", misaligned: true };
}

/** Listing of an ELF's executable segments, one instruction per line. */
function elfProgram(img: ElfImage): { program: Program; source: string } {
  const text: TextEntry[] = [];
  const lines: string[] = ["# Disassembly of the loaded ELF (read it, step it; edit and Assemble to switch back to source)."];
  const labels = new Map([...img.symbols].map(([n, a]) => [a, n]));
  const lineToAddrs = new Map<number, number[]>();
  const tmp = new Cpu();
  for (const seg of img.segments) tmp.mem.load(seg.addr, seg.bytes);
  for (const seg of img.segments.filter((x) => x.exec)) {
    for (let a = seg.addr; a < seg.addr + seg.bytes.length;) {
      const lo = tmp.mem.read(a, 2);
      const size: 2 | 4 = (lo & 3) === 3 ? 4 : 2;
      const word = size === 4 ? tmp.mem.read(a, 4) : lo;
      const asm = textAt(tmp.mem, a, labels) ?? `.${size === 4 ? "word" : "half"} 0x${word.toString(16)}`;
      const label = labels.get(a);
      if (label) lines.push(`${label}:`);
      lines.push(`    ${asm.padEnd(34)} # ${a.toString(16).padStart(8, "0")}`);
      text.push({ addr: a, word, size, line: lines.length, asm });
      lineToAddrs.set(lines.length, [a]);
      a += size;
    }
  }
  return {
    program: { text, textBase: text[0]?.addr ?? 0, textEnd: 0, data: [], dataBase: 0, symbols: img.symbols, entry: img.entry, errors: [], lineToAddrs },
    source: lines.join("\n") + "\n",
  };
}

const reducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function initialTheme(): "dark" | "light" {
  try {
    const saved = localStorage.getItem("rvflow-theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* storage unavailable */
  }
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
  return "dark";
}

function initialSource(): { source: string; exampleId: string | null } {
  if (typeof window !== "undefined") {
    const m = window.location.hash.match(/code=([^&]+)/);
    if (m) {
      try {
        return { source: decodeShare(m[1]), exampleId: null };
      } catch {
        /* fall through to the default example */
      }
    }
  }
  return { source: DEFAULT_EXAMPLE.source, exampleId: DEFAULT_EXAMPLE.id };
}

export function encodeShare(src: string): string {
  const bytes = new TextEncoder().encode(src);
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeShare(code: string): string {
  const b = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
}

export const useSim = create<SimState>()((set, get) => {
  const bump = () => set((s) => ({ version: s.version + 1 }));
  /** Executed instructions as the pipeline timing model sees them. */
  let stream: ReturnType<typeof pipeStream> = [];

  /** Execute one instruction and start (or skip) its animation. */
  const execNext = (): boolean => {
    if (cpu.halted || !get().program) return false;
    const rec = cpu.step();
    const segments = compileTimeline(rec, sourceFor(rec));
    const history = get().history;
    history.push(rec);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    const skip = get().skipAnimation;
    set({
      history,
      segments,
      segIndex: skip ? Math.max(0, segments.length - 1) : 0,
      segT: skip ? 1 : 0,
      predict: null,
      status: rec.halted ? rec.halted.message : null,
    });
    bump();
    return true;
  };

  const animDone = () => {
    const { segments, segIndex, segT } = get();
    return segments.length === 0 || (segIndex >= segments.length - 1 && segT >= 1);
  };

  /** Pause at a predict-then-reveal question if the segment has one. */
  const maybePredict = (idx: number): boolean => {
    const s = get();
    const seg = s.segments[idx];
    if (!s.predictMode || !seg?.predict || s.skipAnimation) return false;
    const key = `${s.history.length}:${idx}`;
    if (s.answered.has(key)) return false;
    set({ predict: { ...seg.predict }, playing: false });
    return true;
  };

  return {
    ...initialSource(),
    program: null,
    errors: [],
    version: 0,
    history: [],
    segments: [],
    segIndex: 0,
    segT: 0,
    playing: false,
    mode: "segment",
    speed: 1,
    pauseEachSegment: true,
    skipAnimation: reducedMotion(),
    predictMode: false,
    predict: null,
    score: { right: 0, total: 0 },
    answered: new Set(),
    breakpoints: new Set(),
    radix: "hex",
    abiNames: true,
    showControl: true,
    explainOpen: false,
    theme: initialTheme(),
    status: null,
    arch: "single",
    pipeOptions: DEFAULT_OPTIONS,
    pipeRun: null,
    pipeCycle: 1,
    cacheCfgs: [DEFAULT_ICACHE, DEFAULT_DCACHE],
    features: new Set(),
    elfName: null,

    setSource: (source) => set({ source, exampleId: null }),

    loadExample: (ex) => {
      elfImage = null;
      set({ source: ex.source, exampleId: ex.id, breakpoints: new Set(), elfName: null });
      get().assembleAndLoad();
    },

    loadElf: (bytes, name) => {
      try {
        elfImage = parseElf(bytes);
      } catch (e) {
        set({ status: `Could not load ${name}: ${(e as Error).message}` });
        return;
      }
      const { program, source } = elfProgram(elfImage);
      textByAddr = new Map(program.text.map((t) => [t.addr, t]));
      set({ program, source, exampleId: null, errors: [], breakpoints: new Set(), elfName: name, features: programFeatures(program.text) });
      get().reset();
      set({ status: `Loaded ${name}: entry ${"0x" + program.entry.toString(16)}, ${envFor().env === "bare" ? "bare-metal (tohost)" : "Linux user-mode"} environment.` });
    },

    assembleAndLoad: () => {
      if (elfImage && get().elfName && get().source === elfProgram(elfImage).source) {
        get().reset();
        return true;
      }
      elfImage = null;
      set({ elfName: null });
      const program = assemble(get().source);
      if (program.errors.length) {
        set({ errors: program.errors, status: `${program.errors.length} assembler error${program.errors.length > 1 ? "s" : ""}` });
        return false;
      }
      textByAddr = new Map(program.text.map((t) => [t.addr, t]));
      set({ program, errors: [], features: featuresOf(program) });
      get().reset();
      return true;
    },

    reset: () => {
      const { program, exampleId } = get();
      cpu.reset(program?.entry ?? 0, envFor());
      if (elfImage) {
        for (const seg of elfImage.segments) cpu.mem.load(seg.addr, seg.bytes);
        cpu.textEnd = 0;
      } else if (program) {
        for (const t of program.text) cpu.mem.write(t.addr, t.size, t.word);
        cpu.mem.load(program.dataBase, program.data);
        cpu.textEnd = program.textEnd;
      }
      const ex = EXAMPLES.find((e) => e.id === exampleId);
      for (const [name, v] of Object.entries(ex?.setup ?? {})) {
        const n = parseRegister(name);
        if (n) cpu.regs[n] = v;
      }
      set({ history: [], segments: [], segIndex: 0, segT: 0, playing: false, predict: null, status: null, pipeRun: null, pipeCycle: 1 });
      bump();
      if (get().arch === "pipeline") buildPipeline();
    },

    stepInstruction: () => {
      const s = get();
      if (s.arch === "pipeline") return s.seekCycle(s.pipeCycle + 5);
      if (s.predict) return;
      if (!animDone()) {
        // Finish the current instruction's animation first.
        set({ segIndex: s.segments.length - 1, segT: 1, playing: false });
        return;
      }
      set({ mode: "instruction" });
      if (execNext() && !get().skipAnimation) {
        if (!maybePredict(0)) set({ playing: true });
      }
    },

    stepSegment: () => {
      const s = get();
      if (s.arch === "pipeline") return s.seekCycle(s.pipeCycle + 1);
      if (s.predict) return;
      if (animDone()) {
        if (execNext() && !get().skipAnimation) {
          set({ segIndex: 0, segT: 0 });
          set({ mode: "segment" });
          if (!maybePredict(0)) set({ playing: true });
        }
        return;
      }
      if (s.segT < 1) {
        set({ segT: 1, playing: false });
      } else {
        const next = s.segIndex + 1;
        set({ segIndex: next, segT: 0 });
        set({ mode: "segment" });
        if (!maybePredict(next)) set({ playing: true });
      }
    },

    backSegment: () => {
      const s = get();
      if (s.arch === "pipeline") return s.seekCycle(s.pipeCycle - 1);
      set({ playing: false, predict: null });
      if (s.segT > 0 && s.segT < 1) return set({ segT: 0 });
      if (s.segIndex > 0) return set({ segIndex: s.segIndex - 1, segT: 1 });
      if (s.segT > 0) return set({ segT: 0 });
      get().undoInstruction();
    },

    undoInstruction: () => {
      const s = get();
      if (s.arch === "pipeline") return s.seekCycle(s.pipeCycle - 5);
      const rec = s.history.pop();
      if (!rec) return;
      cpu.undo(rec);
      const prev = s.history[s.history.length - 1];
      const segments = prev ? compileTimeline(prev, sourceFor(prev)) : [];
      set({
        history: s.history,
        segments,
        segIndex: Math.max(0, segments.length - 1),
        segT: segments.length ? 1 : 0,
        playing: false,
        predict: null,
        status: null,
      });
      bump();
    },

    play: () => {
      const s = get();
      if (s.arch === "pipeline") {
        const total = s.pipeRun?.cycles.length ?? 0;
        if (s.pipeCycle >= total) s.seekCycle(1);
        return set({ playing: true });
      }
      if (s.predict) return;
      if (!s.program && !get().assembleAndLoad()) return;
      if (animDone()) {
        if (cpu.halted) return;
        set({ mode: s.pauseEachSegment ? "segment" : "run" });
        if (execNext() && !get().skipAnimation && !maybePredict(0)) set({ playing: true });
        return;
      }
      if (s.segT >= 1) {
        const next = s.segIndex + 1;
        set({ segIndex: next, segT: 0 });
        if (maybePredict(next)) return;
      }
      set({ playing: true, mode: s.pauseEachSegment ? "segment" : "run" });
    },

    pause: () => set({ playing: false }),

    togglePlay: () => (get().playing ? get().pause() : get().play()),

    runToEnd: () => {
      if (get().arch === "pipeline") return get().seekCycle(get().pipeRun?.cycles.length ?? 1);
      if (!get().program && !get().assembleAndLoad()) return;
      const { breakpoints, history } = get();
      let n = 0;
      let last: StepRecord | undefined;
      while (!cpu.halted && n < RUN_LIMIT) {
        last = cpu.step();
        history.push(last);
        n++;
        const next = entryAt(cpu.pc);
        if (next && breakpoints.has(next.line) && n > 0) break;
      }
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
      const segments = last ? compileTimeline(last, sourceFor(last)) : get().segments;
      set({
        history,
        segments,
        segIndex: Math.max(0, segments.length - 1),
        segT: 1,
        playing: false,
        predict: null,
        status: cpu.halted
          ? cpu.halted.message
          : n >= RUN_LIMIT
            ? `Stopped after ${RUN_LIMIT.toLocaleString()} instructions (infinite loop?).`
            : `Breakpoint at line ${entryAt(cpu.pc)?.line}.`,
      });
      bump();
    },

    seek: (segIndex, t = 1) => {
      set({ segIndex: Math.max(0, Math.min(segIndex, get().segments.length - 1)), segT: t, playing: false });
    },

    answerPredict: (choice) => {
      const s = get();
      if (!s.predict) return;
      const right = choice === s.predict.answer;
      const answered = new Set(s.answered);
      answered.add(`${s.history.length}:${s.segIndex}`);
      set({
        predict: { ...s.predict, chosen: choice },
        score: { right: s.score.right + (right ? 1 : 0), total: s.score.total + 1 },
        answered,
      });
    },

    toggleBreakpoint: (line) => {
      const bp = new Set(get().breakpoints);
      if (bp.has(line)) bp.delete(line);
      else bp.add(line);
      set({ breakpoints: bp });
    },

    setArch: (a) => {
      if (a === get().arch) return;
      set({ arch: a, playing: false });
      if (a === "pipeline") buildPipeline();
      else {
        set({ pipeRun: null });
        const last = get().history[get().history.length - 1];
        const segments = last ? compileTimeline(last, sourceFor(last)) : [];
        set({ segments, segIndex: Math.max(0, segments.length - 1), segT: segments.length ? 1 : 0 });
      }
    },

    setPipeOptions: (o) => {
      set({ pipeOptions: { ...get().pipeOptions, ...o } });
      if (get().arch === "pipeline") rerunPipeline();
    },

    seekCycle: (c) => {
      const run = get().pipeRun;
      if (!run || !run.cycles.length) return;
      const cycle = Math.max(1, Math.min(run.cycles.length, Math.round(c)));
      syncTo(run.cycles[cycle - 1].retired);
      set({ pipeCycle: cycle, status: null });
      bump();
    },

    set: (key, value) => set({ [key]: value } as Partial<SimState>),
  };

  /** Re-execute or undo instructions until exactly `n` have run (the pipeline view's retired count). */
  function syncTo(n: number): void {
    const history = get().history;
    while (history.length > n) cpu.undo(history.pop()!);
    while (history.length < n && !cpu.halted) history.push(cpu.step());
    set({ history, segments: [], segIndex: 0, segT: 0 });
  }

  /** Run the program ahead functionally, then compute the pipeline timing for it. */
  function buildPipeline(): void {
    if (!get().program) return;
    syncTo(0);
    const history = get().history;
    while (history.length < PIPE_LIMIT && !cpu.halted) history.push(cpu.step());
    stream = pipeStream(history, textOf);
    rerunPipeline();
  }

  function rerunPipeline(): void {
    const run = simulatePipeline(stream, (pc) => textAt(cpu.mem, pc), get().pipeOptions);
    set({ pipeRun: run });
    const target = Math.min(get().pipeCycle, Math.max(1, run.cycles.length));
    get().seekCycle(target);
  }
});

/** Close the predict prompt after the learner has seen the answer, then continue. */
export function dismissPredict(): void {
  useSim.setState({ predict: null, playing: true });
}

/**
 * Advance the animation clock. Called every animation frame from a single
 * requestAnimationFrame loop (see startClock).
 */
let cycleClock = 0;

function tick(dtMs: number): void {
  const s = useSim.getState();
  if (!s.playing || s.predict) return;
  if (s.arch === "pipeline") {
    cycleClock += dtMs * s.speed;
    if (cycleClock < 650) return;
    cycleClock = 0;
    const total = s.pipeRun?.cycles.length ?? 0;
    if (s.pipeCycle >= total) return useSim.setState({ playing: false });
    s.seekCycle(s.pipeCycle + 1);
    return;
  }
  const seg = s.segments[s.segIndex];
  if (!seg) {
    useSim.setState({ playing: false });
    return;
  }
  const segT = s.segT + (dtMs * s.speed) / seg.duration;
  if (segT < 1) {
    useSim.setState({ segT });
    return;
  }
  // Segment finished.
  const last = s.segIndex >= s.segments.length - 1;
  if (!last) {
    if (s.mode === "segment") {
      useSim.setState({ segT: 1, playing: false });
      return;
    }
    const next = s.segIndex + 1;
    useSim.setState({ segIndex: next, segT: 0 });
    const ps = useSim.getState();
    const nseg = ps.segments[next];
    if (ps.predictMode && nseg?.predict && !ps.answered.has(`${ps.history.length}:${next}`)) {
      useSim.setState({ predict: { ...nseg.predict }, playing: false });
    }
    return;
  }
  useSim.setState({ segT: 1 });
  if (s.mode === "run" && !cpu.halted) {
    const next = entryAt(cpu.pc);
    if (next && s.breakpoints.has(next.line)) {
      useSim.setState({ playing: false, status: `Breakpoint at line ${next.line}.` });
      return;
    }
    useSim.getState().play();
  } else {
    useSim.setState({ playing: false });
  }
}

let clockStarted = false;
export function startClock(): void {
  if (clockStarted || typeof window === "undefined") return;
  clockStarted = true;
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(100, now - last);
    last = now;
    tick(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ───────────── derived views (what the learner should see right now) ─────────────

export function currentRecord(s: SimState): StepRecord | undefined {
  return s.history[s.history.length - 1];
}

/** Has segment `id` of the current instruction been revealed yet? */
export function segmentApplied(s: SimState, id: Segment["id"]): boolean {
  const idx = s.segments.findIndex((x) => x.id === id);
  if (idx < 0) return true;
  return s.segIndex > idx || (s.segIndex === idx && s.segT >= 1);
}

/**
 * Registers as they should appear at the current point in the animation:
 * the destination register keeps its old value until write-back is revealed.
 */
export function displayedRegs(s: SimState): { regs: Int32Array; changed: number | null; pending: number | null } {
  const regs = cpu.regs.slice();
  const rec = currentRecord(s);
  const wb = rec && find(rec.events, "REG_WRITE");
  if (wb && !wb.ignored) {
    if (!segmentApplied(s, "writeBack")) {
      regs[wb.reg] = wb.old;
      return { regs, changed: null, pending: wb.reg };
    }
    return { regs, changed: wb.reg, pending: null };
  }
  return { regs, changed: null, pending: null };
}

export function displayedPc(s: SimState): number {
  const rec = currentRecord(s);
  if (rec && rec.events.length && !segmentApplied(s, "pcUpdate")) return rec.pc;
  return cpu.pc;
}

/** Address of the instruction the UI should highlight (being animated, else next). */
export function focusAddr(s: SimState): number {
  const rec = currentRecord(s);
  if (rec && rec.events.length && !(s.segIndex >= s.segments.length - 1 && s.segT >= 1)) return rec.pc;
  return cpu.pc;
}

export function memWritePending(s: SimState): boolean {
  return !segmentApplied(s, "memory");
}
