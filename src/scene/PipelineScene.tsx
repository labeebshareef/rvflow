import { Canvas, useThree } from "@react-three/fiber";
import { Line, QuadraticBezierLine, RoundedBox, Text } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import fontUrl from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff?url";
import { FLUSH_COLOR, FORWARD_COLOR, ON_STAGE_INK, STAGE_COLORS, STALL_COLOR } from "@/pipeline/colors";
import { STAGES, type CycleState, type Forward, type PipeOptions, type Slot, type Stage } from "@/pipeline/model";
import { SCENE, type SceneTheme } from "./palette";

/**
 * 2.5D view of the 5-stage pipeline for one cycle. The pipeline registers are
 * drawn as tall translucent walls standing up from the board: depth is the
 * clock edge every instruction has to cross.
 */

const BOUNDS = { minX: -15.6, maxX: 15.6, minY: -4.4, maxY: 5.4 };
const STAGE_X: Record<Stage, number> = { IF: -12, ID: -6, EX: 0, MEM: 6, WB: 12 };
const WALLS = [
  { label: "IF/ID", x: -9 },
  { label: "ID/EX", x: -3 },
  { label: "EX/MEM", x: 3 },
  { label: "MEM/WB", x: 9 },
] as const;
const WALL_X: Record<Forward["from"], number> = { "EX/MEM": 3, "MEM/WB": 9 };
const BLOCK = { y: 1.45, w: 3.8, h: 2.1, d: 0.45 };
const TOKEN = { y: -1.25, w: 5.0, h: 1.3, d: 0.3 };
const WALL = { y: 0.15, h: 5.0, d: 2.6, t: 0.14 };

const UNIT_LABELS: Record<Stage, [string, string]> = {
  IF: ["Instr Mem", "PC"],
  ID: ["Reg Read/Decode", "hazard detect"],
  EX: ["ALU", "branch compare"],
  MEM: ["Data Mem", "load / store"],
  WB: ["Write Back", "reg file write"],
};

/** troika fetches remote fonts for glyphs outside the bundled subset, so keep 3D text ASCII. */
const ascii = (s: string) => s.replace(/[^\x20-\x7E]/g, "?");
const hex = (v: number) => "0x" + (v >>> 0).toString(16).padStart(8, "0");

/** Fit the orthographic camera to the board whenever the canvas resizes. */
function CameraRig() {
  const { camera, size } = useThree();
  useEffect(() => {
    const bw = BOUNDS.maxX - BOUNDS.minX;
    const bh = BOUNDS.maxY - BOUNDS.minY;
    // The tilt makes the walls stick up above the board, so leave some headroom.
    const zoom = Math.min(size.width / bw, size.height / (bh * 1.12));
    const cx = (BOUNDS.minX + BOUNDS.maxX) / 2;
    const cy = (BOUNDS.minY + BOUNDS.maxY) / 2;
    camera.zoom = zoom;
    camera.position.set(cx, cy - 9, 26);
    camera.lookAt(cx, cy + 0.4, 0);
    camera.updateProjectionMatrix();
  }, [camera, size]);
  return null;
}

/** Redraw whenever the shown cycle, theme or options change (frameloop="demand"). */
function Invalidator({ state, theme, options }: { state: CycleState | undefined; theme: SceneTheme; options: PipeOptions }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [invalidate, state, theme, options]);
  return null;
}

function Board({ theme }: { theme: SceneTheme }) {
  const c = SCENE[theme];
  const w = BOUNDS.maxX - BOUNDS.minX + 1;
  const h = BOUNDS.maxY - BOUNDS.minY + 1;
  const cx = (BOUNDS.minX + BOUNDS.maxX) / 2;
  const cy = (BOUNDS.minY + BOUNDS.maxY) / 2;
  const grid = useMemo(() => {
    const pts: [number, number, number][][] = [];
    for (let x = Math.ceil(BOUNDS.minX); x <= BOUNDS.maxX; x++) pts.push([[x, BOUNDS.minY, -0.01], [x, BOUNDS.maxY, -0.01]]);
    for (let y = Math.ceil(BOUNDS.minY); y <= BOUNDS.maxY; y++) pts.push([[BOUNDS.minX, y, -0.01], [BOUNDS.maxX, y, -0.01]]);
    return pts;
  }, []);
  return (
    <group>
      <mesh position={[cx, cy, -0.06]}>
        <boxGeometry args={[w, h, 0.08]} />
        <meshBasicMaterial color={c.board} />
      </mesh>
      {grid.map((p, i) => (
        <Line key={i} points={p} color={c.grid} lineWidth={0.6} />
      ))}
      {/* Instruction flow: a lane under the tokens. */}
      <Line points={[[BOUNDS.minX + 0.6, TOKEN.y, 0.02], [BOUNDS.maxX - 0.6, TOKEN.y, 0.02]]} color={c.wire} lineWidth={1.4} dashed dashSize={0.3} gapSize={0.2} />
    </group>
  );
}

