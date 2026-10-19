import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line, RoundedBox, Text } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import fontUrl from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff?url";
import type { Segment } from "@/anim/choreography";
import { useSim } from "@/store/sim";
import {
  UNITS, WIRES, WIRE_BY_ID, boardBounds, pointAt, visible, type Feature, type UnitDef, type UnitId, type WireDef, type WireId,
} from "./layout";
import { SCENE, TONE_COLORS, type SceneTheme } from "./palette";

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const DEPTH = 0.45;

type Bounds = ReturnType<typeof boardBounds>;

/** Fit the orthographic camera to the board whenever the canvas resizes. */
function CameraRig({ bounds: BOARD_BOUNDS }: { bounds: Bounds }) {
  const { camera, size } = useThree();
  useEffect(() => {
    const bw = BOARD_BOUNDS.maxX - BOARD_BOUNDS.minX;
    const bh = BOARD_BOUNDS.maxY - BOARD_BOUNDS.minY;
    // The camera is tilted, so the board looks a bit shorter on screen than it is.
    const zoom = Math.min(size.width / bw, size.height / (bh * 0.92));
    camera.zoom = zoom;
    camera.position.set((BOARD_BOUNDS.minX + BOARD_BOUNDS.maxX) / 2, (BOARD_BOUNDS.minY + BOARD_BOUNDS.maxY) / 2 - 9, 26);
    camera.lookAt((BOARD_BOUNDS.minX + BOARD_BOUNDS.maxX) / 2, (BOARD_BOUNDS.minY + BOARD_BOUNDS.maxY) / 2, 0);
    camera.updateProjectionMatrix();
  }, [camera, size, BOARD_BOUNDS]);
  return null;
}

/** Redraw on any store change (frameloop="demand"). */
function Invalidator() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => useSim.subscribe(() => invalidate()), [invalidate]);
  return null;
}

function Board({ theme, bounds: BOARD_BOUNDS }: { theme: SceneTheme; bounds: Bounds }) {
  const c = SCENE[theme];
  const w = BOARD_BOUNDS.maxX - BOARD_BOUNDS.minX + 1;
  const h = BOARD_BOUNDS.maxY - BOARD_BOUNDS.minY + 1;
  const cx = (BOARD_BOUNDS.minX + BOARD_BOUNDS.maxX) / 2;
  const cy = (BOARD_BOUNDS.minY + BOARD_BOUNDS.maxY) / 2;
  const grid = useMemo(() => {
    const pts: [number, number, number][][] = [];
    for (let x = Math.ceil(BOARD_BOUNDS.minX); x <= BOARD_BOUNDS.maxX; x++) {
      pts.push([[x, BOARD_BOUNDS.minY, -0.01], [x, BOARD_BOUNDS.maxY, -0.01]]);
    }
    for (let y = Math.ceil(BOARD_BOUNDS.minY); y <= BOARD_BOUNDS.maxY; y++) {
      pts.push([[BOARD_BOUNDS.minX, y, -0.01], [BOARD_BOUNDS.maxX, y, -0.01]]);
    }
    return pts;
  }, [BOARD_BOUNDS]);
  return (
    <group>
      <mesh position={[cx, cy, -0.06]}>
        <boxGeometry args={[w, h, 0.08]} />
        <meshBasicMaterial color={c.board} />
      </mesh>
      {grid.map((p, i) => (
        <Line key={i} points={p} color={c.grid} lineWidth={0.6} />
      ))}
    </group>
  );
}

interface UnitProps {
  u: UnitDef;
  theme: SceneTheme;
  active: boolean;
  idle: boolean;
  sel?: string;
}

function Unit({ u, theme, active, idle, sel }: UnitProps) {
  const c = SCENE[theme];
  const lift = active ? 0.18 : 0;
  const color = active ? c.unitActive : c.unit;
  const opacity = idle ? 0.22 : 1;
  const big = u.w >= 1.5;
  return (
    <group position={[u.x, u.y, lift]}>
      <RoundedBox args={[u.w, u.h, DEPTH]} radius={u.kind === "mux" ? 0.35 : 0.12} smoothness={3} position={[0, 0, DEPTH / 2]}>
        <meshStandardMaterial
          color={color}
          emissive={active ? c.wireActive : "#000000"}
          emissiveIntensity={active ? 0.22 : 0}
          transparent={idle}
          opacity={opacity}
          roughness={0.6}
        />
      </RoundedBox>
      <Text
        font={fontUrl}
        position={[0, u.sub && big ? 0.18 : 0, DEPTH + 0.02]}
        fontSize={big ? 0.36 : 0.3}
        color={idle ? c.textDim : c.text}
        anchorX="center"
        anchorY="middle"
        fillOpacity={idle ? 0.5 : 1}
        maxWidth={u.w * 0.95}
        textAlign="center"
      >
        {u.label}
      </Text>
      {u.sub && big && (
        <Text font={fontUrl} position={[0, -0.26, DEPTH + 0.02]} fontSize={0.26} color={c.textDim} anchorX="center" anchorY="middle" fillOpacity={idle ? 0.5 : 1}>
          {u.sub}
        </Text>
      )}
      {sel && (
        <Text
          font={fontUrl}
          position={[0, -u.h / 2 - 0.36, DEPTH + 0.02]}
          fontSize={0.34}
          color={TONE_COLORS.ctrl}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.03}
          outlineColor={c.board}
        >
          {sel}
        </Text>
      )}
    </group>
  );
}

