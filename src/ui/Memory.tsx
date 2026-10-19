import { useState } from "react";
import { hex32, hexByte } from "@/lib/format";
import { cn } from "@/lib/cn";
import { DATA_BASE } from "@/sim/cpu";
import { find } from "@/sim/trace";
import { cpu, currentRecord, memWritePending, useSim } from "@/store/sim";
import { Button } from "./components/button";

const COLS = 8;
const ROWS = 32;

export function Memory() {
  const s = useSim();
  const [base, setBase] = useState(DATA_BASE);
  const [input, setInput] = useState(hex32(DATA_BASE));
  const rec = currentRecord(s);
  const mw = rec && find(rec.events, "MEM_WRITE");
  const mr = rec && find(rec.events, "MEM_READ");
  const pending = mw && memWritePending(s);
  const touched = mw ?? mr;

  const go = (addr: number) => {
    const a = (addr >>> 0) & ~0xf;
    setBase(a);
    setInput(hex32(a));
  };

  const byteAt = (addr: number) => {
    if (pending && addr >= mw.addr && addr < mw.addr + mw.size) return mw.oldBytes[addr - mw.addr];
    return cpu.mem.readByte(addr);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-border">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = Number(input.trim());
            if (Number.isFinite(v)) go(v);
          }}
          className="flex items-center gap-1.5"
        >
          <label htmlFor="mem-addr" className="text-xs text-muted">Address</label>
          <input
            id="mem-addr"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-28 h-7 rounded border border-border bg-panel-2 px-2 font-mono text-xs"
          />
        </form>
        <Button size="sm" onClick={() => go(DATA_BASE)}>.data</Button>
        <Button size="sm" onClick={() => go(cpu.regs[2])}>sp</Button>
        <Button size="sm" onClick={() => go(s.program?.textBase ?? 0)}>.text</Button>
        {touched && (
          <Button size="sm" onClick={() => go(touched.addr)}>last access</Button>
        )}
        <span className="ml-auto flex gap-0.5">
          <Button size="sm" variant="ghost" aria-label="Previous 256 bytes" onClick={() => go(base - 256)}>↑</Button>
          <Button size="sm" variant="ghost" aria-label="Next 256 bytes" onClick={() => go(base + 256)}>↓</Button>
        </span>
      </div>
      <p className="px-3 py-1.5 text-[11px] text-muted border-b border-border">
        Byte-addressed, little-endian: the word 0x12345678 is stored as <span className="font-mono">78 56 34 12</span>.
      </p>
      <table className="font-mono text-[11px]" key={s.version + (pending ? "p" : "")}>
        <thead>
          <tr className="text-muted">
            <th className="text-left font-normal pl-3 py-1">address</th>
            {Array.from({ length: COLS }, (_, i) => (
              <th key={i} className={cn("font-normal w-6", i % 4 === 0 && "pl-2")}>+{i}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: ROWS }, (_, r) => {
            const rowAddr = (base + r * COLS) >>> 0;
            return (
              <tr key={r} className="border-t border-border/40">
                <td className="pl-3 py-0.5 text-muted">{hex32(rowAddr)}</td>
                {Array.from({ length: COLS }, (_, i) => {
                  const a = (rowAddr + i) >>> 0;
                  const b = byteAt(a);
                  const hit = touched && a >= touched.addr && a < touched.addr + touched.size;
                  const isSp = a === cpu.regs[2] >>> 0;
                  return (
                    <td
                      key={i}
                      className={cn(
                        "text-center",
                        i % 4 === 0 && "pl-2",
                        b === 0 && "text-muted/60",
                        hit && (mw ? (pending ? "bg-warn/20" : "bg-ok/25 text-fg") : "bg-f-rs1/25 text-fg"),
                        isSp && "underline decoration-f-funct7",
                      )}
                      title={`${hex32(a)}${isSp ? " (sp)" : ""}`}
                    >
                      {hexByte(b)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