function Label({ text, ...p }: { text: string; position: [number, number, number]; size?: number; color: string; anchorX?: "left" | "center" | "right"; outline?: string; maxWidth?: number }) {
  return (
    <Text
      font={fontUrl}
      position={p.position}
      fontSize={p.size ?? 0.3}
      color={p.color}
      anchorX={p.anchorX ?? "center"}
      anchorY="middle"
      maxWidth={p.maxWidth}
      textAlign="center"
      outlineWidth={p.outline ? 0.04 : 0}
      outlineColor={p.outline ?? "#000000"}
    >
      {ascii(text)}
    </Text>
  );
}

function StageUnit({ stage, theme, busy }: { stage: Stage; theme: SceneTheme; busy: boolean }) {
  const c = SCENE[theme];
  const [title, sub] = UNIT_LABELS[stage];
  const x = STAGE_X[stage];
  return (
    <group position={[x, BLOCK.y, busy ? 0.12 : 0]}>
      <RoundedBox args={[BLOCK.w, BLOCK.h, BLOCK.d]} radius={0.12} smoothness={3} position={[0, 0, BLOCK.d / 2]}>
        <meshStandardMaterial color={busy ? c.unitActive : c.unit} emissive={busy ? STAGE_COLORS[stage] : "#000000"} emissiveIntensity={busy ? 0.12 : 0} roughness={0.6} />
      </RoundedBox>
      {/* Stage colour strip along the top edge of the block. */}
      <mesh position={[0, BLOCK.h / 2 - 0.09, BLOCK.d + 0.011]}>
        <planeGeometry args={[BLOCK.w - 0.3, 0.1]} />
        <meshBasicMaterial color={STAGE_COLORS[stage]} toneMapped={false} />
      </mesh>
      <Label text={title} position={[0, 0.2, BLOCK.d + 0.02]} size={title.length > 10 ? 0.3 : 0.38} color={c.text} maxWidth={BLOCK.w * 0.95} />
      <Label text={sub} position={[0, -0.45, BLOCK.d + 0.02]} size={0.24} color={c.textDim} />
      <Label text={stage} position={[0, BLOCK.h / 2 + 0.5, 0.05]} size={0.44} color={STAGE_COLORS[stage]} outline={c.board} />
    </group>
  );
}

function Wall({ label, x, theme }: { label: string; x: number; theme: SceneTheme }) {
  const c = SCENE[theme];
  const top = WALL.y + WALL.h / 2;
  const bot = WALL.y - WALL.h / 2;
  const edge: [number, number, number][] = [
    [x, bot, 0.02], [x, bot, WALL.d], [x, top, WALL.d], [x, top, 0.02],
  ];
  return (
    <group>
      <mesh position={[x, WALL.y, WALL.d / 2]}>
        <boxGeometry args={[WALL.t, WALL.h, WALL.d]} />
        <meshStandardMaterial color={c.wireActive} transparent opacity={theme === "dark" ? 0.22 : 0.28} depthWrite={false} roughness={0.3} />
      </mesh>
      <Line points={edge} color={c.wireActive} lineWidth={1.2} transparent opacity={0.7} />
      <Label text={label} position={[x, top + 0.38, WALL.d]} size={0.3} color={c.text} outline={c.board} />
    </group>
  );
}

