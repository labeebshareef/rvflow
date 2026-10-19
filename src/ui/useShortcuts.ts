import { useEffect } from "react";
import { useSim } from "@/store/sim";

/** Global keyboard control. Ignored while typing in the editor or a field. */
export function useShortcuts(onHelp: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest(".cm-editor, input, textarea, select, [role=slider], dialog")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useSim.getState();
      let handled = true;
      switch (e.key) {
        case " ":
          if (el?.closest("button")) return; // let buttons handle Space themselves
          s.togglePlay();
          break;
        case "ArrowRight":
          if (e.shiftKey) s.stepInstruction();
          else s.stepSegment();
          break;
        case "ArrowLeft":
          if (e.shiftKey) s.undoInstruction();
          else s.backSegment();
          break;
        case "e": case "E": s.runToEnd(); break;
        case "r": case "R": s.reset(); break;
        case "x": case "X": s.set("explainOpen", !s.explainOpen); break;
        case "?": onHelp(); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onHelp]);
}
