import { lazy, Suspense, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useSim } from "@/store/sim";
import { TooltipProvider } from "@/ui/components/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/components/tabs";
import { Header } from "@/ui/Header";
import { Editor } from "@/ui/Editor";
import { Listing } from "@/ui/Listing";
import { Registers } from "@/ui/Registers";
import { Memory } from "@/ui/Memory";
import { Encoding } from "@/ui/Encoding";
import { ControlPanel } from "@/ui/ControlPanel";
import { Console } from "@/ui/Console";
import { Narration } from "@/ui/Narration";
import { Transport } from "@/ui/Transport";
import { Predict } from "@/ui/Predict";
import { Legend } from "@/ui/Legend";
import { Help } from "@/ui/Help";
import { useShortcuts } from "@/ui/useShortcuts";
import { CacheTab } from "@/ui/CacheTab";
import { Performance } from "@/ui/Performance";
import { PipelineCanvas, PipelinePanel } from "@/ui/PipelineView";

const Datapath = lazy(() => import("@/scene/Datapath"));

function Errors() {
  const errors = useSim((s) => s.errors);
  if (!errors.length) return null;
  return (
    <ul className="border-t border-border bg-danger/10 max-h-32 overflow-auto text-xs" aria-live="polite">
      {errors.map((e, i) => (
        <li key={i} className="flex gap-2 px-3 py-1 text-danger">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className="font-mono">line {e.line}:</span> {e.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  const theme = useSim((s) => s.theme);
  const arch = useSim((s) => s.arch);
  const features = useSim((s) => s.features);
  const [help, setHelp] = useState(false);
  useShortcuts(() => setHelp(true));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return (
    <TooltipProvider>
      <div className="flex flex-col min-h-full lg:h-full lg:min-h-0">
        <Header onHelp={() => setHelp(true)} />
        <main
          className="flex-1 grid gap-px bg-border lg:min-h-0 lg:overflow-hidden
                     grid-cols-1 lg:grid-cols-[minmax(300px,22rem)_minmax(0,1fr)_minmax(300px,22rem)]"
        >
          {/* Source editor and machine-code listing */}
          <section aria-label="Program" className="order-3 lg:order-1 bg-panel flex flex-col h-[32rem] lg:h-auto lg:min-h-0">
            <Tabs defaultValue="code" className="flex flex-col flex-1 min-h-0">
              <TabsList>
                <TabsTrigger value="code">Code</TabsTrigger>
                <TabsTrigger value="listing">Listing</TabsTrigger>
              </TabsList>
              <TabsContent value="code" className="flex flex-col">
                <div className="flex-1 min-h-0"><Editor /></div>
              </TabsContent>
              <TabsContent value="listing"><Listing /></TabsContent>
            </Tabs>
            <Errors />
          </section>

          {/* Datapath, narration and transport */}
          <section aria-label="Datapath" className="order-1 lg:order-2 bg-panel flex flex-col lg:min-h-0">
            <div className="relative h-[62vw] min-h-56 lg:h-auto lg:flex-1 lg:min-h-[24rem]">
              {arch === "pipeline" ? (
                <PipelineCanvas theme={theme} />
              ) : (
                <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-sm text-muted">Loading datapath…</div>}>
                  <Datapath theme={theme} features={features} />
                </Suspense>
              )}
              {arch !== "pipeline" && <Predict />}
              {arch !== "pipeline" && <Legend />}
              <p className="absolute top-2 right-3 text-[10px] text-muted pointer-events-none">
                {arch === "pipeline" ? "Classic 5-stage pipeline (IF ID EX MEM WB)" : arch === "multi" ? "Multi-cycle: one step per clock" : "Single-cycle RV32IMAFDCV"} · a textbook implementation
              </p>
            </div>
            <Narration />
            <Transport />
            {arch === "pipeline" && (
              <div className="h-[18rem] border-t border-border">
                <PipelinePanel />
              </div>
            )}
          </section>

          {/* State inspectors */}
          <section aria-label="Processor state" className="order-2 lg:order-3 bg-panel flex flex-col h-[32rem] lg:h-auto lg:min-h-0">
            <Tabs defaultValue="regs" className="flex flex-col flex-1 min-h-0">
              <TabsList>
                <TabsTrigger value="regs">Registers</TabsTrigger>
                <TabsTrigger value="enc">Encoding</TabsTrigger>
                <TabsTrigger value="mem">Memory</TabsTrigger>
                <TabsTrigger value="ctrl">Control</TabsTrigger>
                <TabsTrigger value="cache">Cache</TabsTrigger>
                <TabsTrigger value="perf">Perf</TabsTrigger>
                <TabsTrigger value="out">Console</TabsTrigger>
              </TabsList>
              <TabsContent value="regs"><Registers /></TabsContent>
              <TabsContent value="enc"><Encoding /></TabsContent>
              <TabsContent value="mem"><Memory /></TabsContent>
              <TabsContent value="ctrl"><ControlPanel /></TabsContent>
              <TabsContent value="cache"><CacheTab /></TabsContent>
              <TabsContent value="perf"><Performance /></TabsContent>
              <TabsContent value="out"><Console /></TabsContent>
            </Tabs>
          </section>
        </main>
      </div>
      <Help open={help} onClose={() => setHelp(false)} />
    </TooltipProvider>
  );
}
