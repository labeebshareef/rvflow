import { TONE_COLORS } from "@/scene/palette";
import type { Stage } from "./model";

/** One colour per stage, taken from the colour-blind-safe packet tones; shared by the diagram and the 3D view. */
export const STAGE_COLORS: Record<Stage, string> = {
  IF: TONE_COLORS.pc,
  ID: TONE_COLORS.instr,
  EX: TONE_COLORS.data,
  MEM: TONE_COLORS.addr,
  WB: TONE_COLORS.imm,
};

/** Stalls and forwarding use the control tone; flushes use red. */
export const STALL_COLOR = TONE_COLORS.ctrl;
export const FORWARD_COLOR = TONE_COLORS.ctrl;
export const FLUSH_COLOR = "#E5484D";

/** Dark ink for text drawn on top of a solid stage colour (all stage colours are light/mid tones). */
export const ON_STAGE_INK = "#0B1220";
