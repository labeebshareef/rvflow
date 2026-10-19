import { useId, type ReactNode } from "react";
import { validateConfig, type AccessResult, type CacheConfig, type CacheStats, type CacheView, type Replacement } from "@/cache/cache";
import { hex, hex32 } from "@/lib/format";
import { cn } from "@/lib/cn";
import { FIELD_COLORS } from "@/scene/palette";
import { Badge } from "./components/badge";
import { Button } from "./components/button";
import { Switch } from "./components/switch";
import { ToggleGroup } from "./components/toggle-group";

export interface CachePanelProps {
  caches: { cfg: CacheConfig; view: CacheView; stats: CacheStats; last?: AccessResult }[];
  onConfigChange(index: number, cfg: CacheConfig): void;
  onReset?(): void;
}

const ADDR_COLORS = { tag: FIELD_COLORS.funct7, index: FIELD_COLORS.rs1, offset: FIELD_COLORS.rd };

const SIZES = [64, 128, 256, 512, 1024, 2048, 4096];
const BLOCKS = [4, 8, 16, 32, 64];
const REPLACEMENTS: { value: Replacement; label: string }[] = [
  { value: "LRU", label: "LRU" },
  { value: "FIFO", label: "FIFO" },
  { value: "random", label: "random" },
];

const bytes = (n: number) => (n >= 1024 ? `${n / 1024} KiB` : `${n} B`);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Keeps the associativity legal after the size or block size changes. */
function withGeometry(cfg: CacheConfig, sizeBytes: number, blockBytes: number): CacheConfig {
  const lines = Math.max(1, Math.floor(sizeBytes / blockBytes));
  const wasFull = cfg.ways === cfg.sizeBytes / cfg.blockBytes;
  return { ...cfg, sizeBytes, blockBytes, ways: wasFull ? lines : Math.min(cfg.ways, lines) };
}

const selectCls = "h-7 rounded border border-border bg-panel-2 px-1.5 font-mono text-xs text-fg";

function Field({ label, children, id }: { label: string; children: ReactNode; id?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="text-xs text-muted">{label}</label>
      {children}
    </div>
  );
}

