import type { AnimClass } from "@/isa/instructions";
import type { FieldKind } from "@/isa/encoding";
import { OPCODE_NAMES } from "@/isa/instructions";
import { ABI_NAMES, regLabel } from "@/isa/registers";
import { bin, friendly, hex32 } from "@/lib/format";
import { ALU_SYMBOL, BRANCH_SYMBOL } from "@/sim/alu";
import type { StepRecord } from "@/sim/trace";
import { find, findAll } from "@/sim/trace";
import type { UnitId, WireId } from "@/scene/layout";

export type SegmentId =
  | "assemble" | "fetch" | "decode" | "regRead" | "immGen" | "execute"
  | "memory" | "writeBack" | "pcUpdate" | "system" | "trap";

export type PacketTone = "pc" | "instr" | "data" | "imm" | "addr" | "ctrl";

export interface Packet {
  wire: WireId;
  /** Rendered in 3D with a Latin-only font: keep it ASCII. */
  label: string;
  tone: PacketTone;
}

export interface Prediction {
  question: string;
  options: string[];
  answer: string;
  explain: string;
}

export interface Segment {
  id: SegmentId;
  title: string;
  narration: string;
  /** Longer "explain this step" text. */
  detail: string;
  units: UnitId[];
  wires: WireId[];
  packets: Packet[];
  /** Base duration in ms at 1× speed. */
  duration: number;
  /** Mux selections to display while this segment is active. */
  muxSel?: Partial<Record<"muxA" | "muxB" | "wbmux" | "pcmux", string>>;
  /** Encoding fields to highlight in the bit strip. */
  fields?: FieldKind[];
  /** Ask before revealing this segment (predict-then-reveal). */
  predict?: Prediction;
  /** Datapath units that are greyed out because they are not used. */
  idle?: UnitId[];
}

/** Choreography templates: which segments an instruction class plays, in order. */
export const CHOREO: Record<AnimClass, SegmentId[]> = {
  R: ["assemble", "fetch", "decode", "regRead", "execute", "memory", "writeBack", "pcUpdate"],
  I_ALU: ["assemble", "fetch", "decode", "regRead", "immGen", "execute", "memory", "writeBack", "pcUpdate"],
  LOAD: ["assemble", "fetch", "decode", "regRead", "immGen", "execute", "memory", "writeBack", "pcUpdate"],
  STORE: ["assemble", "fetch", "decode", "regRead", "immGen", "execute", "memory", "pcUpdate"],
  BRANCH: ["assemble", "fetch", "decode", "regRead", "immGen", "execute", "pcUpdate"],
  JAL: ["assemble", "fetch", "decode", "immGen", "execute", "writeBack", "pcUpdate"],
  JALR: ["assemble", "fetch", "decode", "regRead", "immGen", "execute", "writeBack", "pcUpdate"],
  LUI: ["assemble", "fetch", "decode", "immGen", "execute", "writeBack", "pcUpdate"],
  AUIPC: ["assemble", "fetch", "decode", "immGen", "execute", "writeBack", "pcUpdate"],
  SYSTEM: ["assemble", "fetch", "decode", "system", "pcUpdate"],
  FENCE: ["assemble", "fetch", "decode", "pcUpdate"],
};

/** Units each class actually uses; everything else dims. */
const USED: Record<AnimClass, UnitId[]> = {
  R: ["pc", "pc4", "imem", "control", "regfile", "muxA", "muxB", "alu", "wbmux", "pcmux"],
  I_ALU: ["pc", "pc4", "imem", "control", "regfile", "immgen", "muxA", "muxB", "alu", "wbmux", "pcmux"],
  LOAD: ["pc", "pc4", "imem", "control", "regfile", "immgen", "muxA", "muxB", "alu", "dmem", "wbmux", "pcmux"],
  STORE: ["pc", "pc4", "imem", "control", "regfile", "immgen", "muxA", "muxB", "alu", "dmem", "pcmux"],
  BRANCH: ["pc", "pc4", "imem", "control", "regfile", "immgen", "cmp", "target", "pcmux"],
  JAL: ["pc", "pc4", "imem", "control", "regfile", "immgen", "target", "wbmux", "pcmux"],
  JALR: ["pc", "pc4", "imem", "control", "regfile", "immgen", "muxA", "muxB", "alu", "wbmux", "pcmux"],
  LUI: ["pc", "pc4", "imem", "control", "regfile", "immgen", "muxA", "muxB", "alu", "wbmux", "pcmux"],
  AUIPC: ["pc", "pc4", "imem", "control", "regfile", "immgen", "muxA", "muxB", "alu", "wbmux", "pcmux"],
  SYSTEM: ["pc", "pc4", "imem", "control", "regfile", "pcmux"],
  FENCE: ["pc", "pc4", "imem", "control", "pcmux"],
};