function Token({ stage, slot, theme }: { stage: Stage; slot: Slot | null; theme: SceneTheme }) {
  const c = SCENE[theme];
  const x = STAGE_X[stage];
  if (!slot) {
    return <Label text="(empty)" position={[x, TOKEN.y, 0.05]} size={0.26} color={c.textDim} />;
  }
  if (slot.bubble && !slot.squashed) {
    return (
      <group position={[x, TOKEN.y, 0.05]}>
        <mesh position={[-1.5, 0, 0.02]}>
          <ringGeometry args={[0.36, 0.5, 40]} />
          <meshBasicMaterial color={c.textDim} transparent opacity={0.9} />
        </mesh>
        <Label text="bubble" position={[-0.7, 0, 0.05]} size={0.32} color={c.textDim} anchorX="left" />
      </group>
    );
  }
  const squashed = !!slot.squashed;
  const color = squashed ? FLUSH_COLOR : STAGE_COLORS[stage];
  const dim = slot.wrongPath && !squashed;
  const sub = squashed ? "flushed" : slot.stalled ? "stalled" : slot.wrongPath ? "wrong path" : slot.seq !== undefined ? `#${slot.seq}` : "";
  return (
    <group position={[x, TOKEN.y, slot.stalled ? 0.05 : 0.25]}>
      <RoundedBox args={[TOKEN.w, TOKEN.h, TOKEN.d]} radius={0.14} smoothness={3} position={[0, 0, TOKEN.d / 2]}>
        <meshStandardMaterial color={color} transparent={dim} opacity={dim ? 0.45 : 1} roughness={0.5} />
      </RoundedBox>
      {slot.stalled && (
        <Line
          points={[[-TOKEN.w / 2 - 0.1, -TOKEN.h / 2 - 0.1, 0.1], [TOKEN.w / 2 + 0.1, -TOKEN.h / 2 - 0.1, 0.1], [TOKEN.w / 2 + 0.1, TOKEN.h / 2 + 0.1, 0.1], [-TOKEN.w / 2 - 0.1, TOKEN.h / 2 + 0.1, 0.1], [-TOKEN.w / 2 - 0.1, -TOKEN.h / 2 - 0.1, 0.1]]}
          color={STALL_COLOR}
          lineWidth={2.4}
          dashed
          dashSize={0.2}
          gapSize={0.12}
        />
      )}
      <Text
        font={fontUrl}
        position={[0, 0.17, TOKEN.d + 0.02]}
        fontSize={0.34}
        color={ON_STAGE_INK}
        anchorX="center"
        anchorY="middle"
        maxWidth={TOKEN.w - 0.3}
        whiteSpace="nowrap"
        overflowWrap="normal"
        clipRect={[-(TOKEN.w - 0.3) / 2, -1, (TOKEN.w - 0.3) / 2, 1]}
        fillOpacity={dim ? 0.7 : 1}
      >
        {ascii(slot.text)}
      </Text>
      {squashed && <Line points={[[-TOKEN.w / 2 + 0.2, 0.17, TOKEN.d + 0.03], [TOKEN.w / 2 - 0.2, 0.17, TOKEN.d + 0.03]]} color={ON_STAGE_INK} lineWidth={1.6} />}
      <Label text={sub} position={[0, -0.33, TOKEN.d + 0.02]} size={0.24} color={ON_STAGE_INK} />
    </group>
  );
}

function ForwardArc({ f, theme }: { f: Forward; theme: SceneTheme }) {
  const c = SCENE[theme];
  const fromX = WALL_X[f.from];
  const toX = f.to === "MEM" ? STAGE_X.MEM : STAGE_X.EX;
  const y = TOKEN.y + (f.operand === "rs1" ? 0.38 : -0.38);
  const start: [number, number, number] = [fromX, y, WALL.d];
  const end: [number, number, number] = [toX + 1.4, y, TOKEN.d + 0.35];
  const lift = 2.2 + Math.abs(fromX - toX) * 0.18;
  const mid: [number, number, number] = [(fromX + toX + 1.4) / 2, y, WALL.d + lift];
  const label = `${f.reg} -> ${f.operand}${f.to === "MEM" ? " (store data)" : ""}`;
  return (
    <group>
      <QuadraticBezierLine start={start} end={end} mid={mid} color={FORWARD_COLOR} lineWidth={3} />
      <mesh position={end}>
        <sphereGeometry args={[0.13, 16, 16]} />
        <meshBasicMaterial color={FORWARD_COLOR} toneMapped={false} />
      </mesh>
      <mesh position={start}>
        <sphereGeometry args={[0.1, 16, 16]} />
        <meshBasicMaterial color={FORWARD_COLOR} toneMapped={false} />
      </mesh>
      <Label text={label} position={[mid[0], y, (WALL.d + mid[2]) / 2 + 0.6]} size={0.3} color={FORWARD_COLOR} outline={c.board} />
    </group>
  );
}

