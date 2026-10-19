import { CONTROL_HELP, CONTROL_SIGNALS, controlFor } from "@/sim/control";
import { decode } from "@/isa/encoding";
import { cn } from "@/lib/cn";
import { cpu, currentRecord, focusAddr, useSim } from "@/store/sim";
import { Tooltip } from "./components/tooltip";

export function ControlPanel() {
  const s = useSim();
  const rec = currentRecord(s);
  const addr = focusAddr(s);
  const animating = rec && rec.pc === addr && rec.ctrl;
  const d = animating ? rec.decoded : decode(cpu.mem.read(addr, 4));
  const ctrl = animating ? rec.ctrl : d ? controlFor(d.def) : undefined;
  const revealed = !animating || s.segments.findIndex((x) => x.id === "decode") <= s.segIndex;

  if (!s.program) return <p className="p-4 text-sm text-muted">Assemble a program to see control signals.</p>;
  if (!ctrl || !d) return <p className="p-4 text-sm text-muted">No valid instruction at the PC.</p>;

  return (
    <div className="p-3">
      <p className="text-xs text-muted mb-2">
        Main control for <span className="font-mono text-fg">{d.def.mnemonic}</span> ({d.def.animClass.replace("_", "-")} class).
        A classic textbook single-cycle implementation; real cores decode differently.
      </p>
      <table className="w-full text-xs">
        <tbody>
          {CONTROL_SIGNALS.map((k) => {
            const v = ctrl[k];
            const on = v !== null && v !== false;
            return (
              <tr key={k} className="border-t border-border/50">
                <th scope="row" className="text-left font-normal py-1.5">
                  <Tooltip content={CONTROL_HELP[k]} side="left">
                    <span className="font-mono cursor-help">{k}</span>
                  </Tooltip>
                </th>
                <td className={cn("text-right font-mono", !revealed && "blur-sm", on ? "text-f-funct3" : "text-muted")}>
                  {v === true ? "1" : v === false ? "0" : v === null ? "–" : v}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!revealed && <p className="text-[11px] text-muted mt-2">Signals are revealed at the decode step.</p>}
    </div>
  );
}
