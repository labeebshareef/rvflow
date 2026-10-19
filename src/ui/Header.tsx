import { Cpu as CpuIcon, FileUp, Hammer, Keyboard, Link2, Moon, Sun } from "lucide-react";
import { useRef, useState } from "react";
import { EXAMPLES } from "@/lessons/examples";
import { encodeShare, useSim } from "@/store/sim";
import { Button } from "./components/button";
import { ToggleGroup } from "./components/toggle-group";
import { Tooltip } from "./components/tooltip";

const CHAPTERS = [...new Set(EXAMPLES.map((e) => e.chapter))];

export function Header({ onHelp }: { onHelp: () => void }) {
  const s = useSim();
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const example = EXAMPLES.find((e) => e.id === s.exampleId);

  const share = async () => {
    const url = `${location.origin}${location.pathname}#code=${encodeShare(s.source)}`;
    history.replaceState(null, "", url);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the URL bar still has the link */
    }
  };

  const toggleTheme = () => {
    const next = s.theme === "dark" ? "light" : "dark";
    s.set("theme", next);
    try {
      localStorage.setItem("rvflow-theme", next);
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 border-b border-border bg-panel">
      <div className="flex items-center gap-2 mr-2">
        <CpuIcon size={20} className="text-accent" aria-hidden />
        <h1 className="text-sm font-semibold tracking-tight">
          rvflow <span className="font-normal text-muted hidden sm:inline">· inside the RISC-V processor</span>
        </h1>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted">
        <span className="hidden md:inline">Lesson</span>
        <select
          value={s.exampleId ?? ""}
          onChange={(e) => {
            const ex = EXAMPLES.find((x) => x.id === e.target.value);
            if (ex) s.loadExample(ex);
          }}
          className="h-8 max-w-[16rem] rounded-md border border-border bg-panel-2 px-2 text-xs text-fg"
        >
          {s.exampleId === null && <option value="">{s.elfName ?? "Your program"}</option>}
          {CHAPTERS.map((c) => (
            <optgroup key={c} label={c}>
              {EXAMPLES.filter((e) => e.chapter === c).map((e) => (
                <option key={e.id} value={e.id}>{e.title}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {example && <p className="text-xs text-muted hidden min-[1760px]:block max-w-md truncate" title={example.blurb}>{example.blurb}</p>}

      <ToggleGroup
        label="Processor implementation"
        value={s.arch}
        onChange={(a) => s.setArch(a)}
        options={[{ value: "single", label: "Single-cycle" }, { value: "multi", label: "Multi-cycle" }, { value: "pipeline", label: "Pipeline" }]}
      />

      <div className="ml-auto flex items-center gap-1.5">
        <input
          ref={fileRef}
          type="file"
          accept=".elf,application/octet-stream"
          className="hidden"
          aria-label="Open a RISC-V ELF file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) s.loadElf(new Uint8Array(await f.arrayBuffer()), f.name);
            e.target.value = "";
          }}
        />
        <Tooltip content="Run a 32-bit RISC-V ELF (e.g. one of tests/riscv-tests) instead of the editor's source">
          <Button size="sm" onClick={() => fileRef.current?.click()}>
            <FileUp size={14} /> ELF
          </Button>
        </Tooltip>
        <Tooltip content="Assemble and load (Ctrl/⌘ + Enter)">
          <Button size="sm" variant="primary" onClick={() => s.assembleAndLoad()}>
            <Hammer size={14} /> Assemble
          </Button>
        </Tooltip>
        <Tooltip content="Copy a link that contains this program">
          <Button size="sm" onClick={share}>
            <Link2 size={14} /> {copied ? "Copied" : "Share"}
          </Button>
        </Tooltip>
        <Tooltip content="Keyboard shortcuts">
          <Button size="sm" variant="ghost" aria-label="Keyboard shortcuts" onClick={onHelp}>
            <Keyboard size={16} />
          </Button>
        </Tooltip>
        <Tooltip content={s.theme === "dark" ? "Light theme" : "Dark theme"}>
          <Button size="sm" variant="ghost" aria-label="Toggle theme" onClick={toggleTheme}>
            {s.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}