function Indicator({ x, text, color, on, theme }: { x: number; text: string; color: string; on: boolean; theme: SceneTheme }) {
  const c = SCENE[theme];
  const w = 7.2;
  return (
    <group position={[x, 4.55, 0.05]}>
      <RoundedBox args={[w, 0.8, 0.12]} radius={0.1} smoothness={2} position={[0, 0, 0.06]}>
        <meshBasicMaterial color={on ? color : c.unit} transparent opacity={on ? 1 : 0.6} toneMapped={false} />
      </RoundedBox>
      <Label text={text} position={[0, 0, 0.14]} size={0.3} color={on ? ON_STAGE_INK : c.textDim} maxWidth={w - 0.2} />
    </group>
  );
}

function Scene({ theme, state, options }: { theme: SceneTheme; state: CycleState | undefined; options: PipeOptions }) {
  const c = SCENE[theme];
  const ifSlot = state?.stages.IF;
  const stall = state?.stall;
  const flush = state?.flush;
  return (
    <>
      <ambientLight intensity={theme === "dark" ? 0.75 : 1.1} />
      <directionalLight position={[-6, -10, 20]} intensity={theme === "dark" ? 1.3 : 1.6} />
      <Board theme={theme} />
      {STAGES.map((s) => {
        const slot = state?.stages[s] ?? null;
        return <StageUnit key={s} stage={s} theme={theme} busy={!!slot && !slot.bubble && !slot.wrongPath} />;
      })}
      {STAGES.map((s) => (
        <Token key={s} stage={s} slot={state?.stages[s] ?? null} theme={theme} />
      ))}
      {WALLS.map((w) => (
        <Wall key={w.label} label={w.label} x={w.x} theme={theme} />
      ))}
      {state?.forwards.map((f, i) => <ForwardArc key={i} f={f} theme={theme} />)}

      <Label text={state ? `cycle ${state.cycle}` : "cycle -"} position={[BOUNDS.minX + 0.4, 4.55, 0.05]} size={0.5} color={c.text} anchorX="left" />
      <Indicator x={-5.2} theme={theme} on={!!stall} color={STALL_COLOR} text={stall ? `hazard unit: stall (${stall.reason})` : "hazard unit: no stall"} />
      <Indicator x={2.8} theme={theme} on={!!flush} color={FLUSH_COLOR} text={flush ? `flush ${flush.squashedRows.length}: ${flush.reason}` : "no flush"} />
      <Label
        text={`${options.forwarding ? "forwarding on" : "forwarding off"} | ${options.predictor}`}
        position={[BOUNDS.maxX - 0.4, 4.55, 0.05]}
        size={0.28}
        color={c.textDim}
        anchorX="right"
      />
      <Label
        text={ifSlot && !ifSlot.bubble ? `PC ${hex(ifSlot.pc)}` : "PC -"}
        position={[STAGE_X.IF, TOKEN.y - TOKEN.h / 2 - 0.5, 0.05]}
        size={0.3}
        color={STAGE_COLORS.IF}
        outline={c.board}
      />
      <Label
        text={state ? `retired ${state.retired}` : ""}
        position={[STAGE_X.WB, TOKEN.y - TOKEN.h / 2 - 0.5, 0.05]}
        size={0.3}
        color={c.textDim}
      />
    </>
  );
}

export default function PipelineScene({ theme, state, options }: { theme: SceneTheme; state: CycleState | undefined; options: PipeOptions }) {
  return (
    <Canvas
      orthographic
      flat
      frameloop="demand"
      dpr={[1, 2]}
      camera={{ position: [0, -9, 26], zoom: 30, near: 0.1, far: 200 }}
      gl={{ antialias: true }}
      aria-label={state ? `Five-stage pipeline, cycle ${state.cycle}` : "Five-stage pipeline"}
      style={{ background: SCENE[theme].board }}
    >
      <CameraRig />
      <Invalidator state={state} theme={theme} options={options} />
      <Scene theme={theme} state={state} options={options} />
    </Canvas>
  );
}
