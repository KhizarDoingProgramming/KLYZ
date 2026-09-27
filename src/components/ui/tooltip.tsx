import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Lightweight tooltip: shows on hover and keyboard focus, hides on blur.
 * The trigger keeps its own accessible name; the bubble is decorative.
 */
export function Tooltip({
  label,
  side = "bottom",
  shortcut,
  className,
  children,
}: {
  label: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  shortcut?: React.ReactNode;
  className?: string;
  children: React.ReactElement;
}) {
  const placement = {
    top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
    bottom: "top-full left-1/2 mt-2 -translate-x-1/2",
    left: "right-full top-1/2 mr-2 -translate-y-1/2",
    right: "left-full top-1/2 ml-2 -translate-y-1/2",
  }[side];

  return (
    <span className={cn("group/tooltip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-80 hidden whitespace-nowrap rounded-md border border-line bg-overlay px-2 py-1.5 text-[11px] text-fg shadow-md",
          "group-hover/tooltip:inline-flex group-focus-within/tooltip:inline-flex items-center gap-2",
          placement,
        )}
      >
        {label}
        {shortcut}
      </span>
    </span>
  );
}
