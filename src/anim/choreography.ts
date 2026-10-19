import type { AnimClass } from "@/isa/instructions";
import type { FieldKind } from "@/isa/encoding";
import { OPCODE_NAMES } from "@/isa/instructions";
import { csrName, PRIV_NAMES } from "@/isa/csr";
import { ABI_NAMES, FP_ABI_NAMES, regLabel } from "@/isa/registers";
import { bin, friendly, hex32 } from "@/lib/format";
import { ALU_SYMBOL, BRANCH_SYMBOL } from "@/sim/alu";
import { toNumber } from "@/sim/fpu";
import type { MicroEvent, StepRecord } from "@/sim/trace";
import { find, findAll } from "@/sim/trace";
import type { UnitId, WireId } from "@/scene/layout";

export type SegmentId =
  | "assemble" | "fetch" | "expand" | "decode" | "regRead" | "immGen" | "execute" | "csr" | "xret"
  | "fpRead" | "fpu" | "fpWrite" | "vset" | "vmem" | "vread" | "vexec" | "vwrite"
  | "memory" | "writeBack" | "pcUpdate" | "system" | "trap" | "interrupt";

/** Classic five-step breakdown used by the multi-cycle view. */
export type CycleStage = "IF" | "ID" | "EX" | "MEM" | "WB";

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
  /** Clock cycle this step belongs to in the multi-cycle implementation. */
  stage?: CycleStage;
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
  CSR: ["assemble", "fetch", "decode", "regRead", "csr", "writeBack", "pcUpdate"],
  PRIV: ["assemble", "fetch", "decode", "xret", "pcUpdate"],
  AMO: ["assemble", "fetch", "decode", "regRead", "execute", "memory", "writeBack", "pcUpdate"],
  LR: ["assemble", "fetch", "decode", "regRead", "execute", "memory", "writeBack", "pcUpdate"],
  SC: ["assemble", "fetch", "decode", "regRead", "execute", "memory", "writeBack", "pcUpdate"],
  FP_LOAD: ["assemble", "fetch", "decode", "regRead", "immGen", "execute", "memory", "fpWrite", "pcUpdate"],
  FP_STORE: ["assemble", "fetch", "decode", "regRead", "immGen", "fpRead", "execute", "memory", "pcUpdate"],
  FP_OP: ["assemble", "fetch", "decode", "fpRead", "fpu", "fpWrite", "pcUpdate"],
  FP_FMA: ["assemble", "fetch", "decode", "fpRead", "fpu", "fpWrite", "pcUpdate"],
  FP_CMP: ["assemble", "fetch", "decode", "fpRead", "fpu", "writeBack", "pcUpdate"],
  FP_TO_INT: ["assemble", "fetch", "decode", "fpRead", "fpu", "writeBack", "pcUpdate"],
  INT_TO_FP: ["assemble", "fetch", "decode", "regRead", "fpu", "fpWrite", "pcUpdate"],
  VSET: ["assemble", "fetch", "decode", "regRead", "vset", "writeBack", "pcUpdate"],
  V_LOAD: ["assemble", "fetch", "decode", "regRead", "vmem", "pcUpdate"],
  V_STORE: ["assemble", "fetch", "decode", "regRead", "vread", "vmem", "pcUpdate"],
  V_ARITH: ["assemble", "fetch", "decode", "regRead", "vread", "vexec", "vwrite", "writeBack", "pcUpdate"],
};

const BASE: UnitId[] = ["pc", "pc4", "imem", "control", "pcmux"];

/** Units each class actually uses; everything else dims. */
const USED: Record<AnimClass, UnitId[]> = {
  R: [...BASE, "regfile", "muxA", "muxB", "alu", "wbmux"],
  I_ALU: [...BASE, "regfile", "immgen", "muxA", "muxB", "alu", "wbmux"],
  LOAD: [...BASE, "regfile", "immgen", "muxA", "muxB", "alu", "dmem", "wbmux"],
  STORE: [...BASE, "regfile", "immgen", "muxA", "muxB", "alu", "dmem"],
  BRANCH: [...BASE, "regfile", "immgen", "cmp", "target"],
  JAL: [...BASE, "regfile", "immgen", "target", "wbmux"],
  JALR: [...BASE, "regfile", "immgen", "muxA", "muxB", "alu", "wbmux"],
  LUI: [...BASE, "regfile", "immgen", "muxA", "muxB", "alu", "wbmux"],
  AUIPC: [...BASE, "regfile", "immgen", "muxA", "muxB", "alu", "wbmux"],
  SYSTEM: [...BASE, "regfile", "csr"],
  FENCE: [...BASE],
  CSR: [...BASE, "regfile", "csr", "wbmux"],
  PRIV: [...BASE, "csr"],
  AMO: [...BASE, "regfile", "muxA", "alu", "dmem", "wbmux"],
  LR: [...BASE, "regfile", "muxA", "alu", "dmem", "wbmux"],
  SC: [...BASE, "regfile", "muxA", "alu", "dmem", "wbmux"],
  FP_LOAD: [...BASE, "regfile", "immgen", "muxA", "muxB", "alu", "dmem", "fpregs"],
  FP_STORE: [...BASE, "regfile", "immgen", "muxA", "muxB", "alu", "dmem", "fpregs"],
  FP_OP: [...BASE, "fpregs", "fpu"],
  FP_FMA: [...BASE, "fpregs", "fpu"],
  FP_CMP: [...BASE, "fpregs", "fpu", "wbmux", "regfile"],
  FP_TO_INT: [...BASE, "fpregs", "fpu", "wbmux", "regfile"],
  INT_TO_FP: [...BASE, "regfile", "fpu", "fpregs"],
  VSET: [...BASE, "regfile", "vlanes", "wbmux"],
  V_LOAD: [...BASE, "regfile", "dmem", "vregs"],
  V_STORE: [...BASE, "regfile", "dmem", "vregs"],
  V_ARITH: [...BASE, "regfile", "vregs", "vlanes", "wbmux"],
};

