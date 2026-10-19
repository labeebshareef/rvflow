import { decode, layoutFor, bits, type BitField, type Decoded, type FieldKind } from "@/isa/encoding";
import { EXT_LABEL, OPCODE_NAMES } from "@/isa/instructions";
import { csrName } from "@/isa/csr";
import { ABI_NAMES, FP_ABI_NAMES } from "@/isa/registers";
import { expandC } from "@/isa/rvc";
import { bin, hex32 } from "@/lib/format";
import { cn } from "@/lib/cn";
import { FIELD_COLORS } from "@/scene/palette";
import { cpu, currentRecord, entryAt, focusAddr, useSim } from "@/store/sim";

const IMM_RECIPE: Record<string, string> = {
  I: "sext(inst[31:20])",
  S: "sext(inst[31:25] ‖ inst[11:7])",
  B: "sext(inst[31] ‖ inst[7] ‖ inst[30:25] ‖ inst[11:8] ‖ 0)",
  U: "inst[31:12] ‖ 0x000",
  J: "sext(inst[31] ‖ inst[19:12] ‖ inst[20] ‖ inst[30:21] ‖ 0)",
};

const RM = ["rne", "rtz", "rdn", "rup", "rmm", "—", "—", "dyn"];

function fieldMeaning(f: BitField, d: Decoded): string {
  const v = bits(d.word, f.hi, f.lo);
  const width = f.hi - f.lo + 1;
  const fp = d.def.animClass.startsWith("FP") || d.def.animClass === "INT_TO_FP";
  const fpField = (name: string) =>
    fp && (name === "rs3" || name === "rs2" || name === "rs1" && !["FP_LOAD", "FP_STORE", "INT_TO_FP"].includes(d.def.animClass) || name === "rd" && !["FP_CMP", "FP_TO_INT"].includes(d.def.animClass));
  switch (f.name) {
    case "opcode": return `${bin(v, 7)} = ${OPCODE_NAMES[v] ?? "?"}`;
    case "rd": case "rs1": case "rs2": case "rs3":
      if (d.def.fixed[f.name] !== undefined) return `${bin(v, width)} (fixed)`;
      return `${v} = ${fpField(f.name) ? FP_ABI_NAMES[v] : ABI_NAMES[v]}`;
    case "vd": case "vs1": case "vs2": case "vs3": return d.def.fixed[f.name] !== undefined ? `${bin(v, 5)} (sub-opcode)` : `v${v}`;
    case "funct3": return d.def.syntax.includes("rm") ? `${bin(v, 3)} = ${RM[v]}` : bin(v, 3);
    case "csr": return `0x${v.toString(16).padStart(3, "0")} = ${csrName(v)}`;
    case "vm": return v ? "1 (unmasked)" : "0 (masked by v0.t)";
    case "aq": case "rl": return v ? "1" : "0";
    case "simm5": return String((v << 27) >> 27);
    case "imm": return bin(v, width);
    default: return width > 7 ? `0x${v.toString(16)}` : `${bin(v, width)}${width > 3 ? ` (${v})` : ""}`;
  }
}

