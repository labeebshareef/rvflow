import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("flex gap-1 border-b border-border px-2 overflow-x-auto", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "px-2.5 py-2 text-xs font-medium text-muted border-b-2 border-transparent -mb-px whitespace-nowrap",
        "hover:text-fg data-[state=active]:text-fg data-[state=active]:border-accent",
        "focus-visible:outline-2 focus-visible:outline-accent",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("flex-1 min-h-0 overflow-auto outline-none", className)} {...props} />;
}