const ALL_UNITS: UnitId[] = [
  "pcmux", "pc", "pc4", "imem", "control", "regfile", "immgen", "muxA", "muxB", "cmp", "alu", "target", "dmem", "wbmux",
  "csr", "rvc", "fpregs", "fpu", "vregs", "vlanes",
];

/** Which clock cycle each step falls in, in the multi-cycle implementation. */
export const STAGE_OF: Partial<Record<SegmentId, CycleStage>> = {
  fetch: "IF", expand: "IF", decode: "ID", regRead: "ID", immGen: "ID", fpRead: "ID", vread: "ID",
  execute: "EX", csr: "EX", xret: "EX", fpu: "EX", vset: "EX", vexec: "EX", system: "EX",
  memory: "MEM", vmem: "MEM", writeBack: "WB", fpWrite: "WB", vwrite: "WB",
};

const r = (n: number) => ABI_NAMES[n];
const fr = (n: number) => FP_ABI_NAMES[n];

const FORMAT_FIELDS: Record<string, string> = {
  R: "funct7 | rs2 | rs1 | funct3 | rd | opcode",
  R4: "rs3 | fmt | rs2 | rs1 | rm | rd | opcode",
  I: "imm[11:0] | rs1 | funct3 | rd | opcode",
  S: "imm[11:5] | rs2 | rs1 | funct3 | imm[4:0] | opcode",
  B: "imm[12|10:5] | rs2 | rs1 | funct3 | imm[4:1|11] | opcode",
  U: "imm[31:12] | rd | opcode",
  J: "imm[20|10:1|11|19:12] | rd | opcode",
  V: "funct6 | vm | vs2 | vs1/rs1/imm | funct3 | vd | opcode",
};

const FLAG_NAMES = ["NX inexact", "UF underflow", "OF overflow", "DZ divide-by-zero", "NV invalid"];
const RM_NAMES = ["RNE (nearest, ties to even)", "RTZ (toward zero)", "RDN (down)", "RUP (up)", "RMM (nearest, ties away)"];

/** Short decimal rendering of an FP value for narration and packets (ASCII only). */
export function fpText(fmt: "S" | "D", bits: bigint): string {
  const v = toNumber(fmt, bits);
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(4).replace("+", "");
  return String(Number(v.toPrecision(fmt === "S" ? 7 : 10)));
}