function Strip({ word, width, fields, focus }: {
  word: number;
  width: 16 | 32;
  fields: { kind: FieldKind | "neutral"; hi: number; lo: number; label: string }[];
  focus: Set<FieldKind>;
}) {
  const at = (bit: number) => fields.find((f) => bit <= f.hi && bit >= f.lo)!;
  const color = (k: FieldKind | "neutral") => (k === "neutral" ? "#7F8EA8" : FIELD_COLORS[k]);
  return (
    <div role="img" aria-label={`Encoding ${fields.map((f) => `${f.label} ${bin(bits(word, f.hi, f.lo), f.hi - f.lo + 1)}`).join(", ")}`}>
      <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))` }}>
        {Array.from({ length: width }, (_, i) => {
          const bit = width - 1 - i;
          const f = at(bit);
          const on = (word >>> bit) & 1;
          const dim = focus.size > 0 && f.kind !== "neutral" && !focus.has(f.kind);
          return (
            <div
              key={bit}
              className={cn(
                "h-7 flex items-center justify-center font-mono text-[11px] font-semibold rounded-[2px] transition-opacity",
                dim && "opacity-25",
                bit === f.hi && bit !== width - 1 && "border-l-2 border-panel",
              )}
              style={{ background: `${color(f.kind)}${on ? "E6" : "40"}`, color: on ? "#0B1220" : "var(--fg)" }}
              title={`bit ${bit} · ${f.label}`}
            >
              {on}
            </div>
          );
        })}
      </div>
      <div className="grid gap-px mt-1 text-[9px] text-muted font-mono" style={{ gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))` }}>
        {fields.map((f) => (
          <div
            key={`${f.hi}-${f.label}`}
            className="text-center truncate border-t-2 pt-0.5"
            style={{ gridColumn: `${width - f.hi} / ${width + 1 - f.lo}`, borderColor: color(f.kind) }}
            title={f.label}
          >
            {f.hi - f.lo >= 2 ? f.label : f.label.replace(/imm/, "")}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-muted font-mono mt-0.5">
        <span>{width - 1}</span>
        <span>0</span>
      </div>
    </div>
  );
}

export function Encoding() {
  const s = useSim();
  const rec = currentRecord(s);
  const addr = focusAddr(s);
  const animating = rec && rec.pc === addr && rec.decoded;
  const lo = cpu.mem.read(addr, 2);
  const compressed = (lo & 3) !== 3;
  const raw = compressed ? lo : cpu.mem.read(addr, 4);
  const ex = compressed ? expandC(lo) : undefined;
  const d = animating ? rec.decoded! : compressed ? (ex ? decode(ex.word) : undefined) : decode(raw);
  const entry = entryAt(addr);
  const seg = animating ? s.segments[s.segIndex] : undefined;
  const focus = new Set<FieldKind>(seg?.fields ?? []);

  if (!s.program) return <p className="p-4 text-sm text-muted">Assemble a program to see its encoding.</p>;
  if (!d) {
    return (
      <div className="p-4 text-sm">
        <p className="font-mono">{compressed ? `0x${lo.toString(16).padStart(4, "0")}` : hex32(raw)} at {hex32(addr)}</p>
        <p className="text-muted mt-1">Not a valid instruction{raw === 0 ? " (all-zero encodings are reserved as illegal)" : ""}.</p>
      </div>
    );
  }

  const layout = layoutFor(d.def);
  const labelled = layout.map((f) => ({ ...f, label: f.name === "funct3" && d.def.syntax.includes("rm") ? "rm" : f.label }));
  const word = d.word;
  const immLayout = ["I", "S", "B", "U", "J"].includes(d.def.layout) && d.def.fixed.imm === undefined;

  return (
    <div className="p-3 space-y-4">
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-base font-semibold">{entry?.asm ?? d.def.mnemonic}</span>
          <span className="text-xs text-muted">{d.def.format}-type · {EXT_LABEL[d.def.ext]}{compressed ? " · C (16-bit)" : ""}</span>
        </div>
        {entry?.pseudo && (
          <p className="font-mono text-xs text-muted mt-0.5">
            ↳ from pseudo-instruction <span className="text-f-funct7">{entry.pseudo.source}</span>
            {entry.pseudo.of > 1 && ` (part ${entry.pseudo.part} of ${entry.pseudo.of})`}
          </p>
        )}
        <p className="text-xs text-muted mt-1">{d.def.semantics}</p>
      </div>

      {compressed && ex && (
        <div className="space-y-2">
          <p className="text-xs">
            <span className="font-mono font-semibold">{ex.mnemonic}</span>
            <span className="text-muted"> — bits [1:0] = {bin(lo & 3, 2)} ≠ 11, so this is a 16-bit compressed instruction</span>
          </p>
          <Strip
            word={lo}
            width={16}
            focus={new Set()}
            fields={[
              { kind: "funct3", hi: 15, lo: 13, label: "funct3" },
              { kind: "neutral", hi: 12, lo: 2, label: "operands" },
              { kind: "opcode", hi: 1, lo: 0, label: "op" },
            ]}
          />
          <p className="font-mono text-sm font-bold">0x{lo.toString(16).padStart(4, "0").toUpperCase()}</p>
          <p className="text-xs text-muted">expands to the 32-bit instruction:</p>
        </div>
      )}

      <Strip word={word} width={32} fields={labelled} focus={focus} />

      <div className="flex items-center gap-3">
        <span className="font-mono text-lg font-bold tracking-wide">{hex32(word)}</span>
        {!compressed && <span className="text-xs text-muted">bits [1:0] = 11 → a 32-bit instruction</span>}
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted text-left">
            <th className="font-normal py-1">field</th>
            <th className="font-normal">bits</th>
            <th className="font-normal">value</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {labelled.map((f) => (
            <tr key={`${f.hi}-${f.label}`} className={cn("border-t border-border/50", focus.size > 0 && !focus.has(f.kind) && "opacity-40")}>
              <td className="py-1">
                <span className="inline-block w-2 h-2 rounded-sm mr-1.5" style={{ background: FIELD_COLORS[f.kind] }} />
                {f.label}
              </td>
              <td className="text-muted">{f.hi === f.lo ? f.hi : `${f.hi}:${f.lo}`}</td>
              <td>{fieldMeaning(f, d)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {(immLayout || d.def.syntax.includes("shamt")) && (
        <div className={cn("rounded-md border border-border bg-panel-2 p-2.5 text-xs", focus.size > 0 && !focus.has("imm") && !focus.has("shamt") && "opacity-50")}>
          <p className="font-semibold mb-1">Immediate generator</p>
          {d.def.syntax.includes("shamt") ? (
            <p className="font-mono">shamt = inst[24:20] = {d.imm}</p>
          ) : (
            <>
              <p className="font-mono text-muted">imm = {IMM_RECIPE[d.def.layout]}</p>
              <p className="font-mono mt-1">= {bin(d.imm, 32).replace(/(.{4})(?=.)/g, "$1_")}</p>
              <p className="font-mono mt-1">
                = <span className="text-f-imm font-semibold">{d.imm}</span> ({hex32(d.imm)})
              </p>
              {d.def.layout !== "U" && (
                <p className="text-muted mt-1">
                  Sign bit inst[31] = {(word >>> 31) & 1}: the upper bits are filled with {(word >>> 31) & 1 ? "ones" : "zeros"}.
                  {(d.def.layout === "B" || d.def.layout === "J") && " Bit 0 is always 0 and is not stored."}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
