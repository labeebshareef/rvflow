import { decode, layoutFor, bits, type BitField, type FieldKind } from "@/isa/encoding";
import { OPCODE_NAMES } from "@/isa/instructions";
import { ABI_NAMES } from "@/isa/registers";
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

function fieldMeaning(f: BitField, word: number, opcode: number): string {
  const v = bits(word, f.hi, f.lo);
  switch (f.kind) {
    case "opcode": return `${bin(v, 7)} = ${OPCODE_NAMES[v] ?? "?"}`;
    case "rd": case "rs1": case "rs2": return `${v} = ${ABI_NAMES[v]}`;
    case "funct3": return bin(v, 3);
    case "funct7": return opcode === 0b0010011 ? `${bin(v, 7)} (shift type)` : bin(v, 7);
    case "shamt": return `${v}`;
    case "imm": return `${bin(v, f.hi - f.lo + 1)}`;
  }
}

export function Encoding() {
  const s = useSim();
  const rec = currentRecord(s);
  const addr = focusAddr(s);
  const animating = rec && rec.pc === addr && rec.decoded;
  const word = animating ? rec.word : cpu.mem.read(addr, 4);
  const d = decode(word);
  const entry = entryAt(addr);
  const seg = animating ? s.segments[s.segIndex] : undefined;
  const focus = new Set<FieldKind>(seg?.fields ?? []);

  if (!s.program) {
    return <p className="p-4 text-sm text-muted">Assemble a program to see its encoding.</p>;
  }
  if (!d) {
    return (
      <div className="p-4 text-sm">
        <p className="font-mono">{hex32(word)} at {hex32(addr)}</p>
        <p className="text-muted mt-1">Not a valid RV32IM instruction{word === 0 ? " (0x00000000 is reserved as illegal)" : ""}.</p>
      </div>
    );
  }

  const layout = layoutFor(d.def);
  const kindAt = (bit: number) => layout.find((f) => bit <= f.hi && bit >= f.lo)!;

  return (
    <div className="p-3 space-y-4">
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-base font-semibold">{entry?.asm ?? d.def.mnemonic}</span>
          <span className="text-xs text-muted">{d.def.format}-type · {d.def.ext === "M" ? "M extension" : "RV32I"}</span>
        </div>
        {entry?.pseudo && (
          <p className="font-mono text-xs text-muted mt-0.5">
            ↳ from pseudo-instruction <span className="text-f-funct7">{entry.pseudo.source}</span>
            {entry.pseudo.of > 1 && ` (part ${entry.pseudo.part} of ${entry.pseudo.of})`}
          </p>
        )}
        <p className="text-xs text-muted mt-1">{d.def.semantics}</p>
      </div>

      {/* The 32-bit strip, bit 31 on the left. */}
      <div role="img" aria-label={`Encoding ${hex32(word)}: ${layout.map((f) => `${f.label} ${bin(bits(word, f.hi, f.lo), f.hi - f.lo + 1)}`).join(", ")}`}>
        <div className="grid gap-px" style={{ gridTemplateColumns: "repeat(32, minmax(0, 1fr))" }}>
          {Array.from({ length: 32 }, (_, i) => {
            const bit = 31 - i;
            const f = kindAt(bit);
            const on = (word >>> bit) & 1;
            const dim = focus.size > 0 && !focus.has(f.kind);
            return (
              <div
                key={bit}
                className={cn(
                  "h-7 flex items-center justify-center font-mono text-[11px] font-semibold rounded-[2px] transition-opacity",
                  dim && "opacity-25",
                  bit === f.hi && bit !== 31 && "border-l-2 border-panel",
                )}
                style={{ background: `${FIELD_COLORS[f.kind]}${on ? "E6" : "40"}`, color: on ? "#0B1220" : "var(--fg)" }}
                title={`bit ${bit} · ${f.label}`}
              >
                {on}
              </div>
            );
          })}
        </div>
        <div className="grid gap-px mt-1 text-[9px] text-muted font-mono" style={{ gridTemplateColumns: "repeat(32, minmax(0, 1fr))" }}>
          {layout.map((f) => (
            <div
              key={`${f.hi}-${f.label}`}
              className="text-center truncate border-t-2 pt-0.5"
              style={{ gridColumn: `${32 - f.hi} / ${33 - f.lo}`, borderColor: FIELD_COLORS[f.kind] }}
              title={f.label}
            >
              {f.hi - f.lo >= 2 ? f.label : f.label.replace(/imm/, "")}
            </div>
          ))}
        </div>
        <div className="flex justify-between text-[9px] text-muted font-mono mt-0.5">
          <span>31</span>
          <span>0</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="font-mono text-lg font-bold tracking-wide">{hex32(word)}</span>
        <span className="text-xs text-muted">bits [1:0] = 11 → a 32-bit instruction</span>
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
          {layout.map((f) => (
            <tr key={`${f.hi}-${f.label}`} className={cn("border-t border-border/50", focus.size > 0 && !focus.has(f.kind) && "opacity-40")}>
              <td className="py-1">
                <span className="inline-block w-2 h-2 rounded-sm mr-1.5" style={{ background: FIELD_COLORS[f.kind] }} />
                {f.label}
              </td>
              <td className="text-muted">{f.hi === f.lo ? f.hi : `${f.hi}:${f.lo}`}</td>
              <td>{fieldMeaning(f, word, d.opcode)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {d.def.format !== "R" && d.def.fixedImm === undefined && d.def.syntax !== "fence" && (
        <div className={cn("rounded-md border border-border bg-panel-2 p-2.5 text-xs", focus.size > 0 && !focus.has("imm") && !focus.has("shamt") && "opacity-50")}>
          <p className="font-semibold mb-1">Immediate generator</p>
          {d.def.syntax === "rd,rs1,shamt" ? (
            <p className="font-mono">shamt = inst[24:20] = {d.imm}</p>
          ) : (
            <>
              <p className="font-mono text-muted">imm = {IMM_RECIPE[d.def.format]}</p>
              <p className="font-mono mt-1">
                = {bin(d.imm, 32).replace(/(.{4})(?=.)/g, "$1_")}
              </p>
              <p className="font-mono mt-1">
                = <span className="text-f-imm font-semibold">{d.imm}</span> ({hex32(d.imm)})
              </p>
              {d.def.format !== "U" && (
                <p className="text-muted mt-1">
                  Sign bit inst[31] = {(word >>> 31) & 1}: the upper bits are filled with {(word >>> 31) & 1 ? "ones" : "zeros"}.
                  {(d.def.format === "B" || d.def.format === "J") && " Bit 0 is always 0 and is not stored."}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
