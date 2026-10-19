import { useEffect, useRef } from "react";
import { hex32 } from "@/lib/format";
import { cn } from "@/lib/cn";
import { focusAddr, useSim } from "@/store/sim";

/** Address / machine code / real instruction listing with pseudo-instruction ghosts. */
export function Listing() {
  const s = useSim();
  const cur = focusAddr(s);
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ block: "nearest" }), [cur]);

  if (!s.program) return <p className="p-4 text-sm text-muted">Assemble to see the machine-code listing.</p>;
  return (
    <table className="w-full font-mono text-[11px]">
      <thead className="sticky top-0 bg-panel">
        <tr className="text-muted text-left">
          <th className="font-normal pl-3 py-1">addr</th>
          <th className="font-normal">code</th>
          <th className="font-normal">instruction</th>
        </tr>
      </thead>
      <tbody>
        {s.program.text.map((t) => {
          const here = t.addr === cur;
          const bp = s.breakpoints.has(t.line);
          return (
            <tr
              key={t.addr}
              ref={here ? ref : undefined}
              className={cn("border-t border-border/40 cursor-pointer hover:bg-panel-2", here && "bg-warn/15")}
              onClick={() => s.toggleBreakpoint(t.line)}
              title="Click to toggle a breakpoint on this source line"
            >
              <td className="pl-3 py-0.5 text-muted">
                <span className={cn("inline-block w-2", bp ? "text-danger" : "text-transparent")}>●</span>
                {hex32(t.addr).slice(6)}
              </td>
              <td className="text-f-opcode">{hex32(t.word).slice(2)}</td>
              <td>
                {t.asm}
                {t.pseudo && t.pseudo.part === 1 && (
                  <span className="block text-[10px] text-muted">↳ {t.pseudo.source}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
