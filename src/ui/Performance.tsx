import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { simulatePipeline } from "@/pipeline/model";
import { multiCycles, pipeStream, textAt } from "@/store/derived";
import { cpu, currentRecord, useSim } from "@/store/sim";

/** Textbook stage latencies (ps) used to compare implementations. */
const T = { IF: 200, ID: 100, EX: 200, MEM: 200, WB: 100 };
const SINGLE_PERIOD = T.IF + T.ID + T.EX + T.MEM + T.WB; // the slowest instruction (a load) sets the clock
const STAGE_PERIOD = Math.max(...Object.values(T));

const FSM: { id: string; label: string; x: number; y: number }[] = [
  { id: "IF", label: "Fetch", x: 20, y: 20 },
  { id: "ID", label: "Decode", x: 120, y: 20 },
  { id: "EX", label: "Execute", x: 220, y: 20 },
  { id: "MEM", label: "Memory", x: 220, y: 90 },
  { id: "WB", label: "Write back", x: 120, y: 90 },
];

/** Multi-cycle control FSM and a single-cycle vs multi-cycle vs pipeline comparison. */
export function Performance() {
  const s = useSim();
  const n = s.history.filter((r) => r.retired).length;
  const multi = useMemo(() => s.history.reduce((a, r) => a + multiCycles(r), 0), [s.history, s.version]);
  const pipe = useMemo(() => {
    if (s.arch === "pipeline" && s.pipeRun) return s.pipeRun;
    const stream = pipeStream(s.history, (r) => r.decoded?.def.mnemonic ?? "?");
    return simulatePipeline(stream, (pc) => textAt(cpu.mem, pc), s.pipeOptions);
  }, [s.history, s.version, s.arch, s.pipeRun, s.pipeOptions]);
  const pipeN = pipe.stats.instructions;
  const rec = currentRecord(s);
  const seg = s.segments[s.segIndex];
  const cycles = rec ? multiCycles(rec) : 0;
  const row = (name: string, c: number, period: number, instrs: number, note: string) => ({ name, c, period, time: c * period, cpi: instrs ? c / instrs : 0, note });
  const rows = [
    row("Single-cycle", n, SINGLE_PERIOD, n, "1 cycle per instruction, but the clock must fit the slowest one (a load)."),
    row("Multi-cycle", multi, STAGE_PERIOD, n, "3–5 short cycles per instruction; each class takes only the steps it needs."),
    row("5-stage pipeline", pipe.stats.cycles, STAGE_PERIOD, pipeN, `Overlaps instructions; stalls ${pipe.stats.stallCycles}, flushes ${pipe.stats.flushes}.`),
  ];
  const best = Math.min(...rows.filter((r) => r.c).map((r) => r.time));

  return (
    <div className="p-3 space-y-4 text-xs">
      <section>
        <h3 className="font-semibold text-sm mb-1">Multi-cycle control FSM</h3>
        <p className="text-muted mb-2">
          One step per clock. {rec?.decoded ? <>The last instruction, <span className="font-mono text-fg">{rec.decoded.def.mnemonic}</span>, takes {cycles} cycle{cycles === 1 ? "" : "s"}.</> : "Run an instruction to see its path."}
          {s.arch !== "multi" && " Switch to Multi-cycle to step through it cycle by cycle."}
        </p>
        <svg viewBox="0 0 320 145" className="w-full max-w-sm" role="img" aria-label="Multi-cycle FSM: Fetch, Decode, Execute, Memory, Write back">
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
            </marker>
          </defs>
          {[["IF", "ID"], ["ID", "EX"], ["EX", "MEM"], ["MEM", "WB"]].map(([a, b]) => {
            const A = FSM.find((f) => f.id === a)!;
            const B = FSM.find((f) => f.id === b)!;
            const horiz = A.y === B.y;
            return (
              <line key={a + b} x1={A.x + (horiz ? (B.x > A.x ? 80 : 0) : 40)} y1={A.y + (horiz ? 17 : 34)} x2={B.x + (horiz ? (B.x > A.x ? 0 : 80) : 40)} y2={B.y + (horiz ? 17 : 0)} stroke="var(--muted)" markerEnd="url(#arr)" />
            );
          })}
          <path d="M120,107 C 40,125 20,80 50,54" fill="none" stroke="var(--muted)" markerEnd="url(#arr)" />
          <path d="M260,54 C 300,70 300,10 300,10 L 300,6 C 200,0 100,0 60,18" fill="none" stroke="var(--muted)" strokeDasharray="3 3" markerEnd="url(#arr)" />
          {FSM.map((f) => {
            const on = seg?.stage === f.id && s.arch === "multi";
            return (
              <g key={f.id}>
                <rect x={f.x} y={f.y} width={80} height={34} rx={8} fill={on ? "var(--accent)" : "var(--panel-2)"} stroke="var(--border)" />
                <text x={f.x + 40} y={f.y + 21} textAnchor="middle" fontSize="11" fill={on ? "var(--accent-fg)" : "var(--fg)"}>{f.label}</text>
              </g>
            );
          })}
          <text x="310" y="140" textAnchor="end" fontSize="9" fill="var(--muted)">dashed: branches and jumps finish in Execute</text>
        </svg>
      </section>

      <section>
        <h3 className="font-semibold text-sm mb-1">Single-cycle vs multi-cycle vs pipeline</h3>
        <p className="text-muted mb-2">
          For the {n} instruction{n === 1 ? "" : "s"} executed so far, with textbook stage delays IF {T.IF} ps, ID {T.ID}, EX {T.EX}, MEM {T.MEM}, WB {T.WB}.
        </p>
        <table className="w-full">
          <thead>
            <tr className="text-muted text-left">
              <th className="font-normal py-1">model</th>
              <th className="font-normal text-right">cycles</th>
              <th className="font-normal text-right">clock</th>
              <th className="font-normal text-right">CPI</th>
              <th className="font-normal text-right">time</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((r) => (
              <tr key={r.name} className={cn("border-t border-border/50", r.c && r.time === best && "text-ok")}>
                <td className="py-1 font-sans">{r.name}</td>
                <td className="text-right">{r.c}</td>
                <td className="text-right">{r.period} ps</td>
                <td className="text-right">{r.cpi.toFixed(2)}</td>
                <td className="text-right">{(r.time / 1000).toFixed(1)} ns</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="mt-2 space-y-1 text-muted">
          {rows.map((r) => <li key={r.name}><span className="text-fg">{r.name}:</span> {r.note}</li>)}
        </ul>
        <p className="text-muted mt-2">Time = cycles × clock period. The pipeline count includes its 4 fill cycles and is computed with the current pipeline options.</p>
      </section>
    </div>
  );
}
