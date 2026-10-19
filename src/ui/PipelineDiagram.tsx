import { useEffect, useMemo, useRef, type JSX } from "react";
import { cn } from "@/lib/cn";
import { FLUSH_COLOR, ON_STAGE_INK, STAGE_COLORS, STALL_COLOR } from "@/pipeline/colors";
import { STAGES, type PipelineRun, type Row, type RowCell } from "@/pipeline/model";

/** Cycles shown either side of the current one. */
const WINDOW = 30;
const COL_W = 34; // px; fits "MEM" at 10px mono

interface Props {
  run: PipelineRun;
  /** Currently shown cycle, 1-based. */
  cycle: number;
  onSelectCycle(c: number): void;
  maxRows?: number;
}

function cellAt(row: Row, c: number): RowCell | undefined {
  // A row occupies one stage every cycle from fetch to WB / flush, so cells are contiguous.
  const first = row.cells[0]?.cycle;
  if (first === undefined) return undefined;
  const cell = row.cells[c - first];
  return cell?.cycle === c ? cell : row.cells.find((x) => x.cycle === c);
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex flex-col leading-tight min-w-0">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className={cn("font-mono text-xs tabular-nums text-fg", tone)}>{value}</span>
    </div>
  );
}

/** Konata / textbook-style pipeline diagram: instructions down, cycles across. */
export function PipelineDiagram({ run, cycle, onSelectCycle, maxRows = 120 }: Props): JSX.Element {
  const total = run.cycles.length;
  const cur = Math.min(Math.max(1, cycle), Math.max(1, total));
  const lo = Math.max(1, cur - WINDOW);
  const hi = Math.min(total, cur + WINDOW);
  const cols = useMemo(() => Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i), [lo, hi]);

  const { rows, hiddenAbove, hiddenBelow } = useMemo(() => {
    const touching = run.rows.filter((r) => {
      const a = r.cells[0]?.cycle;
      const b = r.cells.at(-1)?.cycle;
      return a !== undefined && b !== undefined && a <= hi && b >= lo;
    });
    if (touching.length <= maxRows) return { rows: touching, hiddenAbove: 0, hiddenBelow: 0 };
    // Centre the cap on the rows that are in flight in the current cycle.
    const live = touching.findIndex((r) => r.cells.at(-1)!.cycle >= cur);
    const start = Math.max(0, Math.min(touching.length - maxRows, (live < 0 ? touching.length : live) - Math.floor(maxRows / 3)));
    return {
      rows: touching.slice(start, start + maxRows),
      hiddenAbove: start,
      hiddenBelow: touching.length - start - maxRows,
    };
  }, [run.rows, lo, hi, cur, maxRows]);

  const scroller = useRef<HTMLDivElement>(null);
  const curHead = useRef<HTMLTableCellElement>(null);
  useEffect(() => {
    const box = scroller.current;
    const th = curHead.current;
    if (!box || !th) return;
    const left = th.offsetLeft - box.clientWidth / 2 + COL_W / 2;
    box.scrollTo({ left: Math.max(0, left), behavior: "auto" });
  }, [cur, lo]);

  const s = run.stats;
  const state = run.cycles[cur - 1];

  return (
    <div className="@container flex flex-col h-full min-h-0 bg-panel">
      <div className="grid grid-cols-4 @2xl:grid-cols-8 gap-x-3 gap-y-1.5 px-3 py-2 border-b border-border bg-panel-2">
        <Stat label="cycles" value={run.complete ? s.cycles : `${s.cycles}+`} tone={run.complete ? undefined : "text-warn"} />
        <Stat label="instrs" value={s.instructions} />
        <Stat label="CPI" value={s.instructions ? s.cpi.toFixed(2) : "-"} />
        <Stat label="stalls" value={s.stallCycles} tone={s.stallCycles ? "text-warn" : undefined} />
        <Stat label="load-use" value={s.loadUseStalls} />
        <Stat label="flushes" value={s.flushes} tone={s.flushes ? "text-danger" : undefined} />
        <Stat label="mispred" value={`${s.mispredicts}/${s.branches}`} />
        <Stat label="accuracy" value={s.branches ? `${(s.accuracy * 100).toFixed(1)}%` : "-"} />
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-1 border-b border-border text-[11px] text-muted font-mono">
        <span>
          cycle <span className="text-fg">{total ? cur : 0}</span>/{total}
          {state && <span className="ml-2">retired {state.retired}</span>}
        </span>
        <span className="flex items-center gap-2" aria-hidden>
          {STAGES.map((st) => (
            <span key={st} className="inline-flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: STAGE_COLORS[st] }} />
              <span className="hidden @md:inline">{st}</span>
            </span>
          ))}
        </span>
      </div>

      {total === 0 ? (
        <p className="p-4 text-sm text-muted">Run a program to see its pipeline diagram.</p>
      ) : (
        <div ref={scroller} className="relative flex-1 min-h-0 overflow-auto">
          <table className="border-separate border-spacing-0 font-mono text-[10px]">
            <caption className="sr-only">
              Pipeline diagram, cycles {lo} to {hi}. Rows are instructions; each cell is the stage the instruction occupies.
            </caption>
            <thead className="sticky top-0 z-20">
              <tr>
                <th scope="col" className="sticky left-0 z-30 bg-panel border-b border-r border-border text-left font-normal text-muted px-2 py-1">
                  <div className="w-32 @2xl:w-44 truncate">{lo > 1 ? `<- ${lo - 1} earlier cycles` : "instruction"}</div>
                </th>
                {cols.map((c) => {
                  const here = c === cur;
                  const ev = run.cycles[c - 1];
                  return (
                    <th key={c} ref={here ? curHead : undefined} scope="col" className="p-0 bg-panel border-b border-border font-normal" style={{ width: COL_W, minWidth: COL_W }}>
                      <button
                        type="button"
                        onClick={() => onSelectCycle(c)}
                        aria-current={here ? "true" : undefined}
                        aria-label={`Show cycle ${c}`}
                        className={cn(
                          "w-full h-6 flex flex-col items-center justify-center tabular-nums leading-none transition-colors",
                          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                          here ? "bg-accent text-accent-fg font-semibold" : "text-muted hover:bg-panel-2 hover:text-fg",
                        )}
                      >
                        {c}
                        <span className="h-1 flex gap-0.5 mt-0.5">
                          {ev?.stall && <span className="w-1 h-1 rounded-full" style={{ background: STALL_COLOR }} />}
                          {ev?.flush && <span className="w-1 h-1 rounded-full" style={{ background: FLUSH_COLOR }} />}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {hiddenAbove > 0 && <MoreRow n={hiddenAbove} span={cols.length} />}
              {rows.map((r) => (
                <tr key={r.rowId}>
                  <th
                    scope="row"
                    title={`${r.wrongPath ? "wrong path: " : ""}0x${(r.pc >>> 0).toString(16)}  ${r.text}`}
                    className={cn(
                      "sticky left-0 z-10 bg-panel border-r border-b border-border/50 text-left font-normal px-2 py-0 h-5",
                      r.wrongPath && "text-muted line-through opacity-60",
                    )}
                  >
                    <div className="w-32 @2xl:w-44 truncate">{r.text}</div>
                  </th>
                  {cols.map((c) => (
                    <Cell key={c} cell={cellAt(r, c)} current={c === cur} wrongPath={r.wrongPath} />
                  ))}
                </tr>
              ))}
              {hiddenBelow > 0 && <MoreRow n={hiddenBelow} span={cols.length} />}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MoreRow({ n, span }: { n: number; span: number }) {
  return (
    <tr>
      <td className="sticky left-0 bg-panel px-2 py-0.5 text-muted border-b border-border/50">... {n} more</td>
      <td colSpan={span} className="border-b border-border/50" />
    </tr>
  );
}

const HATCH = `repeating-linear-gradient(135deg, color-mix(in srgb, ${STALL_COLOR} 45%, transparent) 0 3px, transparent 3px 6px)`;

function Cell({ cell, current, wrongPath }: { cell: RowCell | undefined; current: boolean; wrongPath: boolean }) {
  const base = cn("p-0 h-5 text-center border-b border-border/30", current && "bg-accent/10");
  if (!cell) return <td className={base} />;
  if (cell.stage === "stall") {
    return (
      <td className={base} title="stall">
        <span className="flex items-center justify-center h-4 mx-px rounded-sm text-warn font-bold" style={{ backgroundImage: HATCH }}>
          *
        </span>
      </td>
    );
  }
  if (cell.stage === "flush") {
    return (
      <td className={base} title="flushed">
        <span
          className="flex items-center justify-center h-4 mx-px rounded-sm font-bold text-danger border border-dashed"
          style={{ borderColor: FLUSH_COLOR }}
        >
          x
        </span>
      </td>
    );
  }
  const color = STAGE_COLORS[cell.stage];
  return (
    <td className={base}>
      <span
        className={cn("flex items-center justify-center h-4 mx-px rounded-sm leading-none", current && "font-bold")}
        style={
          current
            ? { background: color, color: ON_STAGE_INK }
            : { background: `color-mix(in srgb, ${color} ${wrongPath ? 14 : 26}%, transparent)`, boxShadow: `inset 2px 0 0 ${color}` }
        }
      >
        {cell.stage}
      </span>
    </td>
  );
}
