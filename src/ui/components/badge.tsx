import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("inline-flex items-center rounded border border-border bg-panel-2 px-1.5 py-0.5 text-[10px] font-mono text-muted", className)}
      {...props}
    />
  );
}
