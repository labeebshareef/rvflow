import { useState } from "react";
import { ABI_NAMES, FP_ABI_NAMES, REG_ROLES } from "@/isa/registers";
import { CAUSES, INTERRUPTS, MSTATUS, PRIV_NAMES } from "@/isa/csr";
import { fmtValue, hex32, type Radix } from "@/lib/format";
import { cn } from "@/lib/cn";
import { fpText } from "@/anim/choreography";
import { MISA } from "@/sim/cpu";
import { find } from "@/sim/trace";
import { readMaskBit, readVElem, vtypeInfo, VLENB } from "@/sim/vector";
import { cpu, currentRecord, displayedPc, displayedRegs, segmentApplied, useSim } from "@/store/sim";
import { Badge } from "./components/badge";
import { ToggleGroup } from "./components/toggle-group";
import { Tooltip } from "./components/tooltip";

const RADIXES: { value: Radix; label: string }[] = [
  { value: "hex", label: "hex" },
  { value: "dec", label: "dec" },
  { value: "udec", label: "udec" },
  { value: "bin", label: "bin" },
];

type View = "x" | "f" | "csr" | "v";

export function Registers() {
  const s = useSim();
  const [view, setView] = useState<View>("x");
  void s.version;
  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <ToggleGroup
          label="Register file"
          value={view}
          onChange={setView}
          options={[{ value: "x", label: "x" }, { value: "f", label: "f" }, { value: "csr", label: "CSR" }, { value: "v", label: "v" }]}
        />
        {view === "x" && <ToggleGroup label="Number format" value={s.radix} onChange={(v) => s.set("radix", v)} options={RADIXES} />}
        {view === "x" && (
          <ToggleGroup
            label="Register names"
            value={s.abiNames ? "abi" : "x"}
            onChange={(v) => s.set("abiNames", v === "abi")}
            options={[{ value: "abi", label: "ABI" }, { value: "x", label: "x#" }]}
          />
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-panel-2 font-mono text-xs">
        <span>
          <span className="text-f-funct7 font-semibold">pc</span> {hex32(displayedPc(s))}
        </span>
        <Tooltip content="Current privilege mode: M (machine), S (supervisor) or U (user)">
          <Badge className="cursor-help">{PRIV_NAMES[cpu.priv]}-mode</Badge>
        </Tooltip>
      </div>
      {view === "x" && <IntRegs />}
      {view === "f" && <FpRegs />}
      {view === "csr" && <Csrs />}
      {view === "v" && <VecRegs />}
    </div>
  );
}

function IntRegs() {
  const s = useSim();
  const { regs, changed, pending } = displayedRegs(s);
  return (
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
  );
}

function FpRegs() {
  const s = useSim();
  const rec = currentRecord(s);
  const w = rec && find(rec.events, "FREG_WRITE");
  const pending = w && !segmentApplied(s, "fpWrite") ? w : undefined;
  const flags = cpu.csr.get(0x003) ?? 0;
  return (
    <div>
      <p className="px-3 py-1.5 text-[11px] text-muted border-b border-border">
        64-bit registers. A single-precision value is NaN-boxed (upper 32 bits all ones) and shown as <span className="font-mono">s</span>.
        frm = <span className="font-mono text-fg">{["rne", "rtz", "rdn", "rup", "rmm", "?", "?", "?"][(flags >> 5) & 7]}</span>, fflags ={" "}
        <span className="font-mono text-fg">{["NX", "UF", "OF", "DZ", "NV"].filter((_, i) => flags & (1 << i)).join(" ") || "none"}</span>
      </p>
      <table className="w-full text-xs font-mono">
        <caption className="sr-only">Floating-point registers f0 to f31</caption>
        <tbody>
          {Array.from(cpu.fregs).map((raw, i) => {
            const bits = pending && pending.reg === i ? pending.old : raw;
            const boxed = bits >> 32n === 0xffffffffn;
            const changed = w && w.reg === i && !pending;
            return (
              <tr key={`${i}-${changed ? s.version : 0}`} className={cn("border-b border-border/50", changed && "flash", pending?.reg === i && "outline outline-1 outline-dashed outline-warn -outline-offset-1")}>
                <th scope="row" className="text-left font-normal py-1 pl-3 w-24 text-f-rs1">
                  {FP_ABI_NAMES[i]} <span className="text-muted">f{i}</span>
                </th>
                <td className={cn("text-right tabular-nums", bits === 0n && "text-muted")}>
                  {boxed ? fpText("S", bits) : fpText("D", bits)}
                  <span className="text-muted ml-1">{boxed ? "s" : "d"}</span>
                </td>
                <td className="text-right pr-3 text-[10px] text-muted">{bits.toString(16).padStart(16, "0")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function bitsOn(v: number, names: Record<number, string>): string {
  return Object.entries(names).filter(([b]) => v & (1 << Number(b))).map(([, n]) => n).join(" ") || "—";
}

function Csrs() {
  const s = useSim();
  void s.version;
  const get = (a: number) => cpu.readCsrSilently(a);
  const ms = get(0x300);
  const cause = (v: number) => (v >>> 31 ? INTERRUPTS[v & 0x7fffffff] ?? `interrupt ${v & 0x7fffffff}` : CAUSES[v] ?? `cause ${v}`);
  const intNames = { 1: "SSI", 3: "MSI", 5: "STI", 7: "MTI", 9: "SEI", 11: "MEI" };
  const rows: [string, number, string][] = [
    ["mstatus", ms, [
      ms & MSTATUS.MIE ? "MIE" : "", ms & MSTATUS.MPIE ? "MPIE" : "", `MPP=${PRIV_NAMES[(ms >> 11) & 3]}`,
      ms & MSTATUS.SIE ? "SIE" : "", ms & MSTATUS.SPIE ? "SPIE" : "", `SPP=${ms & MSTATUS.SPP ? "S" : "U"}`,
      `FS=${["off", "init", "clean", "dirty"][(ms >> 13) & 3]}`, `VS=${["off", "init", "clean", "dirty"][(ms >> 9) & 3]}`,
    ].filter(Boolean).join(" ")],
    ["misa", MISA, `RV32${[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter((_, i) => MISA & (1 << i)).join("")}`],
    ["mtvec", get(0x305), get(0x305) ? `base ${hex32(get(0x305) & ~3)}, ${get(0x305) & 1 ? "vectored" : "direct"}` : "no handler (simulator services)"],
    ["mepc", get(0x341), "PC saved on the last M-mode trap"],
    ["mcause", get(0x342), cause(get(0x342))],
    ["mtval", get(0x343), "faulting address or instruction"],
    ["mscratch", get(0x340), "handler scratch space"],
    ["mie", get(0x304), bitsOn(get(0x304), intNames)],
    ["mip", get(0x344), bitsOn(get(0x344), intNames)],
    ["medeleg", get(0x302), "exceptions delegated to S-mode"],
    ["mideleg", get(0x303), "interrupts delegated to S-mode"],
    ["stvec", get(0x105), "S-mode trap vector"],
    ["sepc", get(0x141), "PC saved on the last S-mode trap"],
    ["scause", get(0x142), cause(get(0x142))],
    ["fcsr", get(0x003), `frm=${["rne", "rtz", "rdn", "rup", "rmm"][(get(0x003) >> 5) & 7] ?? "?"} flags=${["NX", "UF", "OF", "DZ", "NV"].filter((_, i) => get(0x003) & (1 << i)).join(" ") || "none"}`],
    ["mcycle", Number(cpu.cycle & 0xffffffffn), "clock cycles"],
    ["minstret", cpu.instret, "instructions retired"],
    ["mtime", Number(cpu.mtime & 0xffffffffn), `timer; mtimecmp = ${cpu.mtimecmp === 0xffffffffffffffffn ? "never" : cpu.mtimecmp.toString()}`],
  ];
  return (
    <table className="w-full text-xs">
      <caption className="sr-only">Control and status registers</caption>
      <tbody>
        {rows.map(([n, v, note]) => (
          <tr key={n} className="border-b border-border/50 align-top">
            <th scope="row" className="text-left font-mono font-normal py-1 pl-3 text-f-imm w-20">{n}</th>
            <td className="font-mono text-right pr-2 tabular-nums">{hex32(v)}</td>
            <td className="pr-3 text-[11px] text-muted">{note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VecRegs() {
  const s = useSim();
  void s.version;
  const info = vtypeInfo(cpu.vtype);
  const sew = info.vill ? 32 : info.sew;
  const per = VLENB / (sew / 8);
  return (
    <div>
      <p className="px-3 py-1.5 text-[11px] text-muted border-b border-border">
        VLEN = 128 bits. vl = <span className="font-mono text-fg">{cpu.vl}</span>, vtype ={" "}
        <span className="font-mono text-fg">{info.vill ? "vill" : `e${info.sew} ${info.lmulName} ${info.ta ? "ta" : "tu"} ${info.ma ? "ma" : "mu"}`}</span>
        {!info.vill && <>, VLMAX = <span className="font-mono text-fg">{info.vlmax}</span></>}. Elements shown at SEW = {sew}, element 0 on the left.
      </p>
      <table className="w-full text-[10px] font-mono">
        <caption className="sr-only">Vector registers v0 to v31</caption>
        <tbody>
          {Array.from({ length: 32 }, (_, r) => (
            <tr key={r} className="border-b border-border/50">
              <th scope="row" className="text-left font-normal py-0.5 pl-3 w-10 text-f-vm">v{r}</th>
              <td className="pr-3 break-all">
                {Array.from({ length: per }, (_, i) => {
                  const v = readVElem(cpu.vregs, r, i, sew / 8);
                  return (
                    <span key={i} className={cn("mr-1.5", v === 0 && "text-muted")}>
                      {v.toString(16).padStart(sew / 4, "0")}
                    </span>
                  );
                })}
                {r === 0 && (
                  <span className="block text-muted">
                    mask: {Array.from({ length: Math.min(16, Math.max(cpu.vl, 8)) }, (_, i) => readMaskBit(cpu.vregs, 0, i)).join("")}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