const ALL_UNITS: UnitId[] = [
  "pcmux", "pc", "pc4", "imem", "control", "regfile", "immgen", "muxA", "muxB", "cmp", "alu", "target", "dmem", "wbmux",
];

const r = (n: number) => ABI_NAMES[n];

const FORMAT_FIELDS: Record<string, string> = {
  R: "funct7 | rs2 | rs1 | funct3 | rd | opcode",
  I: "imm[11:0] | rs1 | funct3 | rd | opcode",
  S: "imm[11:5] | rs2 | rs1 | funct3 | imm[4:0] | opcode",
  B: "imm[12|10:5] | rs2 | rs1 | funct3 | imm[4:1|11] | opcode",
  U: "imm[31:12] | rd | opcode",
  J: "imm[20|10:1|11|19:12] | rd | opcode",
};

/**
 * Compile a step record into an ordered list of animation segments.
 * Everything here is derived from the trace's micro-events.
 */
export function compileTimeline(rec: StepRecord, source?: string): Segment[] {
  const d = rec.decoded;
  const ev = rec.events;
  const fetch = find(ev, "FETCH");
  const trap = find(ev, "TRAP");

  if (!d || !rec.ctrl) {
    if (!fetch && !trap) return [];
    const segs: Segment[] = [];
    if (fetch) {
      segs.push({
        id: "fetch", title: "Fetch", duration: 900, units: ["pc", "imem"], wires: ["pc->imem"],
        packets: [{ wire: "pc->imem", label: hex32(fetch.pc), tone: "pc" }],
        narration: `The PC (${hex32(fetch.pc)}) addresses instruction memory, which returns ${hex32(fetch.word)}.`,
        detail: "Every instruction starts the same way: the PC selects a 32-bit word from instruction memory.",
      });
    }
    if (trap) segs.push(trapSegment(trap.name, trap.message, trap.cause));
    return segs;
  }

  const def = d.def;
  const cls = def.animClass;
  const ctrl = rec.ctrl;
  const used = USED[cls];
  const idle = ALL_UNITS.filter((u) => !used.includes(u));
  const reads = findAll(ev, "REG_READ");
  const rs1 = reads.find((e) => e.port === 1);
  const rs2 = reads.find((e) => e.port === 2);
  const immEv = find(ev, "IMM");
  const aluEv = find(ev, "ALU");
  const br = find(ev, "BRANCH");
  const tgt = find(ev, "TARGET");
  const mr = find(ev, "MEM_READ");
  const mw = find(ev, "MEM_WRITE");
  const wb = find(ev, "REG_WRITE");
  const pcEv = find(ev, "PC");
  const sys = find(ev, "SYSCALL");
  const pc = rec.pc;
  const pc4 = (pc + 4) >>> 0;
  const asmText = source ?? def.mnemonic;

  const build: Record<SegmentId, () => Segment | null> = {
    assemble: () => {
      const parts: string[] = [];
      if (def.format === "R") parts.push(`funct7 = ${bin(d.funct7, 7)}`);
      if (def.format !== "R" && def.format !== "U" && def.format !== "J" && def.fixedImm === undefined) parts.push(`imm = ${d.imm}`);
      if (def.format === "U" || def.format === "J") parts.push(`imm = ${friendly(d.imm)}`);
      if (["R", "I", "S", "B"].includes(def.format) && def.syntax !== "none") parts.push(`rs1 = ${r(d.rs1)}`);
      if (["R", "S", "B"].includes(def.format)) parts.push(`rs2 = ${r(d.rs2)}`);
      if (["R", "I", "S", "B"].includes(def.format)) parts.push(`funct3 = ${bin(d.funct3, 3)}`);
      if (["R", "I", "U", "J"].includes(def.format) && def.syntax !== "none") parts.push(`rd = ${r(d.rd)}`);
      parts.push(`opcode = ${bin(d.opcode, 7)}`);
      return {
        id: "assemble", title: "Assemble", duration: 1500, units: [], wires: [], packets: [], idle,
        fields: ["opcode", "rd", "funct3", "rs1", "rs2", "funct7", "imm", "shamt"],
        narration: `${def.format}-type: ${parts.join(", ")} → ${hex32(rec.word)}.`,
        detail:
          `The assembler turns "${asmText}" into one 32-bit word. ${def.format}-type fields, most significant first: ` +
          `${FORMAT_FIELDS[def.format]}. rs1, rs2 and rd always sit in the same bit positions so the register file ` +
          `can start reading before decoding finishes, and the immediate's sign bit is always bit 31.` +
          (def.format === "B" || def.format === "J"
            ? " B- and J-type immediates look scrambled: offsets are always even so bit 0 is implied, and the remaining bits are placed to match the I/S/U layouts as closely as possible, keeping the immediate generator's muxes small."
            : ""),
      };
    },
    fetch: () => ({
      id: "fetch", title: "Fetch", duration: 900, units: ["pc", "imem", "pc4"], wires: ["pc->imem", "pc->pc4"], idle,
      packets: [
        { wire: "pc->imem", label: hex32(pc), tone: "pc" },
        { wire: "pc->pc4", label: hex32(pc), tone: "pc" },
      ],
      narration: `The PC (${hex32(pc)}) addresses instruction memory; in parallel, the +4 adder computes ${hex32(pc4)}.`,
      detail:
        "Instruction memory returns the 32-bit word stored at the PC. Every RV32I instruction is 4 bytes, so the " +
        "next sequential instruction is always PC + 4 — the adder computes it now, just in case nothing else overrides it.",
    }),
    decode: () => {
      const on = (Object.entries(ctrl) as [string, unknown][])
        .filter(([, v]) => v !== null && v !== false && v !== "pc4")
        .map(([k, v]) => (v === true ? `${k} = 1` : `${k} = ${v}`));
      return {
        id: "decode", title: "Decode", duration: 1100, idle,
        units: ["imem", "control", "regfile", ...(def.format !== "R" ? (["immgen"] as UnitId[]) : [])],
        wires: ["imem->control", "imem->regfile", ...(def.format !== "R" && cls !== "SYSTEM" && cls !== "FENCE" ? (["imem->immgen"] as WireId[]) : [])],
        packets: [
          { wire: "imem->control", label: `op ${bin(d.opcode, 7)}`, tone: "instr" },
          { wire: "imem->regfile", label: regFieldLabel(def.format, d.rs1, d.rs2, d.rd), tone: "instr" },
          ...(def.format !== "R" && cls !== "SYSTEM" && cls !== "FENCE"
            ? [{ wire: "imem->immgen" as WireId, label: hex32(rec.word), tone: "instr" as PacketTone }]
            : []),
        ],
        fields: ["opcode", "funct3", "funct7"],
        narration: `Control recognizes ${OPCODE_NAMES[d.opcode] ?? "the opcode"} (${def.mnemonic}): ${on.join(", ") || "no datapath signals"}.`,
        detail:
          `The opcode (bits 6:0) tells the control unit the instruction class; funct3/funct7 pick the exact operation. ` +
          `Control then sets every mux and enable signal for this cycle. ${def.mnemonic}: ${def.semantics}. ${def.summary}`,
      };
    },
    regRead: () => {
      if (!rs1 && !rs2) return null;
      const packets: Packet[] = [];
      const wires: WireId[] = [];
      if (cls === "BRANCH") {
        if (rs1) packets.push({ wire: "regfile->cmp1", label: friendly(rs1.value), tone: "data" });
        if (rs2) packets.push({ wire: "regfile->cmp2", label: friendly(rs2.value), tone: "data" });
      } else {
        if (rs1) packets.push({ wire: "regfile->muxA", label: friendly(rs1.value), tone: "data" });
        if (rs2 && cls === "STORE") packets.push({ wire: "regfile->dmem", label: friendly(rs2.value), tone: "data" });
        else if (rs2) packets.push({ wire: "regfile->muxB", label: friendly(rs2.value), tone: "data" });
      }
      wires.push(...packets.map((p) => p.wire));
      const desc = [rs1, rs2].filter(Boolean).map((e) => `${r(e!.reg)} holds ${friendly(e!.value)}`);
      return {
        id: "regRead", title: "Read registers", duration: 900, units: ["regfile"], wires, packets, idle,
        fields: ["rs1", "rs2"],
        narration: `${desc.join("; ")}.`,
        detail:
          "The register file has two read ports, addressed directly by the rs1 and rs2 fields. Reading happens " +
          "combinationally: values appear on the output wires as soon as the register numbers arrive." +
          (cls === "STORE" ? " For a store, rs2 is the data to be written to memory." : "") +
          ([rs1, rs2].some((e) => e?.reg === 0) ? " x0 always reads as 0." : ""),
      };
    },
    immGen: () => {
      if (!immEv) return null;
      const toTarget = cls === "BRANCH" || cls === "JAL";
      const wire: WireId = toTarget ? "immgen->target" : "immgen->muxB";
      const raw = immEv.value;
      const neg = raw < 0;
      return {
        id: "immGen", title: "Immediate", duration: 1000, units: ["immgen"], wires: [wire], idle,
        packets: [{ wire, label: friendly(raw), tone: "imm" }],
        fields: ["imm", "shamt"],
        narration: immEv.shamt
          ? `Shift amount = ${raw} (bits 24:20).`
          : immEv.format === "U"
            ? `U-type: bits 31:12 become the upper 20 bits, low 12 bits are zero → ${hex32(raw)}.`
            : `Sign-extend the ${immEv.format}-type immediate: ${neg ? "bit 31 is 1, so the top bits fill with 1s" : "bit 31 is 0, so the top bits fill with 0s"} → ${raw} (${hex32(raw)}).`,
        detail:
          `ImmSel = ${ctrl.ImmSel}: the immediate generator gathers the immediate bits from their positions in the ` +
          `${immEv.format}-type layout and copies instruction bit 31 into every higher bit (sign extension). ` +
          (immEv.format === "B" || immEv.format === "J" ? "Bit 0 is not stored — it is always 0 because targets are 2-byte aligned." : ""),
      };
    },
    execute: () => {
      if (cls === "BRANCH" && br && tgt) {
        return {
          id: "execute", title: "Compare & target", duration: 1200, units: ["cmp", "target"], idle,
          wires: ["pc->target"], packets: [{ wire: "pc->target", label: hex32(pc), tone: "pc" }],
          narration: `Comparator: ${friendly(br.a)} ${BRANCH_SYMBOL[br.op]} ${friendly(br.b)} is ${br.taken ? "true — taken" : "false — not taken"}. Target = ${hex32(pc)} + ${tgt.offset} = ${hex32(tgt.target)}.`,
          detail:
            "Two things happen at once: the comparator evaluates the branch condition on rs1 and rs2, and a dedicated " +
            "adder computes the branch target PC + imm. The comparator's verdict picks which one becomes the next PC.",
        };
      }
      if (cls === "JAL" && tgt) {
        return {
          id: "execute", title: "Jump target", duration: 1000, units: ["target"], idle,
          wires: ["pc->target"], packets: [{ wire: "pc->target", label: hex32(pc), tone: "pc" }],
          narration: `Target = PC + offset = ${hex32(pc)} + ${tgt.offset} = ${hex32(tgt.target)}.`,
          detail: "jal reuses the branch target adder: offsets are PC-relative, so the same code works wherever it is loaded.",
        };
      }
      if (!aluEv) return null;
      const aSrc = ctrl.ALUSrcA;
      const packets: Packet[] = [
        { wire: "muxA->alu", label: friendly(aluEv.a), tone: "data" },
        { wire: "muxB->alu", label: friendly(aluEv.b), tone: ctrl.ALUSrcB === "imm" ? "imm" : "data" },
      ];
      if (aSrc === "pc") packets.unshift({ wire: "pc->muxA", label: hex32(pc), tone: "pc" });
      const isAddr = cls === "LOAD" || cls === "STORE";
      const op = aluEv.op;
      return {
        id: "execute", title: isAddr ? "Address" : "Execute", duration: 1100, idle,
        units: ["muxA", "muxB", "alu"], wires: packets.map((p) => p.wire), packets,
        muxSel: { muxA: aSrc ?? undefined, muxB: ctrl.ALUSrcB ?? undefined },
        narration: isAddr
          ? `Address = ${friendly(aluEv.a)} + ${aluEv.b} = ${hex32(aluEv.out)}.`
          : cls === "LUI"
            ? `ALU passes 0 + ${hex32(aluEv.b)} = ${hex32(aluEv.out)}.`
            : cls === "JALR"
              ? `Target = ${friendly(aluEv.a)} + ${aluEv.b} = ${hex32(aluEv.out)}, then bit 0 is cleared.`
              : `${friendly(aluEv.a)} ${ALU_SYMBOL[op]} ${friendly(aluEv.b)} = ${friendly(aluEv.out)}.`,
        detail:
          `ALUSrcA = ${aSrc}, ALUSrcB = ${ctrl.ALUSrcB}: the two muxes choose the ALU's operands. ` +
          (isAddr ? "Loads and stores always add: base register + offset gives the byte address. " : `ALUOp = ${op}. `) +
          `Result: ${hex32(aluEv.out)} (${aluEv.out | 0} signed, ${aluEv.out >>> 0} unsigned).`,
      };
    },
    memory: () => {
      if (mr) {
        const bytes = mr.bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
        return {
          id: "memory", title: "Memory read", duration: 1200, units: ["dmem"], idle,
          wires: ["alu->dmem", "dmem->wbmux"],
          packets: [
            { wire: "alu->dmem", label: hex32(mr.addr), tone: "addr" },
            { wire: "dmem->wbmux", label: friendly(mr.value), tone: "data" },
          ],
          narration: `Read ${mr.size} byte${mr.size > 1 ? "s" : ""} at ${hex32(mr.addr)}: [${bytes}] → ${friendly(mr.value)}${mr.size < 4 ? (mr.unsigned ? " (zero-extended)" : " (sign-extended)") : ""}.`,
          detail:
            "RISC-V is little-endian: the byte at the lowest address is the least significant. " +
            `The bytes [${bytes}] read in address order form ${hex32(mr.raw)}` +
            (mr.size < 4 ? `, then ${mr.unsigned ? "zero" : "sign"}-extension fills the upper bits.` : "."),
        };
      }
      if (mw) {
        const bytes = mw.bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
        return {
          id: "memory", title: "Memory write", duration: 1200, units: ["dmem"], idle,
          wires: ["alu->dmem"], packets: [{ wire: "alu->dmem", label: hex32(mw.addr), tone: "addr" }],
          narration: `Write ${mw.size} byte${mw.size > 1 ? "s" : ""} to ${hex32(mw.addr)}: [${bytes}].`,
          detail:
            `MemWrite = 1. The low ${mw.size * 8} bits of rs2 (${hex32(mw.value)}) are stored least-significant byte first ` +
            `— little-endian. RegWrite = 0: stores change memory, not registers.`,
        };
      }
      return {
        id: "memory", title: "Memory", duration: 600, units: [], wires: [], packets: [], idle: [...idle, "dmem"],
        narration: "No memory access.",
        detail: "MemRead = 0 and MemWrite = 0: data memory sits idle this cycle.",
      };
    },
    writeBack: () => {
      if (!wb) return null;
      const sel = ctrl.WBSel!;
      const from: WireId = sel === "mem" ? "dmem->wbmux" : sel === "pc4" ? "pc4->wbmux" : "alu->wbmux";
      const options = uniqueOptions(wb.reg, reads.map((e) => e.reg));
      return {
        id: "writeBack", title: "Write back", duration: 1000, units: ["wbmux", "regfile"], idle,
        wires: sel === "mem" ? ["wbmux->regfile"] : [from, "wbmux->regfile"],
        packets: [
          ...(sel === "mem" ? [] : [{ wire: from, label: friendly(sel === "pc4" ? pc4 : wb.value), tone: sel === "pc4" ? ("pc" as PacketTone) : ("data" as PacketTone) }]),
          { wire: "wbmux->regfile", label: friendly(wb.value), tone: "data" },
        ],
        muxSel: { wbmux: sel },
        fields: ["rd"],
        narration: wb.ignored
          ? `rd is x0: the write of ${friendly(wb.value)} hits the zero wall and is discarded.`
          : `${r(wb.reg)} ← ${friendly(wb.value)} (was ${friendly(wb.old)}).`,
        detail:
          `WBSel = ${sel} chooses ${sel === "mem" ? "the loaded data" : sel === "pc4" ? "PC + 4 (the return address)" : "the ALU result"}; ` +
          `RegWrite = 1 writes it into ${regLabel(wb.reg)} at the end of the cycle.` +
          (wb.ignored ? " x0 is hardwired to zero, so writes to it are ignored — this is how j (jal x0) discards the link." : ""),
        predict: {
          question: "Which register will change?",
          options,
          answer: wb.ignored ? "none (x0)" : r(wb.reg),
          explain: wb.ignored ? "rd = x0, so the write is discarded." : `rd = ${regLabel(wb.reg)} receives ${friendly(wb.value)}.`,
        },
      };
    },
    system: () => {
      if (trap && def.mnemonic === "ebreak") return null;
      return {
        id: "system", title: "ecall", duration: 1200, units: ["control", "regfile"], wires: [], packets: [], idle,
        narration: sys
          ? `ecall service a7 = ${sys.service} (${sys.name})${sys.output ? `: prints "${sys.output.replace(/\n/g, "\\n")}"` : ""}${sys.exit !== undefined ? ` — exit code ${sys.exit}` : ""}.`
          : "Environment call.",
        detail:
          "ecall transfers control to the execution environment. In hardware this traps to mtvec; this simulator " +
          "implements RARS-style services directly (a7 = service number, a0 = argument). This is the simulator " +
          "environment, not part of the ISA.",
      };
    },
    pcUpdate: () => {
      if (!pcEv) return null;
      const src = pcEv.source;
      const wire: WireId = src === "branch" || src === "jal" ? "target->pcmux" : src === "jalr" ? "alu->pcmux" : "pc4->pcmux";
      const packets: Packet[] = [
        { wire, label: hex32(pcEv.next), tone: "pc" },
        { wire: "pcmux->pc", label: hex32(pcEv.next), tone: "pc" },
      ];
      const wires = packets.map((p) => p.wire);
      if (cls === "BRANCH") wires.push("cmp->pcmux");
      return {
        id: "pcUpdate", title: "Update PC", duration: 900, units: ["pcmux", "pc"], wires, packets, idle,
        muxSel: { pcmux: src === "pc4" ? "PC+4" : src === "jalr" ? "ALU" : "target" },
        narration:
          cls === "BRANCH"
            ? br?.taken
              ? `Branch taken: PC ← ${hex32(pcEv.next)}.`
              : `Not taken: PC ← PC + 4 = ${hex32(pcEv.next)}.`
            : `Next instruction at ${hex32(pcEv.next)}.`,
        detail:
          `PCSel picks the next PC: ${src === "pc4" ? "PC + 4 (sequential)" : src === "jalr" ? "(rs1 + imm) & ~1 from the ALU" : "the PC-relative target"}. ` +
          "The new value is latched on the clock edge, and the next instruction begins.",
        predict:
          cls === "BRANCH" && br
            ? {
                question: "Will the branch be taken?",
                options: ["taken", "not taken"],
                answer: br.taken ? "taken" : "not taken",
                explain: `${friendly(br.a)} ${BRANCH_SYMBOL[br.op]} ${friendly(br.b)} is ${br.taken}.`,
              }
            : undefined,
      };
    },
    trap: () => null,
  };

  const segs: Segment[] = [];
  for (const id of CHOREO[cls]) {
    const s = build[id]();
    if (s) segs.push(s);
  }
  if (trap) {
    // A trap ends the timeline at the point of failure.
    const cut = trap.cause === 4 || trap.cause === 6 ? segs.findIndex((s) => s.id === "memory")
      : trap.cause === 0 ? segs.findIndex((s) => s.id === "writeBack" || s.id === "pcUpdate") : -1;
    const kept = cut >= 0 ? segs.slice(0, cut) : segs.filter((s) => s.id !== "pcUpdate");
    kept.push(trapSegment(trap.name, trap.message, trap.cause));
    return kept;
  }
  return segs;
}

