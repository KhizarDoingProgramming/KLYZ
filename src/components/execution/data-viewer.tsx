"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { JsonView } from "@/components/workflow/execution/json-view";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

/**
 * Payload viewer for the debugger.
 *
 * Wraps the JSON tree with the three things an operator actually needs
 * when a step's output is 40 MB of rows: a way to find a key, a way to
 * open or close everything, and the raw value on the clipboard.
 */

type Json = unknown;

function matchesDeep(value: Json, needle: string, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") return value.toLowerCase().includes(needle);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase().includes(needle);
  }
  if (Array.isArray(value)) return value.some((item) => matchesDeep(item, needle, depth + 1));
  return Object.entries(value as Record<string, Json>).some(([key, item]) =>
    key.toLowerCase().includes(needle) || matchesDeep(item, needle, depth + 1),
  );
}

function countMatches(value: Json, needle: string, depth = 0): number {
  if (depth > 8 || value === null || value === undefined) return 0;
  if (typeof value === "string") return value.toLowerCase().includes(needle) ? 1 : 0;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase().includes(needle) ? 1 : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + countMatches(item, needle, depth + 1), 0);
  }
  return Object.entries(value as Record<string, Json>).reduce<number>(
    (total, [key, item]) =>
      total +
      (key.toLowerCase().includes(needle) ? 1 : 0) +
      countMatches(item, needle, depth + 1),
    0,
  );
}

function filterValue(value: Json, needle: string, depth = 0): Json {
  if (depth > 8) return value;
  if (Array.isArray(value)) {
    return value.filter((item) => matchesDeep(item, needle, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value as Record<string, Json>)) {
      if (key.toLowerCase().includes(needle) || matchesDeep(item, needle, depth + 1)) {
        out[key] = filterValue(item, needle, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function isTruncated(value: Json): { bytes: number; preview: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, Json>;
  if (record.__truncated !== true) return null;
  return {
    bytes: typeof record.bytes === "number" ? record.bytes : 0,
    preview: typeof record.preview === "string" ? record.preview : "",
  };
}

export function DataViewer({
  value,
  resetKey,
  emptyLabel = "No data",
  maxHeight = "max-h-[420px]",
}: {
  value: Json;
  /** Identity of the payload (step + tab): search state resets when it changes, not on every live tick. */
  resetKey?: string;
  emptyLabel?: string;
  maxHeight?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const [revision, setRevision] = React.useState(0);

  /* Reset while rendering (React re-renders before committing) instead of
     from an effect, so a payload switch never flashes stale search state. */
  const [seenResetKey, setSeenResetKey] = React.useState(resetKey);
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey);
    setQuery("");
    setExpanded(false);
    setRevision((value) => value + 1);
  }

  const needle = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    if (!needle || value === null || value === undefined) return value;
    return matchesDeep(value, needle) ? filterValue(value, needle) : value;
  }, [value, needle]);

  const matches = React.useMemo(
    () => (needle ? countMatches(value, needle) : 0),
    [value, needle],
  );

  const truncated = isTruncated(value);

  if (value === undefined || value === null) {
    return <p className="px-3 py-4 text-center text-[12px] text-subtle">{emptyLabel}</p>;
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-edge px-2 py-1.5">
        <span className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a key or value…"
            aria-label="Search payload"
            className="h-7 w-full rounded-sm border border-line bg-inset pl-7 pr-2 text-[11.5px] text-fg placeholder:text-subtle transition-colors focus:border-signal/60 focus:outline-none"
          />
        </span>

        <button
          type="button"
          aria-label={expanded ? "Collapse all" : "Expand all"}
          onClick={() => {
            setExpanded((value) => !value);
            setRevision((value) => value + 1);
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-line text-subtle transition-colors hover:text-fg"
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        <span className="shrink-0">
          <CopyButton value={value} />
        </span>
      </div>

      {needle && (
        <p className="kz-eyebrow border-b border-edge px-3 py-1.5 text-[9px] text-subtle">
          {matches > 0 ? `${matches} match${matches === 1 ? "" : "es"}` : "No matches"} for “{query}”
        </p>
      )}

      {truncated && (
        <p className="border-b border-warn/40 bg-warn-soft px-3 py-2 text-[11.5px] leading-relaxed text-muted">
          <span className="text-warn">Truncated. </span>
          {truncated.bytes.toLocaleString()} characters were recorded; only a preview is stored.
        </p>
      )}

      <div className={cn("overflow-auto", maxHeight)}>
        <JsonView value={filtered} forceOpen={expanded} revision={revision} />
      </div>
    </div>
  );
}
