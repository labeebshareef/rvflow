import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "./components/button";

const KEYS: [string, string][] = [
  ["Space", "Play / pause"],
  ["→", "Next step (segment)"],
  ["Shift + →", "Next instruction"],
  ["←", "Back one step"],
  ["Shift + ←", "Undo the last instruction"],
  ["E", "Run to end or breakpoint"],
  ["R", "Reset"],
  ["X", "Explain this step"],
  ["Ctrl/⌘ + Enter", "Assemble (in the editor)"],
];

export function Help({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto rounded-lg border border-border bg-panel text-fg p-0 backdrop:bg-black/50 w-[min(28rem,calc(100%-2rem))]"
    >
      <div className="p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
          <Button size="sm" variant="ghost" aria-label="Close" onClick={onClose}><X size={14} /></Button>
        </div>
        <table className="w-full text-sm mt-2">
          <tbody>
            {KEYS.map(([k, v]) => (
              <tr key={k} className="border-t border-border/50">
                <td className="py-1.5"><kbd className="font-mono text-xs rounded border border-border bg-panel-2 px-1.5 py-0.5">{k}</kbd></td>
                <td className="text-muted">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted mt-3">
          Click a line number gutter (left of the numbers) or a listing row to set a breakpoint. With “Pause each step” off,
          Play animates the whole program and stops at breakpoints.
        </p>
      </div>
    </dialog>
  );
}
