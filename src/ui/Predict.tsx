import { Check, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { dismissPredict, useSim } from "@/store/sim";
import { Button } from "./components/button";

/** Predict-then-reveal prompt shown over the datapath. */
export function Predict() {
  const p = useSim((s) => s.predict);
  const answer = useSim((s) => s.answerPredict);
  if (!p) return null;
  const right = p.chosen === p.answer;
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="predict-q"
      className="absolute top-3 left-1/2 -translate-x-1/2 z-10 w-[min(28rem,calc(100%-2rem))] rounded-lg border border-border bg-panel/95 backdrop-blur p-4 shadow-xl"
    >
      <p id="predict-q" className="text-sm font-semibold">Predict: {p.question}</p>
      <div className="flex flex-wrap gap-2 mt-3">
        {p.options.map((o) => (
          <Button
            key={o}
            size="sm"
            variant={p.chosen === o ? "primary" : "outline"}
            disabled={!!p.chosen}
            onClick={() => answer(o)}
            className={cn("font-mono", p.chosen && o === p.answer && "border-ok text-ok")}
          >
            {o}
          </Button>
        ))}
      </div>
      {p.chosen && (
        <div className="mt-3 flex items-start gap-2 text-sm" aria-live="assertive">
          {right ? <Check size={18} className="text-ok shrink-0" /> : <X size={18} className="text-danger shrink-0" />}
          <p>
            <span className={right ? "text-ok" : "text-danger"}>{right ? "Correct." : `Not quite — it's ${p.answer}.`}</span>{" "}
            <span className="text-muted">{p.explain}</span>
          </p>
        </div>
      )}
      {p.chosen && (
        <Button size="sm" variant="primary" className="mt-3" onClick={dismissPredict} autoFocus>
          Continue
        </Button>
      )}
    </div>
  );
}
