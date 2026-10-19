import { lazy, Suspense } from "react";
import type { Predictor } from "@/pipeline/model";
import type { SceneTheme } from "@/scene/palette";
import { useSim } from "@/store/sim";
import { PipelineDiagram } from "./PipelineDiagram";
import { Switch } from "./components/switch";

const PipelineScene = lazy(() => import("@/scene/PipelineScene"));

const PREDICTORS: { value: Predictor; label: string }[] = [
  { value: "not-taken", label: "always not taken" },
  { value: "taken", label: "always taken (BTB)" },
  { value: "1-bit", label: "1-bit BHT" },
  { value: "2-bit", label: "2-bit BHT" },
];

/** The 5-stage pipeline in 2.5D. */
export function PipelineCanvas({ theme }: { theme: SceneTheme }) {
  const run = useSim((s) => s.pipeRun);
  const cycle = useSim((s) => s.pipeCycle);
  const options = useSim((s) => s.pipeOptions);
  return (
    <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-sm text-muted">Loading pipeline…</div>}>
      <PipelineScene theme={theme} state={run?.cycles[cycle - 1]} options={options} />
    </Suspense>
  );
}

/** Pipeline options and the instructions × cycles diagram. */
export function PipelinePanel() {
  const s = useSim();
  const o = s.pipeOptions;
  const field = "h-7 rounded border border-border bg-panel-2 px-1.5 text-xs text-fg";
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2 border-b border-border text-xs">
        <Switch label="Forwarding" checked={o.forwarding} onCheckedChange={(v) => s.setPipeOptions({ forwarding: v })} />
        <label className="flex items-center gap-1.5 text-muted">
          Branch prediction
          <select className={field} value={o.predictor} onChange={(e) => s.setPipeOptions({ predictor: e.target.value as Predictor })}>
            {PREDICTORS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        {(o.predictor === "1-bit" || o.predictor === "2-bit") && (
          <label className="flex items-center gap-1.5 text-muted">
            BHT entries
            <select className={field} value={o.bhtEntries} onChange={(e) => s.setPipeOptions({ bhtEntries: Number(e.target.value) })}>
              {[1, 4, 16, 64].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5 text-muted">
          mul/div latency
          <select className={field} value={o.mulLatency} onChange={(e) => s.setPipeOptions({ mulLatency: Number(e.target.value), divLatency: Number(e.target.value) * 4 })}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} / {n * 4} cycles</option>)}
          </select>
        </label>
        {s.pipeRun && !s.pipeRun.complete && <span className="text-warn">Showing the first {s.pipeRun.cycles.length} cycles.</span>}
      </div>
      <div className="flex-1 min-h-0">
        {s.pipeRun ? (
          <PipelineDiagram run={s.pipeRun} cycle={s.pipeCycle} onSelectCycle={(c) => s.seekCycle(c)} />
        ) : (
          <p className="p-4 text-sm text-muted">Assemble a program to see it flow through the pipeline.</p>
        )}
      </div>
    </div>
  );
}