function flagText(flags: number): string {
  const names = FLAG_NAMES.filter((_, i) => flags & (1 << i));
  return names.length ? names.join(", ") : "none";
}

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
        id: "fetch", title: "Fetch", duration: 900, units: ["pc", "imem"], wires: ["pc->imem"], stage: "IF",
        packets: [{ wire: "pc->imem", label: hex32(fetch.pc), tone: "pc" }],
        narration: `The PC (${hex32(fetch.pc)}) addresses instruction memory, which returns ${fetch.size === 2 ? `0x${fetch.word.toString(16).padStart(4, "0")}` : hex32(fetch.word)}.`,
        detail: "Every instruction starts the same way: the PC selects an instruction from instruction memory.",
      });
    }
    if (trap) segs.push(trapSegment(trap));
    return segs;
  }

  const def = d.def;
  const cls = def.animClass;
  const ctrl = rec.ctrl;
  const used = [...USED[cls], ...(d.compressed ? (["rvc"] as UnitId[]) : [])];
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
  const csrR = find(ev, "CSR_READ");
  const csrWs = findAll(ev, "CSR_WRITE");
  const fpReads = findAll(ev, "FREG_READ");
  const fpW = find(ev, "FREG_WRITE");
  const fpuEv = find(ev, "FPU");
  const amo = find(ev, "AMO");
  const vset = find(ev, "VSET");
  const vec = find(ev, "VEC");
  const vmem = find(ev, "VMEM");
  const vw = find(ev, "VREG_WRITE");
  const priv = find(ev, "PRIV");
  const expand = find(ev, "EXPAND");
  const pc = rec.pc;
  const size = d.compressed ? 2 : 4;
  const pcNext = (pc + size) >>> 0;
  const asmText = source ?? def.mnemonic;
  const isFpClass = cls.startsWith("FP") || cls === "INT_TO_FP";

  const build: Record<SegmentId, () => Segment | null> = {
    assemble: () => {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(d.f)) {
        if (["opcode", "imm"].includes(k)) continue;
        if (k === "csr") parts.push(`csr = ${csrName(v)}`);
        else parts.push(`${k} = ${/^(rd|rs1|rs2|rs3)$/.test(k) && !isFpClass ? r(v) : v}`);
      }
      if (d.f.imm !== undefined && def.fixed.imm === undefined) parts.unshift(`imm = ${friendly(d.imm)}`);
      parts.push(`opcode = ${bin(d.opcode, 7)}`);
      const word = hex32(d.word);
      return {
        id: "assemble", title: "Assemble", duration: 1500, units: [], wires: [], packets: [], idle,
        fields: ["opcode", "rd", "funct3", "rs1", "rs2", "rs3", "funct7", "imm", "shamt", "csr", "rm", "aqrl", "vm"],
        narration: d.compressed
          ? `Compressed: ${d.compressed.mnemonic} is 16 bits (0x${d.compressed.half.toString(16).padStart(4, "0")}); it expands to ${def.mnemonic} = ${word}.`
          : `${def.format}-type: ${parts.slice(0, 7).join(", ")} → ${word}.`,
        detail:
          `The assembler turns "${asmText}" into ${d.compressed ? "a 16-bit compressed instruction" : "one 32-bit word"}. ` +
          `${def.format}-type fields, most significant first: ${FORMAT_FIELDS[def.format] ?? ""}. ` +
          "rs1, rs2 and rd always sit in the same bit positions so the register file can start reading before decoding finishes, " +
          "and the immediate's sign bit is always bit 31." +
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
      narration: `The PC (${hex32(pc)}) addresses instruction memory; in parallel, the adder computes PC + ${size} = ${hex32(pcNext)}.`,
      detail:
        "Instruction memory returns the instruction stored at the PC. " +
        (d.compressed
          ? "The low two bits are not 11, so this is a 16-bit compressed instruction: the next one starts only 2 bytes later."
          : "RV32 instructions are 4 bytes, so the next sequential instruction is at PC + 4 — the adder computes it now, in case nothing overrides it."),
    }),
    expand: () => {
      if (!expand) return null;
      return {
        id: "expand", title: "Expand", duration: 1000, units: ["rvc", "imem"], wires: ["imem->control"], idle,
        packets: [{ wire: "imem->control", label: hex32(expand.word), tone: "instr" }],
        narration: `${expand.mnemonic} (0x${expand.half.toString(16).padStart(4, "0")}) expands to ${def.mnemonic} ${hex32(expand.word)}.`,
        detail:
          "Every C-extension instruction is shorthand for one 32-bit instruction. Its 3-bit register fields name x8–x15 only, " +
          "and implied operands (sp, x0, rd = rs1) are filled in by the expander, so the rest of the datapath never sees 16-bit code.",
      };
    },
    decode: () => {
      const on = (Object.entries(ctrl) as [string, unknown][])
        .filter(([, v]) => v !== null && v !== false && v !== "pc4")
        .map(([k, v]) => (v === true ? `${k} = 1` : `${k} = ${v}`));
      const toImm = def.format !== "R" && !["SYSTEM", "FENCE", "PRIV", "CSR"].includes(cls) && def.format !== "V" && def.format !== "R4";
      const wires: WireId[] = ["imem->control"];
      const packets: Packet[] = [{ wire: "imem->control", label: `op ${bin(d.opcode, 7)}`, tone: "instr" }];
      if (isFpClass && cls !== "FP_LOAD" && cls !== "FP_STORE") {
        wires.push("imem->fpregs");
        packets.push({ wire: "imem->fpregs", label: regFieldLabel(def.format, d.rs1, d.rs2, d.rd, true), tone: "instr" });
      } else {
        wires.push("imem->regfile");
        packets.push({ wire: "imem->regfile", label: regFieldLabel(def.format, d.rs1, d.rs2, d.rd, false), tone: "instr" });
      }
      if (toImm) {
        wires.push("imem->immgen");
        packets.push({ wire: "imem->immgen", label: hex32(d.word), tone: "instr" });
      }
      return {
        id: "decode", title: "Decode", duration: 1100, idle,
        units: ["imem", "control", ...(isFpClass ? (["fpregs"] as UnitId[]) : ["regfile" as UnitId]), ...(toImm ? (["immgen"] as UnitId[]) : [])],
        wires, packets,
        fields: ["opcode", "funct3", "funct7", "rm"],
        narration: `Control recognizes ${OPCODE_NAMES[d.opcode] ?? "the opcode"} (${def.mnemonic}): ${on.slice(0, 6).join(", ") || "no datapath signals"}.`,
        detail:
          "The opcode (bits 6:0) tells the control unit the instruction class; funct3/funct7 pick the exact operation. " +
          `Control then sets every mux and enable signal for this cycle. ${def.mnemonic}: ${def.semantics}. ${def.summary}`,
      };
    },
    regRead: () => {
      if (!rs1 && !rs2) return null;
      const packets: Packet[] = [];
      if (cls === "BRANCH") {
        if (rs1) packets.push({ wire: "regfile->cmp1", label: friendly(rs1.value), tone: "data" });
        if (rs2) packets.push({ wire: "regfile->cmp2", label: friendly(rs2.value), tone: "data" });
      } else if (cls === "CSR") {
        if (rs1) packets.push({ wire: "regfile->csr", label: friendly(rs1.value), tone: "data" });
      } else if (cls === "INT_TO_FP") {
        if (rs1) packets.push({ wire: "regfile->fpu", label: friendly(rs1.value), tone: "data" });
      } else if (cls === "VSET" || cls.startsWith("V_")) {
        for (const e of [rs1, rs2]) if (e) packets.push({ wire: "regfile->vlanes", label: friendly(e.value), tone: "data" });
      } else {
        if (rs1) packets.push({ wire: "regfile->muxA", label: friendly(rs1.value), tone: "data" });
        if (rs2 && (cls === "STORE" || cls === "AMO" || cls === "SC")) packets.push({ wire: "regfile->dmem", label: friendly(rs2.value), tone: "data" });
        else if (rs2) packets.push({ wire: "regfile->muxB", label: friendly(rs2.value), tone: "data" });
      }
      const desc = [rs1, rs2].filter(Boolean).map((e) => `${r(e!.reg)} holds ${friendly(e!.value)}`);
      return {
        id: "regRead", title: "Read registers", duration: 900, units: ["regfile"], wires: packets.map((p) => p.wire), packets, idle,
        fields: ["rs1", "rs2"],
        narration: `${desc.join("; ")}.`,
        detail:
          "The integer register file has two read ports, addressed directly by the rs1 and rs2 fields. Reading happens " +
          "combinationally: values appear on the output wires as soon as the register numbers arrive." +
          (cls === "STORE" ? " For a store, rs2 is the data to be written to memory." : "") +
          (cls === "CSR" ? " For a CSR instruction, rs1 is the value to write, set or clear." : "") +
          ([rs1, rs2].some((e) => e?.reg === 0) ? " x0 always reads as 0." : ""),
      };
    },
    immGen: () => {
      if (!immEv) return null;
      const toTarget = cls === "BRANCH" || cls === "JAL";
      const wire: WireId = toTarget ? "immgen->target" : "immgen->muxB";
      const raw = immEv.value;
      return {
        id: "immGen", title: "Immediate", duration: 1000, units: ["immgen"], wires: [wire], idle,
        packets: [{ wire, label: friendly(raw), tone: "imm" }],
        fields: ["imm", "shamt"],
        narration: immEv.shamt
          ? `Shift amount = ${raw} (bits 24:20).`
          : immEv.format === "U"
            ? `U-type: bits 31:12 become the upper 20 bits, low 12 bits are zero → ${hex32(raw)}.`
            : `Sign-extend the ${immEv.format}-type immediate: ${raw < 0 ? "bit 31 is 1, so the top bits fill with 1s" : "bit 31 is 0, so the top bits fill with 0s"} → ${raw} (${hex32(raw)}).`,
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
      if ((cls === "AMO" || cls === "LR" || cls === "SC") && amo) {
        return {
          id: "execute", title: "Address", duration: 900, units: ["muxA", "alu"], idle,
          wires: ["muxA->alu"], packets: [{ wire: "muxA->alu", label: hex32(amo.addr), tone: "addr" }],
          narration: `Atomics take the address straight from rs1: ${hex32(amo.addr)} (no offset).`,
          detail: "AMOs and LR/SC have no immediate offset, so the address must be computed beforehand. It must be 4-byte aligned.",
        };
      }
      if (!aluEv) return null;
      const aSrc = ctrl.ALUSrcA;
      const packets: Packet[] = [
        { wire: "muxA->alu", label: friendly(aluEv.a), tone: "data" },
        { wire: "muxB->alu", label: friendly(aluEv.b), tone: ctrl.ALUSrcB === "imm" ? "imm" : "data" },
      ];
      if (aSrc === "pc") packets.unshift({ wire: "pc->muxA", label: hex32(pc), tone: "pc" });
      const isAddr = cls === "LOAD" || cls === "STORE" || cls === "FP_LOAD" || cls === "FP_STORE";
      const op = aluEv.op;
      const unary = def.layout === "IFIX";
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
              : unary
                ? `${ALU_SYMBOL[op]}(${friendly(aluEv.a)}) = ${friendly(aluEv.out)}.`
                : `${friendly(aluEv.a)} ${ALU_SYMBOL[op]} ${friendly(aluEv.b)} = ${friendly(aluEv.out)}.`,
        detail:
          `ALUSrcA = ${aSrc}, ALUSrcB = ${ctrl.ALUSrcB}: the two muxes choose the ALU's operands. ` +
          (isAddr ? "Loads and stores always add: base register + offset gives the byte address. " : `ALUOp = ${op}. `) +
          (def.ext.startsWith("Zb") ? `${def.mnemonic} is part of the B (bit-manipulation) extension: ${def.summary} ` : "") +
          `Result: ${hex32(aluEv.out)} (${aluEv.out | 0} signed, ${aluEv.out >>> 0} unsigned).`,
      };
    },
    csr: () => {
      if (!csrR) return null;
      const w = csrWs.find((x) => x.csr === csrR.csr);
      return {
        id: "csr", title: "CSR access", duration: 1200, units: ["csr"], idle,
        wires: ["csr->wbmux"], packets: [{ wire: "csr->wbmux", label: friendly(csrR.value), tone: "data" }],
        narration: `${csrR.name} reads ${hex32(csrR.value)}${w ? ` and becomes ${hex32(w.value)}` : " (not written)"}.`,
        detail:
          "CSR instructions swap, set or clear bits of a control and status register in one indivisible step; the old value goes to rd. " +
          "Access is checked against the current privilege mode (bits 9:8 of the CSR number) and read-only CSRs (bits 11:10 = 11) cannot be written. " +
          (w && csrWs.length > 1 ? `Side effect: ${csrWs.filter((x) => x !== w).map((x) => x.name).join(", ")} also changed.` : ""),
      };
    },
    xret: () => {
      if (!priv) return null;
      if (priv.op === "wfi" || priv.op === "sfence.vma") {
        return {
          id: "xret", title: priv.op, duration: 900, units: ["control"], wires: [], packets: [], idle,
          narration: priv.op === "wfi" ? "wfi: wait for an interrupt (time skips ahead to the next timer interrupt)." : "sfence.vma: nothing cached to flush (bare mode).",
          detail: def.summary,
        };
      }
      const from = PRIV_NAMES[priv.from];
      const to = PRIV_NAMES[priv.to];
      return {
        id: "xret", title: priv.op, duration: 1300, units: ["csr", "pcmux"], idle,
        wires: ["csr->pcmux"], packets: [{ wire: "csr->pcmux", label: hex32(priv.target), tone: "pc" }],
        muxSel: { pcmux: priv.op === "mret" ? "mepc" : "sepc" },
        narration: `${priv.op}: return to ${to}-mode at ${priv.op === "mret" ? "mepc" : "sepc"} = ${hex32(priv.target)} (was ${from}-mode).`,
        detail:
          `${priv.op} undoes a trap: the privilege mode comes from ${priv.op === "mret" ? "mstatus.MPP" : "mstatus.SPP"}, ` +
          `interrupts are re-enabled from ${priv.op === "mret" ? "MPIE" : "SPIE"}, and execution resumes at ${priv.op === "mret" ? "mepc" : "sepc"}. ` +
          "A handler for ecall must first add 4 to mepc, otherwise the ecall runs again forever.",
      };
    },
    fpRead: () => {
      if (!fpReads.length) return null;
      const wire: WireId = cls === "FP_STORE" ? "fpregs->dmem" : "fpregs->fpu";
      const desc = fpReads.map((e) => `${fr(e.reg)} = ${fpText(e.fmt, e.bits)}`);
      return {
        id: "fpRead", title: "Read FP registers", duration: 900, units: ["fpregs"], wires: [wire], idle,
        packets: fpReads.slice(0, 2).map((e) => ({ wire, label: fpText(e.fmt, e.bits), tone: "data" as PacketTone })),
        narration: `${desc.join("; ")}.`,
        detail:
          "The FP register file f0–f31 is separate from the integer registers and has three read ports (for fused multiply-add). " +
          "Registers are 64 bits wide (D extension); a single-precision value is NaN-boxed: its upper 32 bits are all ones.",
      };
    },
    fpu: () => {
      if (!fpuEv) return null;
      const ins = fpuEv.inputs.map((b) => fpText(fpuEv.fmt, b));
      const out = fpuEv.toInt ? friendly(Number(fpuEv.out)) : fpText(fpuEv.fmt, fpuEv.out as bigint);
      const rmUsed = def.syntax.includes("rm");
      return {
        id: "fpu", title: "FPU", duration: 1300, units: ["fpu"], idle,
        wires: cls === "INT_TO_FP" ? [] : ["fpregs->fpu"], packets: [],
        narration: `${fpuEv.op}(${ins.join(", ")}) = ${out}${rmUsed ? `, rounding ${RM_NAMES[fpuEv.rm]?.split(" ")[0]}` : ""}; flags: ${flagText(fpuEv.flags)}.`,
        detail:
          `${def.mnemonic}: ${def.semantics}. ${def.summary} ` +
          (rmUsed ? `Rounding mode: ${RM_NAMES[fpuEv.rm]}. ` : "") +
          "Exceptions never trap in RISC-V; they accumulate as sticky bits in fcsr.fflags (NV invalid, DZ divide by zero, OF overflow, UF underflow, NX inexact).",
      };
    },
    fpWrite: () => {
      if (!fpW) return null;
      const from: WireId = cls === "FP_LOAD" ? "dmem->fpregs" : "fpu->fpregs";
      return {
        id: "fpWrite", title: "Write FP register", duration: 900, units: ["fpregs"], wires: [from], idle,
        packets: [{ wire: from, label: fpText(fpW.fmt, fpW.bits), tone: "data" }],
        fields: ["rd"],
        narration: `${fr(fpW.reg)} ← ${fpText(fpW.fmt, fpW.bits)} (0x${fpW.bits.toString(16).padStart(16, "0")}).`,
        detail: fpW.fmt === "S" ? "Single-precision results are NaN-boxed: the upper 32 bits of the 64-bit register are set to all ones." : "A double fills all 64 bits of the register.",
      };
    },
    vset: () => {
      if (!vset) return null;
      return {
        id: "vset", title: "Configure vectors", duration: 1300, units: ["vlanes"], wires: [], packets: [], idle,
        narration: vset.vill
          ? "Unsupported vtype: vill is set and vl = 0."
          : `SEW = ${vset.sew} bits, LMUL = ${vset.lmul}: VLMAX = ${vset.vlmax}; requested ${vset.avl === 0xffffffff ? "VLMAX" : vset.avl} → vl = ${vset.vl}.`,
        detail:
          "vsetvli is how vector code becomes length-agnostic: software asks for avl elements and the hardware answers with vl, " +
          "how many it will process per instruction (at most VLMAX = LMUL × VLEN / SEW; VLEN = 128 here). A strip-mined loop " +
          "repeats until all elements are done, on any vector length.",
      };
    },
    vread: () => {
      if (!vec && !vmem) return null;
      if (vec && !/\bvs[12]\b/.test(def.syntax)) return null; // e.g. vmv.v.i, vid.v: no vector source
      return {
        id: "vread", title: "Read vector registers", duration: 800, units: ["vregs"], wires: [vmem ? "vregs->dmem" : "vregs->vlanes"], idle,
        packets: [{ wire: vmem ? "vregs->dmem" : "vregs->vlanes", label: `${vec ? vec.vl : vmem!.addrs.length} elems`, tone: "data" }],
        narration: `Vector operands stream out of the register file, ${vec?.sew ?? vmem?.sew} bits per element.`,
        detail: "Each vector register holds VLEN = 128 bits. With LMUL > 1 an instruction operates on a group of consecutive registers.",
      };
    },
    vexec: () => {
      if (!vec) return null;
      const lanes = vec.lanes.filter((l) => l.active).slice(0, 4);
      const show = lanes.map((l) => `[${l.i}] ${friendly(l.a)}→${friendly(l.out)}`).join(" ");
      return {
        id: "vexec", title: "Vector lanes", duration: 1300, units: ["vlanes"], wires: [], packets: [], idle,
        narration: vec.scalar !== undefined && !vec.lanes.length
          ? `${def.mnemonic}: result ${vec.scalar}.`
          : `${def.mnemonic} on ${vec.vl} element${vec.vl === 1 ? "" : "s"}${lanes.length ? `: ${show}${vec.lanes.length > 4 ? " …" : ""}` : ""}.`,
        detail:
          `${def.semantics}. ${def.summary} Lanes work in parallel. Elements past vl (the tail) and masked-off elements ` +
          "(v0.t with a 0 mask bit) are left undisturbed in this simulator.",
      };
    },
    vwrite: () => {
      if (!vw) return null;
      return {
        id: "vwrite", title: "Write vector register", duration: 800, units: ["vregs"], wires: ["vlanes->vregs"], idle,
        packets: [{ wire: "vlanes->vregs", label: `v${vw.reg}`, tone: "data" }],
        narration: `v${vw.reg}${vw.regs > 1 ? `–v${vw.reg + vw.regs - 1}` : ""} updated${vec?.maskOut ? " (one mask bit per element)" : ""}.`,
        detail: "Mask-producing instructions write one bit per element into a single register; v0 is the register used for masking.",
      };
    },
    vmem: () => {
      if (!vmem) return null;
      const wire: WireId = vmem.write ? "vregs->dmem" : "dmem->vregs";
      return {
        id: "vmem", title: vmem.write ? "Vector store" : "Vector load", duration: 1300, units: ["dmem", "vregs"], wires: [wire], idle,
        packets: [{ wire, label: `${vmem.addrs.length} x ${vmem.sew}b`, tone: "addr" }],
        narration: `${vmem.write ? "Store" : "Load"} ${vmem.addrs.length} element${vmem.addrs.length === 1 ? "" : "s"} of ${vmem.sew} bits from ${hex32(vmem.base)}, stride ${vmem.stride} bytes.`,
        detail: "One instruction moves a whole vector. Unit-stride accesses consecutive elements; strided ones skip rs2 bytes between elements (e.g. walking a matrix column).",
      };
    },
    memory: () => {
      if (amo && (cls === "AMO" || cls === "LR" || cls === "SC")) {
        const narr = cls === "LR"
          ? `lr.w reads ${friendly(amo.memOld)} from ${hex32(amo.addr)} and reserves the address.`
          : cls === "SC"
            ? amo.success ? `sc.w succeeds: the reservation held, M[${hex32(amo.addr)}] ← ${friendly(amo.operand)}.` : "sc.w fails: the reservation was lost, memory is unchanged."
            : `Atomic ${amo.op}: M[${hex32(amo.addr)}] was ${friendly(amo.memOld)}, becomes ${friendly(amo.memNew)}.`;
        return {
          id: "memory", title: cls === "AMO" ? "Atomic update" : cls, duration: 1400, units: ["dmem"], idle,
          wires: ["alu->dmem", "dmem->wbmux"], packets: [
            { wire: "alu->dmem", label: hex32(amo.addr), tone: "addr" },
            { wire: "dmem->wbmux", label: friendly(cls === "SC" ? (amo.success ? 0 : 1) : amo.memOld), tone: "data" },
          ],
          narration: narr,
          detail:
            "The A extension's read-modify-write happens indivisibly in the memory system, so two harts can never interleave inside it. " +
            "LR/SC build arbitrary atomic sequences: if anything stores to the reserved address in between, sc.w fails (rd = 1) and the loop retries. " +
            (def.mnemonic.includes(".aq") || d.f.aq || d.f.rl ? "aq/rl bits order the AMO with surrounding accesses (acquire/release)." : ""),
        };
      }
      if (mr) {
        const bytes = mr.bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
        const toFp = cls === "FP_LOAD";
        return {
          id: "memory", title: "Memory read", duration: 1200, units: ["dmem"], idle,
          wires: ["alu->dmem", ...(toFp ? [] : (["dmem->wbmux"] as WireId[]))],
          packets: [
            { wire: "alu->dmem", label: hex32(mr.addr), tone: "addr" },
            ...(toFp ? [] : [{ wire: "dmem->wbmux" as WireId, label: friendly(mr.value), tone: "data" as PacketTone }]),
          ],
          narration: `Read ${mr.size} byte${mr.size > 1 ? "s" : ""} at ${hex32(mr.addr)}: [${bytes}]${toFp ? "" : ` → ${friendly(mr.value)}`}${mr.size < 4 ? (mr.unsigned ? " (zero-extended)" : " (sign-extended)") : ""}.`,
          detail:
            "RISC-V is little-endian: the byte at the lowest address is the least significant. " +
            `The bytes [${bytes}] read in address order form the value` +
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
            `MemWrite = 1. The low ${mw.size * 8} bits are stored least-significant byte first ` +
            "— little-endian. RegWrite = 0: stores change memory, not registers.",
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
      const sel = ctrl.WBSel ?? "alu";
      const from: WireId = sel === "mem" ? "dmem->wbmux" : sel === "pc4" ? "pc4->wbmux" : sel === "csr" ? "csr->wbmux"
        : sel === "fpu" ? "fpu->wbmux" : cls.startsWith("V") ? "vlanes->wbmux" : "alu->wbmux";
      const options = uniqueOptions(wb.reg, reads.map((e) => e.reg));
      const already = sel === "mem" || sel === "csr";
      return {
        id: "writeBack", title: "Write back", duration: 1000, units: ["wbmux", "regfile"], idle,
        wires: already ? ["wbmux->regfile"] : [from, "wbmux->regfile"],
        packets: [
          ...(already ? [] : [{ wire: from, label: friendly(sel === "pc4" ? pcNext : wb.value), tone: sel === "pc4" ? ("pc" as PacketTone) : ("data" as PacketTone) }]),
          { wire: "wbmux->regfile", label: friendly(wb.value), tone: "data" },
        ],
        muxSel: { wbmux: sel },
        fields: ["rd"],
        narration: wb.ignored
          ? `rd is x0: the write of ${friendly(wb.value)} hits the zero wall and is discarded.`
          : `${r(wb.reg)} ← ${friendly(wb.value)} (was ${friendly(wb.old)}).`,
        detail:
          `WBSel = ${sel} chooses ${sel === "mem" ? "the loaded data" : sel === "pc4" ? `PC + ${size} (the return address)` : sel === "csr" ? "the old CSR value" : sel === "fpu" ? "the FPU's integer result" : "the result"}; ` +
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
      if (trap) return null;
      return {
        id: "system", title: "ecall", duration: 1200, units: ["control", "regfile"], wires: [], packets: [], idle,
        narration: sys
          ? `ecall service a7 = ${sys.service} (${sys.name})${sys.output ? `: prints "${sys.output.replace(/\n/g, "\\n")}"` : ""}${sys.exit !== undefined ? ` — exit code ${sys.exit}` : ""}.`
          : "Environment call.",
        detail:
          "ecall asks the execution environment for a service. With no trap handler installed (mtvec = 0) this simulator " +
          "answers RARS-style services directly (a7 = service number, a0 = argument) — the simulator environment, not the ISA. " +
          "Install a handler with csrw mtvec to see the real trap instead.",
      };
    },
    pcUpdate: () => {
      if (!pcEv || pcEv.source === "trap") return null;
      const src = pcEv.source;
      const wire: WireId = src === "branch" || src === "jal" ? "target->pcmux" : src === "jalr" ? "alu->pcmux" : src === "xret" ? "csr->pcmux" : "pc4->pcmux";
      const packets: Packet[] = [
        { wire, label: hex32(pcEv.next), tone: "pc" },
        { wire: "pcmux->pc", label: hex32(pcEv.next), tone: "pc" },
      ];
      const wires = packets.map((p) => p.wire);
      if (cls === "BRANCH") wires.push("cmp->pcmux");
      return {
        id: "pcUpdate", title: "Update PC", duration: 900, units: ["pcmux", "pc"], wires, packets, idle,
        muxSel: { pcmux: src === "pc4" ? `PC+${size}` : src === "jalr" ? "ALU" : src === "xret" ? "epc" : "target" },
        narration:
          cls === "BRANCH"
            ? br?.taken
              ? `Branch taken: PC ← ${hex32(pcEv.next)}.`
              : `Not taken: PC ← PC + ${size} = ${hex32(pcEv.next)}.`
            : `Next instruction at ${hex32(pcEv.next)}.`,
        detail:
          `PCSel picks the next PC: ${src === "pc4" ? `PC + ${size} (sequential)` : src === "jalr" ? "(rs1 + imm) & ~1 from the ALU" : src === "xret" ? "the saved exception PC" : "the PC-relative target"}. ` +
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
    interrupt: () => null,
  };

  const order = [...CHOREO[cls]];
  if (d.compressed) order.splice(order.indexOf("fetch") + 1, 0, "expand");
  let segs: Segment[] = [];
  for (const id of order) {
    const s = build[id]();
    // An idle memory step costs no clock cycle in the multi-cycle machine.
    const idleMem = id === "memory" && !mr && !mw && !amo;
    if (s) segs.push({ ...s, stage: idleMem ? undefined : s.stage ?? STAGE_OF[id] });
  }
  if (trap) {
    // A trap replaces the rest of the instruction: everything it changed was rolled back.
    const keep = new Set<SegmentId>(["assemble", "fetch", "expand", "decode"]);
    segs = segs.filter((s) => keep.has(s.id) || (s.id === "regRead" && !trap.handler));
    segs.push(trapSegment(trap));
  }
  return segs;
}

function trapSegment(t: Extract<MicroEvent, { kind: "TRAP" }>): Segment {
  const code = `${t.interrupt ? "interrupt" : "exception"} ${t.cause}`;
  if (t.handler === undefined) {
    return {
      id: "trap", title: t.interrupt ? "Interrupt" : "Trap", duration: 1400, units: ["control", "csr"], wires: [], packets: [], stage: "EX",
      narration: `Trap: ${t.name}. ${t.message}`,
      detail:
        `mcause would be ${code} (${t.name}). The processor saves the PC in mepc, the cause in mcause and jumps to the handler at mtvec. ` +
        "No handler is installed (mtvec = 0), so the simulator stops here and shows what went wrong. Write one with csrw mtvec, handler.",
    };
  }
  const reg = t.to === 1 ? "s" : "m";
  return {
    id: t.interrupt ? "interrupt" : "trap", title: t.interrupt ? "Interrupt" : "Trap", duration: 1600, units: ["csr", "pcmux", "pc"], stage: "EX",
    wires: ["csr->pcmux", "pcmux->pc"],
    packets: [
      { wire: "csr->pcmux", label: hex32(t.handler), tone: "pc" },
      { wire: "pcmux->pc", label: hex32(t.handler), tone: "pc" },
    ],
    muxSel: { pcmux: "trap" },
    narration: `${t.interrupt ? "Interrupt" : "Trap"}: ${t.name}. ${reg}epc ← PC, ${reg}cause = ${code}, ${PRIV_NAMES[t.from ?? 3]}-mode → ${PRIV_NAMES[t.to ?? 3]}-mode, jump to ${reg}tvec = ${hex32(t.handler)}.`,
    detail:
      `On a trap the hardware does four things atomically: save the PC in ${reg}epc, record the cause in ${reg}cause (and extra information in ${reg}tval = ${hex32(t.tval)}), ` +
      `save the interrupt-enable bit and the previous mode in mstatus (${reg === "m" ? "MPIE, MPP" : "SPIE, SPP"}) and disable interrupts, then jump to ${reg}tvec. ` +
      (t.to === 1 ? "medeleg/mideleg delegated this trap to S-mode. " : "") +
      `${t.interrupt ? "The interrupted instruction has not run; mret resumes it." : "The faulting instruction had no effect."}`,
  };
}

function regFieldLabel(fmt: string, rs1: number, rs2: number, rd: number, fp: boolean): string {
  const n = fp ? fr : r;
  switch (fmt) {
    case "R": case "R4": return `${n(rs1)}, ${n(rs2)} -> ${n(rd)}`;
    case "I": return `${r(rs1)} -> ${n(rd)}`;
    case "S": case "B": return `${r(rs1)}, ${n(rs2)}`;
    case "V": return `v${rs2} -> v${rd}`;
    default: return `-> ${n(rd)}`;
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
