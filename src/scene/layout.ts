/**
 * Board layout for the single-cycle datapath, in board units (x right, y up).
 * Wires are Manhattan polylines addressed by ID; the choreography refers to
 * these IDs and the scene renders whatever is listed here.
 */

export type UnitId =
  | "pcmux" | "pc" | "pc4" | "imem" | "control" | "regfile" | "immgen"
  | "muxA" | "muxB" | "cmp" | "alu" | "target" | "dmem" | "wbmux"
  | "csr" | "rvc" | "fpregs" | "fpu" | "vregs" | "vlanes";

/** Optional parts of the board, shown only when the program needs them. */
export type Feature = "rvc" | "fp" | "vec";

export interface UnitDef {
  id: UnitId;
  label: string;
  sub?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "block" | "mux" | "adder" | "alu" | "memory" | "control";
  feature?: Feature;
}

export const UNITS: UnitDef[] = [
  { id: "pcmux", label: "PC", sub: "mux", x: -13, y: 0, w: 0.8, h: 2.4, kind: "mux" },
  { id: "pc", label: "PC", x: -11, y: 0, w: 1.6, h: 1.6, kind: "block" },
  { id: "pc4", label: "+4", x: -11, y: 4, w: 1.6, h: 1.2, kind: "adder" },
  { id: "imem", label: "Instruction", sub: "Memory", x: -7.5, y: 0, w: 2.4, h: 3.2, kind: "memory" },
  { id: "control", label: "Control", x: -7.5, y: 5, w: 3, h: 1.4, kind: "control" },
  { id: "regfile", label: "Registers", sub: "x0-x31", x: -2.5, y: 0, w: 2.8, h: 3.6, kind: "block" },
  { id: "immgen", label: "Imm Gen", x: -2.5, y: -4.5, w: 2.6, h: 1.2, kind: "block" },
  { id: "muxA", label: "A", x: 1.5, y: 1.2, w: 0.8, h: 1.6, kind: "mux" },
  { id: "muxB", label: "B", x: 1.5, y: -1.2, w: 0.8, h: 1.6, kind: "mux" },
  { id: "cmp", label: "Compare", x: 1.5, y: 4, w: 1.8, h: 1.2, kind: "block" },
  { id: "alu", label: "ALU", x: 4.5, y: 0, w: 1.8, h: 3, kind: "alu" },
  { id: "target", label: "PC + imm", x: 4.5, y: -5, w: 1.8, h: 1.2, kind: "adder" },
  { id: "dmem", label: "Data", sub: "Memory", x: 8.5, y: 0, w: 2.8, h: 3.2, kind: "memory" },
  { id: "wbmux", label: "WB", sub: "mux", x: 12, y: 0, w: 0.8, h: 2.4, kind: "mux" },
  { id: "csr", label: "CSR File", sub: "mstatus mepc", x: -2.5, y: 4.8, w: 2.2, h: 1.1, kind: "block" },
  { id: "rvc", label: "Expand", x: -7.5, y: 3.0, w: 1.6, h: 0.7, kind: "block", feature: "rvc" },
  { id: "fpregs", label: "FP Regs", sub: "f0-f31", x: -6.5, y: -11, w: 2.8, h: 2, kind: "block", feature: "fp" },
  { id: "fpu", label: "FPU", sub: "IEEE 754", x: -1.5, y: -11, w: 2.4, h: 2, kind: "alu", feature: "fp" },
  { id: "vregs", label: "Vector Regs", sub: "v0-v31", x: 4.5, y: -11, w: 2.8, h: 2, kind: "block", feature: "vec" },
  { id: "vlanes", label: "Vector ALU", sub: "lanes", x: 9.5, y: -11, w: 2.8, h: 2, kind: "alu", feature: "vec" },
];

export const UNIT_BY_ID = new Map(UNITS.map((u) => [u.id, u]));

