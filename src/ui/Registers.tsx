import { ABI_NAMES, REG_ROLES } from "@/isa/registers";
import { fmtValue, hex32, type Radix } from "@/lib/format";
import { cn } from "@/lib/cn";
import { displayedPc, displayedRegs, useSim } from "@/store/sim";
import { ToggleGroup } from "./components/toggle-group";
import { Tooltip } from "./components/tooltip";

const RADIXES: { value: Radix; label: string }[] = [
  { value: "hex", label: "hex" },
  { value: "dec", label: "dec" },
  { value: "udec", label: "udec" },
  { value: "bin", label: "bin" },
];

export function Registers() {
  const s = useSim();
  const { regs, changed, pending } = displayedRegs(s);
  const pc = displayedPc(s);
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <ToggleGroup label="Number format" value={s.radix} onChange={(v) => s.set("radix", v)} options={RADIXES} />
        <ToggleGroup
          label="Register names"
          value={s.abiNames ? "abi" : "x"}
          onChange={(v) => s.set("abiNames", v === "abi")}
          options={[{ value: "abi", label: "ABI" }, { value: "x", label: "x#" }]}
        />
      </div>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-panel-2 font-mono text-xs">
        <span className="text-f-funct7 font-semibold">pc</span>
        <span>{hex32(pc)}</span>
      </div>
      <table className="w-full text-xs font-mono">
        <caption className="sr-only">Integer registers x0 to x31</caption>
        <tbody>
          {Array.from(regs).map((v, i) => (
            <tr
              key={`${i}-${changed === i ? s.version : 0}`}
              className={cn(
                "border-b border-border/50",
                changed === i && "flash",
                pending === i && "outline outline-1 outline-dashed outline-warn -outline-offset-1",
              )}
            >
              <th scope="row" className="text-left font-normal py-1 pl-3 w-24">
                <Tooltip content={`x${i} · ${ABI_NAMES[i]} — ${REG_ROLES[i]}`} side="left">
                  <span className={cn("cursor-help", i === 0 ? "text-muted" : "text-f-rd")}>
                    {s.abiNames ? ABI_NAMES[i] : `x${i}`}
                    <span className="text-muted ml-1.5">{s.abiNames ? `x${i}` : ABI_NAMES[i]}</span>
                  </span>
                </Tooltip>
              </th>
              <td className={cn("text-right pr-3 tabular-nums", v === 0 && "text-muted", s.radix === "bin" && "text-[10px]")}>
                {fmtValue(v, s.radix)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
