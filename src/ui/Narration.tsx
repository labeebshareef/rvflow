import { BookOpen, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { cpu, currentRecord, entryAt, useSim } from "@/store/sim";
import { Button } from "./components/button";

export function Narration() {
  const s = useSim();
  const seg = s.segments[s.segIndex];
  const rec = currentRecord(s);
  const entry = rec ? entryAt(rec.pc) : undefined;
  const cyc = s.arch === "pipeline" ? s.pipeRun?.cycles[s.pipeCycle - 1] : undefined;
  const text = cyc
    ? cyc.notes.join(" ") || `Cycle ${cyc.cycle}: ${(["IF", "ID", "EX", "MEM", "WB"] as const).map((st) => `${st} ${cyc.stages[st]?.bubble ? "bubble" : cyc.stages[st]?.text ?? "-"}`).join(" · ")}.`
    : seg ? seg.narration : s.status ?? (s.program ? "Ready. Press play to fetch the first instruction." : "Write or pick a program, then assemble it.");

  return (
    <div className="relative border-t border-border bg-panel-2">
      <div className="flex items-start gap-3 px-3 py-2 min-h-14">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-muted">
            {cyc && <span className="font-semibold uppercase tracking-wider text-accent">Cycle {cyc.cycle}</span>}
            {seg && !cyc && (
              <span className="font-semibold uppercase tracking-wider text-accent">
                {s.arch === "multi" && seg.stage ? `${seg.stage} · ` : ""}{s.segIndex + 1}/{s.segments.length} · {seg.title}
              </span>
            )}
            {entry && !cyc && (
              <span className="font-mono truncate">
                {entry.asm}
                {entry.pseudo && <span className="opacity-70"> ← {entry.pseudo.source}</span>}
              </span>
            )}
            {s.score.total > 0 && (
              <span className="ml-auto whitespace-nowrap">
                predictions {s.score.right}/{s.score.total}
              </span>
            )}
          </div>
          <p
            aria-live="polite"
            className={cn("text-sm mt-0.5", seg?.id === "trap" || cpu.halted?.reason === "trap" ? "text-danger" : "text-fg")}
          >
            {text}
          </p>
          {cpu.halted && !cyc && s.segIndex >= s.segments.length - 1 && s.segT >= 1 && seg && (
            <p className={cn("text-sm font-semibold mt-0.5", cpu.halted.reason === "pass" || cpu.halted.reason === "exit" || cpu.halted.reason === "end" ? "text-ok" : "text-danger")}>
              {cpu.halted.message}
            </p>
          )}
        </div>
        {seg && !cyc && (
          <Button size="sm" variant="outline" onClick={() => s.set("explainOpen", !s.explainOpen)} aria-expanded={s.explainOpen}>
            <BookOpen size={14} /> Explain
          </Button>
        )}
      </div>
      {s.explainOpen && seg && (
        <div
          role="region"
          aria-label="Explanation of this step"
          className="absolute bottom-full left-2 right-2 mb-2 rounded-lg border border-border bg-panel p-4 shadow-xl z-20 max-h-72 overflow-auto"
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold">{seg.title}</h3>
            <Button size="sm" variant="ghost" aria-label="Close explanation" onClick={() => s.set("explainOpen", false)}>
              <X size={14} />
            </Button>
          </div>
          <p className="text-sm text-muted mt-1 leading-relaxed">{seg.detail}</p>
          {rec?.decoded && (
            <p className="text-xs text-muted mt-3">
              Spec: <span className="font-mono">{rec.decoded.def.mnemonic}</span> — {rec.decoded.def.semantics}. See the RISC-V
              Unprivileged ISA manual (v20260120), chapter “RV32I Base Integer Instruction Set”
              {rec.decoded.def.ext === "M" ? " and “M Extension for Integer Multiplication and Division”" : ""}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
