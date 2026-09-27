import * as React from "react";
import { cn } from "@/lib/utils";
import { statusMeta } from "@/lib/status";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: string;
  tone?: "neutral" | "signal";
  dot?: boolean;
}

export function Badge({
  status,
  tone = "neutral",
  dot = true,
  className,
  children,
  ...props
}: BadgeProps) {
  const meta = status ? statusMeta(status) : null;
  const classes = meta
    ? meta.chip
    : tone === "signal"
      ? "bg-signal-soft text-signal-text"
      : "bg-raised text-muted";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[11px] font-medium leading-none",
        classes,
        className,
      )}
      {...props}
    >
      {dot && (
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            meta?.dot ?? "bg-muted",
          )}
        />
      )}
      {children ?? meta?.label}
    </span>
  );
}
