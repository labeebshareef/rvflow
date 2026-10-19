import { ChevronFirst, ChevronLeft, ChevronRight, ChevronsRight, FastForward, Pause, Play, RotateCcw, Undo2 } from "lucide-react";
import { totalDuration } from "@/anim/choreography";
import { cn } from "@/lib/cn";
import { cpu, useSim } from "@/store/sim";
import { Button } from "./components/button";
import { Slider } from "./components/slider";
import { Switch } from "./components/switch";
import { Tooltip } from "./components/tooltip";

const SPEEDS = [0.25, 0.5, 1, 2, 4];

function IconButton({ label, keys, onClick, disabled, children, primary }: {
  label: string; keys?: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; primary?: boolean;
}) {
  return (
    <Tooltip content={keys ? `${label} (${keys})` : label}>
      <Button size="icon" variant={primary ? "primary" : "ghost"} aria-label={label} onClick={onClick} disabled={disabled}>
        {children}
      </Button>
    </Tooltip>
  );
}

/** Play / step / scrub controls and the segment tick bar. */
export function Transport() {
  const s = useSim();
  const halted = !!cpu.halted;
  const segs = s.segments;
  const total = totalDuration(segs) || 1;
  const done = segs.length === 0 || (s.segIndex >= segs.length - 1 && s.segT >= 1);
  const speedIdx = Math.max(0, SPEEDS.indexOf(s.speed));
  const pipe = s.arch === "pipeline";
  const totalCycles = s.pipeRun?.cycles.length ?? 0;
  const unit = pipe ? "cycle" : "step";

  return (
    <div className="border-t border-border bg-panel px-2 py-1.5">
      {/* Scrub bar: one tick per segment (or a cycle slider in pipeline mode). */}
      {pipe ? (
        <div className="flex items-center gap-3 h-6 mb-1.5 px-1">
          <span className="text-[11px] text-muted tabular-nums whitespace-nowrap">cycle {s.pipeCycle} / {totalCycles}</span>
          <Slider
            aria-label="Pipeline cycle"
            min={1}
            max={Math.max(1, totalCycles)}
            step={1}
            value={[s.pipeCycle]}
            onValueChange={([v]) => s.seekCycle(v)}
            className="flex-1"
          />
          <span className="text-[11px] text-muted tabular-nums whitespace-nowrap">{s.pipeRun?.cycles[s.pipeCycle - 1]?.retired ?? 0} retired</span>
        </div>
      ) : (
      <div className="flex gap-0.5 h-6 items-stretch mb-1.5" role="group" aria-label="Animation segments">
        {segs.length === 0 ? (
          <div className="flex-1 rounded bg-panel-2 text-[11px] text-muted flex items-center px-2">
            {s.program ? (halted ? "Program finished — reset to run again." : "Press play or → to execute the next instruction.") : "Assemble the program to begin."}
            {s.arch === "multi" && s.program && !halted && " Multi-cycle: each colored group is one clock cycle."}
          </div>
        ) : (
          segs.map((seg, i) => {
            const fill = i < s.segIndex ? 1 : i === s.segIndex ? s.segT : 0;
            return (
              <button
                key={`${seg.id}-${i}`}
                onClick={() => s.seek(i)}
                className={cn(
                  "relative rounded overflow-hidden bg-panel-2 text-[10px] text-muted hover:text-fg min-w-0",
                  "focus-visible:outline-2 focus-visible:outline-accent",
                  i === s.segIndex && "text-fg ring-1 ring-accent/60",
                )}
                style={{ flexGrow: seg.duration / total }}
                aria-label={`Segment ${i + 1}: ${seg.title}`}
                aria-current={i === s.segIndex ? "step" : undefined}
              >
                <span className="absolute inset-y-0 left-0 bg-accent/30" style={{ width: `${fill * 100}%` }} />
                <span className="relative px-1 truncate block">
                  {s.arch === "multi" && seg.stage && (i === 0 || segs[i - 1].stage !== seg.stage) && (
                    <span className="font-semibold text-accent mr-1">{seg.stage}</span>
                  )}
                  {seg.title}
                </span>
              </button>
            );
          })
        )}
      </div>
      )}

      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        <IconButton label="Reset" keys="R" onClick={s.reset}><RotateCcw size={16} /></IconButton>
        <IconButton label={pipe ? "Back 5 cycles" : "Undo instruction"} keys="Shift+←" onClick={s.undoInstruction} disabled={pipe ? s.pipeCycle <= 1 : s.history.length === 0}>
          <Undo2 size={16} />
        </IconButton>
        <IconButton label={`Back one ${unit}`} keys="←" onClick={s.backSegment} disabled={pipe ? s.pipeCycle <= 1 : s.history.length === 0}>
          <ChevronLeft size={18} />
        </IconButton>
        <IconButton
          label={s.playing ? "Pause" : "Play"}
          keys="Space"
          onClick={s.togglePlay}
          disabled={!pipe && halted && done}
          primary
        >
          {s.playing ? <Pause size={16} /> : <Play size={16} />}
        </IconButton>
        <IconButton label={`Next ${unit}`} keys="→" onClick={s.stepSegment} disabled={pipe ? s.pipeCycle >= totalCycles : halted && done}>
          <ChevronRight size={18} />
        </IconButton>
        <IconButton label={pipe ? "Forward 5 cycles" : "Next instruction"} keys="Shift+→" onClick={s.stepInstruction} disabled={pipe ? s.pipeCycle >= totalCycles : halted && done}>
          <ChevronsRight size={18} />
        </IconButton>
        <IconButton label={pipe ? "Last cycle" : "Run to end or breakpoint (no animation)"} keys="E" onClick={s.runToEnd} disabled={!pipe && halted}>
          <FastForward size={16} />
        </IconButton>
        <IconButton label={pipe ? "First cycle" : "Jump to start of this instruction"} onClick={() => (pipe ? s.seekCycle(1) : s.seek(0, 0))} disabled={pipe ? false : segs.length === 0}>
          <ChevronFirst size={16} />
        </IconButton>

        <div className="flex items-center gap-2 ml-2 w-32">
          <span className="text-[11px] text-muted w-9 tabular-nums">{s.speed}×</span>
          <Slider
            aria-label="Animation speed"
            min={0}
            max={SPEEDS.length - 1}
            step={1}
            value={[speedIdx]}
            onValueChange={([v]) => s.set("speed", SPEEDS[v])}
            className="flex-1"
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 ml-auto pr-1">
          {!pipe && (
            <>
              <Switch label="Pause each step" checked={s.pauseEachSegment} onCheckedChange={(v) => s.set("pauseEachSegment", v)} />
              <Switch label="Predict" checked={s.predictMode} onCheckedChange={(v) => s.set("predictMode", v)} />
              <Switch label="Skip animation" checked={s.skipAnimation} onCheckedChange={(v) => s.set("skipAnimation", v)} />
              <Switch label="Control wires" checked={s.showControl} onCheckedChange={(v) => s.set("showControl", v)} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