export type WireId =
  | "pc->imem" | "pc->pc4" | "pc4->pcmux" | "pc4->wbmux" | "pc->target" | "pc->muxA"
  | "imem->control" | "imem->regfile" | "imem->immgen"
  | "regfile->muxA" | "regfile->muxB" | "regfile->cmp1" | "regfile->cmp2" | "regfile->dmem"
  | "immgen->muxB" | "immgen->target"
  | "muxA->alu" | "muxB->alu" | "alu->dmem" | "alu->wbmux" | "alu->pcmux"
  | "dmem->wbmux" | "wbmux->regfile" | "target->pcmux" | "cmp->pcmux" | "pcmux->pc"
  | "regfile->csr" | "csr->wbmux" | "csr->pcmux"
  | "imem->fpregs" | "fpregs->fpu" | "fpu->fpregs" | "regfile->fpu" | "fpu->wbmux" | "dmem->fpregs" | "fpregs->dmem"
  | "regfile->vlanes" | "vregs->vlanes" | "vlanes->vregs" | "dmem->vregs" | "vregs->dmem" | "vlanes->wbmux";

export interface WireDef {
  id: WireId;
  points: [number, number][];
  /** Control wires are thinner and dashed. */
  control?: boolean;
  feature?: Feature;
}

export const WIRES: WireDef[] = [
  { id: "pc->imem", points: [[-10.2, 0], [-8.7, 0]] },
  { id: "pc->pc4", points: [[-11, 0.8], [-11, 3.4]] },
  { id: "pc4->pcmux", points: [[-11.8, 4], [-13, 4], [-13, 1.2]] },
  { id: "pc4->wbmux", points: [[-10.2, 4], [-9.6, 4], [-9.6, 7.2], [11.2, 7.2], [11.2, 0.6], [11.6, 0.6]] },
  { id: "pc->target", points: [[-11, -0.8], [-11, -6.6], [4.5, -6.6], [4.5, -5.6]] },
  { id: "pc->muxA", points: [[-9.7, 0], [-9.7, 2.6], [0.4, 2.6], [0.4, 1.6], [1.1, 1.6]] },
  { id: "imem->control", points: [[-7.5, 1.6], [-7.5, 4.3]] },
  { id: "imem->regfile", points: [[-6.3, 0.6], [-3.9, 0.6]] },
  { id: "imem->immgen", points: [[-6.3, -0.6], [-5, -0.6], [-5, -4.5], [-3.8, -4.5]] },
  { id: "regfile->muxA", points: [[-1.1, 0.8], [1.1, 0.8]] },
  { id: "regfile->muxB", points: [[-1.1, -0.8], [1.1, -0.8]] },
  { id: "regfile->cmp1", points: [[-0.4, 0.8], [-0.4, 4.2], [0.6, 4.2]] },
  { id: "regfile->cmp2", points: [[-0.1, -0.8], [-0.1, 3.8], [0.6, 3.8]] },
  { id: "regfile->dmem", points: [[-1.1, -1.5], [-0.6, -1.5], [-0.6, -3], [6.8, -3], [6.8, -0.8], [7.1, -0.8]] },
  { id: "immgen->muxB", points: [[-1.2, -4.3], [0.4, -4.3], [0.4, -1.6], [1.1, -1.6]] },
  { id: "immgen->target", points: [[-1.2, -4.8], [3.6, -4.8]] },
  { id: "muxA->alu", points: [[1.9, 1.2], [2.8, 1.2], [2.8, 0.7], [3.6, 0.7]] },
  { id: "muxB->alu", points: [[1.9, -1.2], [2.8, -1.2], [2.8, -0.7], [3.6, -0.7]] },
  { id: "alu->dmem", points: [[5.4, 0.4], [7.1, 0.4]] },
  { id: "alu->wbmux", points: [[5.4, -0.4], [6.2, -0.4], [6.2, -2.2], [10.6, -2.2], [10.6, -0.6], [11.6, -0.6]] },
  { id: "alu->pcmux", points: [[5.4, -1.1], [5.8, -1.1], [5.8, -8], [-14.5, -8], [-14.5, -0.8], [-13.4, -0.8]] },
  { id: "dmem->wbmux", points: [[9.9, 0], [11.6, 0]] },
  { id: "wbmux->regfile", points: [[12.4, 0], [13.2, 0], [13.2, -3.6], [-1.8, -3.6], [-1.8, -1.8]] },
  { id: "target->pcmux", points: [[5.4, -5], [6.2, -5], [6.2, -7.3], [-14, -7.3], [-14, -0.3], [-13.4, -0.3]] },
  { id: "cmp->pcmux", points: [[1.5, 4.6], [1.5, 6.4], [-12.7, 6.4], [-12.7, 1.2]], control: true },
  { id: "pcmux->pc", points: [[-12.6, 0], [-11.8, 0]] },
  // CSR file: rs1/uimm in, old value out to write-back, trap vector / mepc out to the PC mux.
  { id: "regfile->csr", points: [[-2.5, 1.8], [-2.5, 4.25]] },
  { id: "csr->wbmux", points: [[-1.4, 4.8], [-1.0, 4.8], [-1.0, 5.9], [10.8, 5.9], [10.8, 0.3], [11.6, 0.3]] },
  { id: "csr->pcmux", points: [[-3.2, 5.35], [-3.2, 5.95], [-15, 5.95], [-15, 0.3], [-13.4, 0.3]] },
  // FP lane
  { id: "imem->fpregs", points: [[-7.2, -1.6], [-7.2, -10]], feature: "fp" },
  { id: "fpregs->fpu", points: [[-5.1, -10.8], [-2.7, -10.8]], feature: "fp" },
  { id: "fpu->fpregs", points: [[-1.5, -12], [-1.5, -12.6], [-6.5, -12.6], [-6.5, -12]], feature: "fp" },
  { id: "regfile->fpu", points: [[-3.9, -1.2], [-4.3, -1.2], [-4.3, -9.8], [-2.2, -9.8], [-2.2, -10]], feature: "fp" },
  { id: "fpu->wbmux", points: [[-0.6, -10], [-0.6, -9.05], [12, -9.05], [12, -1.2]], feature: "fp" },
  { id: "dmem->fpregs", points: [[9.0, -1.6], [9.0, -9.35], [-6.0, -9.35], [-6.0, -10]], feature: "fp" },
  { id: "fpregs->dmem", points: [[-5.5, -10], [-5.5, -9.65], [9.4, -9.65], [9.4, -1.6]], feature: "fp" },
  // Vector lane
  { id: "dmem->vregs", points: [[7.6, -1.6], [7.6, -8.45], [4.0, -8.45], [4.0, -10]], feature: "vec" },
  { id: "vregs->dmem", points: [[5.0, -10], [5.0, -8.75], [8.0, -8.75], [8.0, -1.6]], feature: "vec" },
  { id: "regfile->vlanes", points: [[-3.9, -1.5], [-4.6, -1.5], [-4.6, -9.95], [10.4, -9.95], [10.4, -10]], feature: "vec" },
  { id: "vregs->vlanes", points: [[5.9, -11], [8.1, -11]], feature: "vec" },
  { id: "vlanes->vregs", points: [[9.5, -12], [9.5, -12.6], [4.5, -12.6], [4.5, -12]], feature: "vec" },
  { id: "vlanes->wbmux", points: [[10.9, -10.6], [12.3, -10.6], [12.3, -1.2]], feature: "vec" },
];

export const WIRE_BY_ID = new Map(WIRES.map((w) => [w.id, w]));

export const BOARD_BOUNDS = { minX: -15.5, maxX: 14.2, minY: -9, maxY: 8.2 };

/** Board extent for the features in use (the FP/vector lane adds a row below). */
export function boardBounds(features: Set<Feature>): typeof BOARD_BOUNDS {
  return features.has("fp") || features.has("vec") ? { ...BOARD_BOUNDS, minY: -13.4 } : BOARD_BOUNDS;
}

export function visible<T extends { feature?: Feature }>(items: T[], features: Set<Feature>): T[] {
  return items.filter((i) => !i.feature || features.has(i.feature));
}

/** Total polyline length. */
export function wireLength(points: [number, number][]): number {
  let L = 0;
  for (let i = 1; i < points.length; i++) {
    L += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return L;
}

/** Point at fraction t ∈ [0, 1] along a polyline (by arc length). */
export function pointAt(points: [number, number][], t: number): [number, number] {
  const total = wireLength(points);
  let target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (target <= seg || i === points.length - 1) {
      const f = seg === 0 ? 0 : Math.min(1, target / seg);
      return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
    }
    target -= seg;
  }
  return points[points.length - 1];
}
