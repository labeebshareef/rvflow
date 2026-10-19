import { useMemo } from "react";
import { cachesFor } from "@/store/derived";
import { useSim } from "@/store/sim";
import { CachePanel } from "./CachePanel";

/** L1 instruction and data caches, replayed from the instructions executed so far. */
export function CacheTab() {
  const s = useSim();
  const { history, cacheCfgs, version } = s;
  const snap = useMemo(() => cachesFor(history, cacheCfgs), [history, cacheCfgs, version]);
  return (
    <CachePanel
      caches={snap.caches.map((c, i) => ({ cfg: c.cfg, view: c.view(), stats: c.stats(), last: snap.last[i] }))}
      onConfigChange={(i, cfg) => {
        const next = [...cacheCfgs] as typeof cacheCfgs;
        next[i] = cfg;
        s.set("cacheCfgs", next);
      }}
      onReset={() => s.set("cacheCfgs", [...cacheCfgs] as typeof cacheCfgs)}
    />
  );
}
