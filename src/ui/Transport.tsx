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

  return (
    <div className="border-t border-border bg-panel px-2 py-1.5">
      {/* Scrub bar: one tick per segment. */}
      <div className="flex gap-0.5 h-6 items-stretch mb-1.5" role="group" aria-label="Animation segments">
        {segs.length === 0 ? (
          <div className="flex-1 rounded bg-panel-2 text-[11px] text-muted flex items-center px-2">
            {s.program ? (halted ? "Program finished — reset to run again." : "Press play or → to execute the next instruction.") : "Assemble the program to begin."}
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
                <span className="relative px-1 truncate block">{seg.title}</span>
              </button>
            );
          })
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        <IconButton label="Reset" keys="R" onClick={s.reset}><RotateCcw size={16} /></IconButton>
        <IconButton label="Undo instruction" keys="Shift+←" onClick={s.undoInstruction} disabled={s.history.length === 0}>
          <Undo2 size={16} />
        </IconButton>
        <IconButton label="Back one step" keys="←" onClick={s.backSegment} disabled={s.history.length === 0}>
          <ChevronLeft size={18} />
        </IconButton>
        <IconButton
          label={s.playing ? "Pause" : "Play"}
          keys="Space"
          onClick={s.togglePlay}
          disabled={halted && done}
          primary
        >
          {s.playing ? <Pause size={16} /> : <Play size={16} />}
        </IconButton>
        <IconButton label="Next step" keys="→" onClick={s.stepSegment} disabled={halted && done}>
          <ChevronRight size={18} />
        </IconButton>
        <IconButton label="Next instruction" keys="Shift+→" onClick={s.stepInstruction} disabled={halted && done}>
          <ChevronsRight size={18} />
        </IconButton>
        <IconButton label="Run to end or breakpoint (no animation)" keys="E" onClick={s.runToEnd} disabled={halted}>
          <FastForward size={16} />
        </IconButton>
        <IconButton label="Jump to start of this instruction" onClick={() => s.seek(0, 0)} disabled={segs.length === 0}>
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
          <Switch label="Pause each step" checked={s.pauseEachSegment} onCheckedChange={(v) => s.set("pauseEachSegment", v)} />
          <Switch label="Predict" checked={s.predictMode} onCheckedChange={(v) => s.set("predictMode", v)} />
          <Switch label="Skip animation" checked={s.skipAnimation} onCheckedChange={(v) => s.set("skipAnimation", v)} />
          <Switch label="Control wires" checked={s.showControl} onCheckedChange={(v) => s.set("showControl", v)} />
        </div>
      </div>
    </div>
  );
}
