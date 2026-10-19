import type { PacketTone } from "@/anim/choreography";
import type { FieldKind } from "@/isa/encoding";

/**
 * Colour-blind-safe palette (Okabe–Ito based), shared by the bit strip,
 * the 3D packets and the panels so each meaning keeps one colour everywhere.
 */
export const FIELD_COLORS: Record<FieldKind, string> = {
  opcode: "#CC79A7",
  rd: "#56B4E9",
  funct3: "#F0E442",
  rs1: "#2BBF8A",
  rs2: "#5B9BE6",
  funct7: "#E69F00",
  imm: "#E8743B",
  shamt: "#E8743B",
  rs3: "#8FA8FF",
  csr: "#E8743B",
  rm: "#F0E442",
  aqrl: "#E69F00",
  vm: "#C2A5F0",
};

export const TONE_COLORS: Record<PacketTone, string> = {
  pc: "#E69F00",
  instr: "#CC79A7",
  data: "#56B4E9",
  imm: "#E8743B",
  addr: "#2BBF8A",
  ctrl: "#F0E442",
};

export const SCENE = {
  dark: {
    board: "#0B1220",
    grid: "#16233A",
    unit: "#1C2A44",
    unitActive: "#2A4A7A",
    unitEdge: "#35507F",
    text: "#E6EDF7",
    textDim: "#7F8EA8",
    wire: "#3A4F75",
    wireActive: "#9CC8FF",
    control: "#5D4B1F",
  },
  light: {
    board: "#EEF2F8",
    grid: "#D8DFEA",
    unit: "#FFFFFF",
    unitActive: "#D6E6FF",
    unitEdge: "#9AAACB",
    text: "#14213A",
    textDim: "#6A7891",
    wire: "#B5C1D6",
    wireActive: "#1E5FD0",
    control: "#C9A227",
  },
};

export type SceneTheme = keyof typeof SCENE;