function Wire({ w, theme, active, faded }: { w: WireDef; theme: SceneTheme; active: boolean; faded: boolean }) {
  const c = SCENE[theme];
  const pts = useMemo(() => w.points.map(([x, y]) => [x, y, 0.04] as [number, number, number]), [w]);
  const color = w.control ? (active ? TONE_COLORS.ctrl : c.control) : active ? c.wireActive : c.wire;
  return (
    <Line
      points={pts}
      color={color}
      lineWidth={active ? 3.2 : 1.6}
      dashed={w.control}
      dashSize={0.25}
      gapSize={0.18}
      transparent
      opacity={faded ? 0.35 : 1}
    />
  );
}

/** Is the last stretch of a wire vertical? Decides which side its value label sits on. */
function verticalEnd(id: WireId): boolean {
  const pts = WIRE_BY_ID.get(id)!.points;
  const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
  return Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
}

/** Packets travel along their wires; positions update per frame without React re-renders. */
function Packets({ seg, theme }: { seg: Segment | undefined; theme: SceneTheme }) {
  const refs = useRef<(Group | null)[]>([]);
  const c = SCENE[theme];

  useFrame(() => {
    if (!seg) return;
    const t = ease(Math.min(1, Math.max(0, useSim.getState().segT)));
    seg.packets.forEach((p, i) => {
      const g = refs.current[i];
      const wire = WIRE_BY_ID.get(p.wire);
      if (!g || !wire) return;
      const [x, y] = pointAt(wire.points, t);
      g.position.set(x, y, 0.9);
    });
  });

  if (!seg) return null;
  return (
    <>
      {seg.packets.map((p, i) => (
        <group key={`${seg.id}-${i}`} ref={(el) => void (refs.current[i] = el)}>
          <mesh>
            <sphereGeometry args={[0.2, 20, 20]} />
            <meshBasicMaterial color={TONE_COLORS[p.tone]} toneMapped={false} />
          </mesh>
          <mesh>
            <sphereGeometry args={[0.36, 20, 20]} />
            <meshBasicMaterial color={TONE_COLORS[p.tone]} transparent opacity={0.22} toneMapped={false} depthWrite={false} />
          </mesh>
          {/* Beside the wire, never on top of the unit it enters. */}
          <group position={verticalEnd(p.wire) ? [0.42, 0, 0.2] : [0.1, 0.36, 0.2]}>
            <Text
              font={fontUrl}
              fontSize={0.34}
              color={TONE_COLORS[p.tone]}
              anchorX={verticalEnd(p.wire) ? "left" : "right"}
              anchorY={verticalEnd(p.wire) ? "middle" : "bottom"}
              outlineWidth={0.06}
              outlineColor={c.board}
            >
              {p.label}
            </Text>
          </group>
        </group>
      ))}
    </>
  );
}

function Scene({ theme, features, bounds }: { theme: SceneTheme; features: Set<Feature>; bounds: Bounds }) {
  const segments = useSim((s) => s.segments);
  const segIndex = useSim((s) => s.segIndex);
  const showControl = useSim((s) => s.showControl);
  const seg = segments[segIndex];
  const activeUnits = new Set<UnitId>(seg?.units ?? []);
  const activeWires = new Set(seg?.wires ?? []);
  const idle = new Set<UnitId>(seg?.idle ?? []);
  const hasSeg = !!seg && seg.id !== "assemble";

  return (
    <>
      <ambientLight intensity={theme === "dark" ? 0.75 : 1.1} />
      <directionalLight position={[-6, -10, 20]} intensity={theme === "dark" ? 1.3 : 1.6} />
      <Board theme={theme} bounds={bounds} />
      {visible(WIRES, features).filter((w) => showControl || !w.control).map((w) => (
        <Wire key={w.id} w={w} theme={theme} active={activeWires.has(w.id)} faded={hasSeg && !activeWires.has(w.id)} />
      ))}
      {visible(UNITS, features).map((u) => (
        <Unit
          key={u.id}
          u={u}
          theme={theme}
          active={activeUnits.has(u.id)}
          idle={idle.has(u.id)}
          sel={seg?.muxSel?.[u.id as "muxA" | "muxB" | "wbmux" | "pcmux"]}
        />
      ))}
      <Packets seg={seg} theme={theme} />
    </>
  );
}

export default function Datapath({ theme, features }: { theme: SceneTheme; features: Set<Feature> }) {
  const bounds = useMemo(() => boardBounds(features), [features]);
  return (
    <Canvas
      orthographic
      flat
      frameloop="demand"
      dpr={[1, 2]}
      camera={{ position: [0, -9, 26], zoom: 30, near: 0.1, far: 200 }}
      gl={{ antialias: true }}
      aria-label="Single-cycle datapath"
      style={{ background: SCENE[theme].board }}
    >
      <CameraRig bounds={bounds} />
      <Invalidator />
      <Scene theme={theme} features={features} bounds={bounds} />
    </Canvas>
  );
}