function trapSegment(name: string, message: string, cause: number): Segment {
  return {
    id: "trap", title: "Trap", duration: 1400, units: ["control"], wires: [], packets: [],
    narration: `Trap: ${name}. ${message}`,
    detail:
      `mcause = ${cause} (${name}). In a full system the processor would save the PC in mepc and jump to the handler ` +
      "at mtvec. Traps and CSRs are a later chapter, so this simulator stops here and shows what went wrong.",
  };
}

function regFieldLabel(fmt: string, rs1: number, rs2: number, rd: number): string {
  switch (fmt) {
    case "R": return `${r(rs1)}, ${r(rs2)} -> ${r(rd)}`;
    case "I": return `${r(rs1)} -> ${r(rd)}`;
    case "S": case "B": return `${r(rs1)}, ${r(rs2)}`;
    default: return `-> ${r(rd)}`;
  }
}

function uniqueOptions(rd: number, sources: number[]): string[] {
  const set = new Set<string>();
  set.add(rd === 0 ? "none (x0)" : r(rd));
  for (const s of sources) if (s !== 0) set.add(r(s));
  for (const fill of [10, 5, 6, 1, 2]) {
    if (set.size >= 4) break;
    if (fill !== rd) set.add(r(fill));
  }
  return [...set].sort();
}

export function totalDuration(segs: Segment[]): number {
  return segs.reduce((a, s) => a + s.duration, 0);
}