function ConfigEditor({ cfg, onChange }: { cfg: CacheConfig; onChange: (cfg: CacheConfig) => void }) {
  const id = useId();
  const lines = cfg.sizeBytes / cfg.blockBytes;
  const wayOptions = [1, 2, 4, 8, 16].filter((w) => w < lines);
  const error = validateConfig(cfg);
  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Field label="Size" id={`${id}-size`}>
          <select
            id={`${id}-size`}
            className={selectCls}
            value={cfg.sizeBytes}
            onChange={(e) => onChange(withGeometry(cfg, Number(e.target.value), Math.min(cfg.blockBytes, Number(e.target.value))))}
          >
            {SIZES.map((s) => <option key={s} value={s}>{bytes(s)}</option>)}
          </select>
        </Field>
        <Field label="Block" id={`${id}-block`}>
          <select
            id={`${id}-block`}
            className={selectCls}
            value={cfg.blockBytes}
            onChange={(e) => onChange(withGeometry(cfg, cfg.sizeBytes, Number(e.target.value)))}
          >
            {BLOCKS.filter((b) => b <= cfg.sizeBytes).map((b) => <option key={b} value={b}>{b} B</option>)}
          </select>
        </Field>
        <Field label="Ways" id={`${id}-ways`}>
          <select
            id={`${id}-ways`}
            className={selectCls}
            value={cfg.ways}
            onChange={(e) => onChange({ ...cfg, ways: Number(e.target.value) })}
          >
            {wayOptions.map((w) => <option key={w} value={w}>{w === 1 ? "1 (direct)" : w}</option>)}
            <option value={lines}>{lines} (full)</option>
          </select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ToggleGroup label={`${cfg.name} replacement policy`} value={cfg.replacement} onChange={(v) => onChange({ ...cfg, replacement: v })} options={REPLACEMENTS} />
        <ToggleGroup
          label={`${cfg.name} write policy`}
          value={cfg.writeBack ? "wb" : "wt"}
          onChange={(v) => onChange({ ...cfg, writeBack: v === "wb" })}
          options={[{ value: "wb", label: "write-back" }, { value: "wt", label: "write-through" }]}
        />
        <Switch label="write-allocate" checked={cfg.writeAllocate} onCheckedChange={(v) => onChange({ ...cfg, writeAllocate: v })} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Field label="Hit" id={`${id}-hit`}>
          <input
            id={`${id}-hit`}
            type="number"
            min={0}
            value={cfg.hitCycles}
            onChange={(e) => onChange({ ...cfg, hitCycles: num(e.target.value, cfg.hitCycles) })}
            className={cn(selectCls, "w-14")}
          />
        </Field>
        <Field label="Miss penalty" id={`${id}-pen`}>
          <input
            id={`${id}-pen`}
            type="number"
            min={0}
            value={cfg.missPenalty}
            onChange={(e) => onChange({ ...cfg, missPenalty: num(e.target.value, cfg.missPenalty) })}
            className={cn(selectCls, "w-16")}
          />
        </Field>
        <span className="text-[11px] text-muted">cycles</span>
      </div>
      {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

/** The 32-bit address, bit 31 on the left, coloured by tag / index / offset. */
function AddressStrip({ r }: { r: AccessResult }) {
  const { fields: f } = r;
  const addr = r.access.addr >>> 0;
  const kindAt = (bit: number): keyof typeof ADDR_COLORS =>
    bit < f.offsetBits ? "offset" : bit < f.offsetBits + f.indexBits ? "index" : "tag";
  const parts = [
    { kind: "tag" as const, bits: f.tagBits, value: f.tag, hi: 31 },
    { kind: "index" as const, bits: f.indexBits, value: f.index, hi: f.offsetBits + f.indexBits - 1 },
    { kind: "offset" as const, bits: f.offsetBits, value: f.offset, hi: f.offsetBits - 1 },
  ].filter((p) => p.bits > 0);
  return (
    <div
      role="img"
      aria-label={`Address ${hex32(addr)}: ${parts.map((p) => `${p.kind} ${hex(p.value)} (${p.bits} bits)`).join(", ")}`}
    >
      <div className="grid gap-px" style={{ gridTemplateColumns: "repeat(32, minmax(0, 1fr))" }}>
        {Array.from({ length: 32 }, (_, i) => {
          const bit = 31 - i;
          const k = kindAt(bit);
          const on = (addr >>> bit) & 1;
          const boundary = bit !== 31 && kindAt(bit + 1) !== k;
          return (
            <div
              key={bit}
              className={cn("h-5 flex items-center justify-center font-mono text-[10px] font-semibold rounded-[2px]", boundary && "border-l-2 border-panel")}
              style={{ background: `${ADDR_COLORS[k]}${on ? "E6" : "40"}`, color: on ? "#0B1220" : "var(--fg)" }}
              title={`bit ${bit} · ${k}`}
            >
              {on}
            </div>
          );
        })}
      </div>
      <div className="grid gap-px mt-1 text-[10px] font-mono" style={{ gridTemplateColumns: "repeat(32, minmax(0, 1fr))" }}>
        {parts.map((p) => (
          <div
            key={p.kind}
            className="text-center truncate border-t-2 pt-0.5"
            style={{ gridColumn: `${32 - p.hi} / span ${p.bits}`, borderColor: ADDR_COLORS[p.kind] }}
            title={`${p.kind}: ${p.bits} bits = ${hex(p.value)}`}
          >
            <span className="text-muted">{p.bits >= 4 ? `${p.kind} ` : ""}</span>
            {p.bits >= 3 ? hex(p.value) : p.value}
          </div>
        ))}
      </div>
    </div>
  );
}

function LastAccess({ r, cfg }: { r: AccessResult; cfg: CacheConfig }) {
  const all = [r, ...(r.parts ?? [])];
  const notes: string[] = [];
  for (const p of all) {
    if (p.evicted) {
      notes.push(
        `Evicted block ${hex32(p.evicted.blockAddr)} from set ${p.set}` +
          (p.writeback ? " — it was dirty, so it was written back to memory." : " (clean, just dropped)."),
      );
    }
    if (p.access.write && p.way < 0) notes.push("No write-allocate: the store went straight to memory, nothing was cached.");
    else if (p.memWrite) notes.push("Write-through: memory was updated as well.");
    else if (p.access.write && cfg.writeBack) notes.push("Write-back: the line is marked dirty; memory is updated on eviction.");
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs">
          {r.access.kind} {hex32(all[0].access.addr)}
          <span className="text-muted"> · {all.reduce((n, p) => n + p.access.size, 0)} B</span>
        </span>
        {all.map((p, i) => (
          <Badge
            key={i}
            className={cn("font-semibold", p.hit ? "text-ok border-ok/50 bg-ok/10" : "text-warn border-warn/50 bg-warn/10")}
          >
            {p.hit ? "HIT" : "MISS"}
            {p.missKind && <span className="font-normal ml-1">{p.missKind}</span>}
          </Badge>
        ))}
        {r.blocks > 1 && <span className="text-[11px] text-muted">spans {r.blocks} blocks</span>}
      </div>
      <AddressStrip r={r} />
      {notes.length > 0 && (
        <ul className="text-[11px] text-muted space-y-0.5">
          {notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}

function LinesTable({ cfg, view, last }: { cfg: CacheConfig; view: CacheView; last?: AccessResult }) {
  const touched = last ? [last, ...(last.parts ?? [])] : [];
  const tagDigits = Math.ceil((32 - Math.log2(cfg.blockBytes) - Math.log2(view.sets.length)) / 4);
  const showAge = cfg.ways > 1;
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
        <caption className="sr-only">
          {cfg.name} contents: {view.sets.length} sets × {cfg.ways} ways
        </caption>
        <thead>
          <tr className="text-muted text-left">
            <th scope="col" className="font-normal py-1 pl-1">set</th>
            {cfg.ways > 1 && <th scope="col" className="font-normal">way</th>}
            <th scope="col" className="font-normal text-center"><abbr title="valid">V</abbr></th>
            <th scope="col" className="font-normal text-center"><abbr title="dirty">D</abbr></th>
            <th scope="col" className="font-normal">tag</th>
            <th scope="col" className="font-normal">block</th>
            {showAge && (
              <th scope="col" className="font-normal text-right pr-1">
                <abbr title={cfg.replacement === "FIFO" ? "fill order: 0 = newest, highest = next victim" : "recency: 0 = most recently used, highest = next victim"}>age</abbr>
              </th>
            )}
          </tr>
        </thead>
        {view.sets.map((s) => {
          const setHit = touched.find((t) => t.set === s.index);
          return (
            <tbody key={s.index} className={cn("border-t border-border/60", setHit && "bg-accent/5")}>
              {s.lines.map((l, w) => {
                const t = touched.find((x) => x.set === s.index && x.way === w);
                return (
                  <tr
                    key={w}
                    className={cn(
                      w > 0 && "border-t border-border/30",
                      !l.valid && "text-muted/60",
                      t && (t.hit ? "bg-ok/25 text-fg" : "bg-warn/25 text-fg"),
                    )}
                  >
                    {w === 0 && (
                      <th
                        scope="rowgroup"
                        rowSpan={s.lines.length}
                        className={cn("text-left font-normal align-top py-0.5 pl-1", setHit ? "text-f-rs1 font-semibold" : "text-muted")}
                      >
                        {s.index}
                      </th>
                    )}
                    {cfg.ways > 1 && <td className="py-0.5 text-muted">{w}</td>}
                    <td className="text-center">{l.valid ? 1 : 0}</td>
                    <td className={cn("text-center", l.dirty && "text-warn font-semibold")}>{l.dirty ? "D" : "·"}</td>
                    <td className={cn(l.valid && "text-f-funct7")}>{l.valid ? hex(l.tag, tagDigits) : "—"}</td>
                    <td className={cn(l.valid ? "text-muted" : "")}>{l.valid ? hex32(l.blockAddr) : ""}</td>
                    {showAge && <td className="text-right pr-1">{l.age >= 0 ? l.age : ""}</td>}
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function Stats({ stats, cfg }: { stats: CacheStats; cfg: CacheConfig }) {
  const rows: [string, ReactNode][] = [
    ["accesses", `${stats.accesses} (${stats.reads} R / ${stats.writes} W)`],
    ["hit rate", stats.accesses ? `${pct(stats.hitRate)} (${stats.hits} hits)` : "—"],
    ["misses", `${stats.misses}: ${stats.compulsory} compulsory · ${stats.capacity} capacity · ${stats.conflict} conflict`],
    ["memory writes", `${stats.writebacks} write-backs · ${stats.memWrites} write-through`],
    [
      "AMAT",
      <>
        <span className="font-semibold text-fg">{stats.amat.toFixed(2)}</span>
        <span className="text-muted"> = {cfg.hitCycles} + {stats.accesses ? pct(1 - stats.hitRate) : "0%"} × {cfg.missPenalty} cycles</span>
      </>,
    ],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CacheSection({ c, onChange }: { c: CachePanelProps["caches"][number]; onChange: (cfg: CacheConfig) => void }) {
  const { cfg, view, stats, last } = c;
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="border-b border-border">
      <div className="px-3 py-2 space-y-2 border-b border-border/60">
        <h3 id={headingId} className="flex items-baseline gap-2 text-xs font-semibold">
          {cfg.name}
          <span className="font-normal text-muted">
            {bytes(cfg.sizeBytes)} · {cfg.blockBytes} B blocks · {cfg.ways === 1 ? "direct-mapped" : cfg.ways === cfg.sizeBytes / cfg.blockBytes ? "fully associative" : `${cfg.ways}-way`}
          </span>
        </h3>
        <ConfigEditor cfg={cfg} onChange={onChange} />
      </div>
      <div className="px-3 py-2 border-b border-border/60">
        {last ? <LastAccess r={last} cfg={cfg} /> : <p className="text-[11px] text-muted">No accesses yet.</p>}
      </div>
      <div className="px-2 py-1.5 border-b border-border/60">
        <LinesTable cfg={cfg} view={view} last={last} />
      </div>
      <div className="px-3 py-2">
        <Stats stats={stats} cfg={cfg} />
      </div>
    </section>
  );
}

export function CachePanel({ caches, onConfigChange, onReset }: CachePanelProps) {
  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-start gap-2 px-3 py-1.5 border-b border-border">
        <p className="text-[11px] text-muted">
          Address = <span style={{ color: ADDR_COLORS.tag }}>tag</span> | <span style={{ color: ADDR_COLORS.index }}>index</span> |{" "}
          <span style={{ color: ADDR_COLORS.offset }}>offset</span>. The index picks a set, the tag is compared with every way in it, and the
          offset selects the byte inside the block.
        </p>
        {onReset && (
          <Button size="sm" className="ml-auto shrink-0" onClick={onReset}>Reset</Button>
        )}
      </div>
      {caches.map((c, i) => (
        <CacheSection key={i} c={c} onChange={(cfg) => onConfigChange(i, cfg)} />
      ))}
    </div>
  );
}
