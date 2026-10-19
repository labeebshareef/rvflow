import { cpu, useSim } from "@/store/sim";

export function Console() {
  const s = useSim();
  void s.version;
  return (
    <div className="p-3 h-full flex flex-col gap-2">
      <p className="text-[11px] text-muted">
        Output from <span className="font-mono">ecall</span> (a7 = 1 int, 4 string, 11 char, 34 hex, 10/93 exit). These
        services belong to the simulator environment, not the ISA.
      </p>
      <pre
        aria-live="polite"
        className="flex-1 min-h-24 rounded-md border border-border bg-panel-2 p-2.5 font-mono text-xs whitespace-pre-wrap break-all"
      >
        {cpu.output || <span className="text-muted">(no output yet)</span>}
      </pre>
      <p className="text-xs text-muted">
        Instructions retired: <span className="font-mono text-fg">{cpu.instret}</span>
        {cpu.halted && <span className="ml-2">· {cpu.halted.message}</span>}
      </p>
    </div>
  );
}
