"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** Copies a value as pretty-printed JSON, with a brief check state. */
export function CopyButton({ value, label = "Copy as JSON" }: { value: unknown; label?: string }) {
  const [done, setDone] = React.useState(false);

  React.useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(timer);
  }, [done]);

  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
          setDone(true);
        } catch {
          /* clipboard unavailable — fail quietly */
        }
      }}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-sm transition-colors",
        done ? "text-ok" : "text-subtle hover:bg-raised hover:text-muted",
      )}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
