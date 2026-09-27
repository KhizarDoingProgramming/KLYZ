import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The KLYZ mark: a stem (the event) that splits into two paths (the
 * branches of a workflow). It reads as a K and as automation at once.
 */
export function KlyzMark({
  className,
  accent = "var(--kz-signal)",
}: {
  className?: string;
  accent?: string;
}) {
  return (
    <svg
      viewBox="0 0 26 28"
      className={cn("h-6 w-6", className)}
      fill="none"
      aria-hidden
    >
      <path
        d="M6.5 5.2V22.8"
        stroke="currentColor"
        strokeWidth="2.7"
        strokeLinecap="round"
      />
      <path
        d="M6.5 14C11.2 14 12.4 5.2 19.8 5.2"
        stroke={accent}
        strokeWidth="2.7"
        strokeLinecap="round"
      />
      <path
        d="M6.5 14C11.2 14 12.4 22.8 19.8 22.8"
        stroke={accent}
        strokeWidth="2.7"
        strokeLinecap="round"
      />
      <circle cx="6.5" cy="14" r="3.3" fill={accent} />
      <circle cx="20.6" cy="5.2" r="2.2" fill="currentColor" />
      <circle cx="20.6" cy="22.8" r="2.2" fill="currentColor" />
    </svg>
  );
}

function KlyzWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "text-[15px] font-semibold leading-none tracking-[0.16em] text-fg",
        className,
      )}
    >
      KLYZ
    </span>
  );
}

export function KlyzLogo({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <KlyzMark className="h-[26px] w-[26px] shrink-0 text-fg" />
      {!compact && <KlyzWordmark />}
    </span>
  );
}
