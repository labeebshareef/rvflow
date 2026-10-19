import * as SwitchPrimitive from "@radix-ui/react-switch";
import { useId, type ComponentProps } from "react";
import { cn } from "@/lib/cn";

export function Switch({ className, label, ...props }: ComponentProps<typeof SwitchPrimitive.Root> & { label: string }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <SwitchPrimitive.Root
        id={id}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full bg-border transition-colors data-[state=checked]:bg-accent",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          className,
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-panel shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </SwitchPrimitive.Root>
      <label htmlFor={id} className="text-xs text-muted select-none cursor-pointer">
        {label}
      </label>
    </div>
  );
}
