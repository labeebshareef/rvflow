import { TONE_COLORS } from "@/scene/palette";

const ITEMS: [keyof typeof TONE_COLORS, string][] = [
  ["pc", "PC / address of instruction"],
  ["instr", "instruction bits"],
  ["data", "register / data value"],
  ["imm", "immediate"],
  ["addr", "memory address"],
];

export function Legend() {
  return (
    <ul className="absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-panel/80 backdrop-blur px-2 py-1 text-[10px] text-muted pointer-events-none" aria-label="Packet colours">
      {ITEMS.map(([k, label]) => (
        <li key={k} className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: TONE_COLORS[k] }} />
          {label}
        </li>
      ))}
    </ul>
  );
}
