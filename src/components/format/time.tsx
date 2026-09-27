"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { timeAgo, formatDuration } from "@/lib/utils";
import { useMounted } from "@/lib/react";

/**
 * Relative times are computed on the client so server and browser output
 * never disagree by a second. `suppressHydrationWarning` keeps the very
 * first paint silent while the value settles.
 */
/**
 * One shared minute-tick for every `TimeAgo` on the page — a single interval
 * instead of one per instance (dashboards can mount dozens of them).
 */
const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;

function subscribeMinuteTick(force: () => void): () => void {
  minuteListeners.add(force);
  if (minuteTimer === null) {
    minuteTimer = setInterval(() => {
      minuteListeners.forEach((listener) => listener());
    }, 60_000);
  }
  return () => {
    minuteListeners.delete(force);
    if (minuteListeners.size === 0 && minuteTimer !== null) {
      clearInterval(minuteTimer);
      minuteTimer = null;
    }
  };
}

export function TimeAgo({
  iso,
  className,
  prefix,
}: {
  iso: string | null;
  className?: string;
  prefix?: string;
}) {
  const [, force] = React.useReducer((count: number) => count + 1, 0);
  const mounted = useMounted();

  React.useEffect(() => subscribeMinuteTick(force), [force]);

  const text = !iso
    ? "Never"
    : !mounted
      ? "—"
      : `${prefix ? `${prefix} ` : ""}${timeAgo(iso)}`;

  return (
    <time
      dateTime={iso ?? undefined}
      suppressHydrationWarning
      title={iso ? new Date(iso).toLocaleString() : undefined}
      className={className}
    >
      {text}
    </time>
  );
}

export function Duration({
  ms,
  className,
}: {
  ms: number;
  className?: string;
}) {
  return <span className={cn("kz-num", className)}>{formatDuration(ms)}</span>;
}
