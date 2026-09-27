"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Json = unknown;

/* One node can hold thousands of rows; rendering them all at once is
   how a data viewer turns into a frozen tab. Children render in pages. */
const CHILD_LIMIT = 100;

function isPlainObject(value: Json): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function Scalar({ value }: { value: Json }) {
  if (value === null) return <span className="text-subtle">null</span>;
  if (value === undefined) return <span className="text-subtle">undefined</span>;
  if (typeof value === "string")
    return <span className="break-all text-ok">&quot;{value}&quot;</span>;
  if (typeof value === "number") return <span className="text-info">{value}</span>;
  if (typeof value === "boolean") return <span className="text-warn">{String(value)}</span>;
  return <span className="text-muted">{JSON.stringify(value)}</span>;
}

function Entry({
  label,
  value,
  depth,
  isLast,
  defaultOpen,
  forceOpen,
  maxChildren,
}: {
  label?: string;
  value: Json;
  depth: number;
  isLast: boolean;
  defaultOpen: boolean;
  forceOpen?: boolean;
  maxChildren?: number;
}) {
  const [open, setOpen] = React.useState(forceOpen === true || defaultOpen);
  const [limit, setLimit] = React.useState(maxChildren ?? CHILD_LIMIT);
  const branch = isPlainObject(value) || Array.isArray(value);
  const entries: Array<[string, Json]> = branch
    ? Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as [string, Json])
      : Object.entries(value)
    : [];
  const count = entries.length;

  return (
    <div>
      <div className="flex items-start gap-1 py-[1px]">
        {branch ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Collapse" : "Expand"}
            className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-subtle transition-colors hover:bg-raised hover:text-muted"
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform duration-micro", open && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {label !== undefined && (
          <span className="shrink-0 font-mono text-[11.5px] text-muted">
            {label}
            <span className="text-disabled">:</span>{" "}
          </span>
        )}

        {branch ? (
          <span className="font-mono text-[11.5px] text-subtle">
            {Array.isArray(value) ? "[" : "{"}
            {!open && (
              <>
                <span className="text-subtle">
                  {" "}
                  {count} {Array.isArray(value) ? (count === 1 ? "item" : "items") : count === 1 ? "key" : "keys"}{" "}
                </span>
                {Array.isArray(value) ? "]" : "}"}
              </>
            )}
          </span>
        ) : (
          <span className="font-mono text-[11.5px]">
            <Scalar value={value} />
            {!isLast && <span className="text-disabled">,</span>}
          </span>
        )}
      </div>

      {branch && open && (
        <div className="ml-4 border-l border-hairline pl-2">
          {entries.slice(0, limit).map(([key, item], index) => (
            <Entry
              key={key}
              label={key}
              value={item}
              depth={depth + 1}
              isLast={index === Math.min(count, limit) - 1}
              defaultOpen={depth < 1}
              forceOpen={forceOpen}
              maxChildren={maxChildren}
            />
          ))}
          {count > limit && (
            <button
              type="button"
              onClick={() => setLimit((value) => value + CHILD_LIMIT)}
              className="mt-1 rounded-sm border border-edge bg-raised px-2 py-1 font-mono text-[10.5px] text-muted transition-colors hover:text-fg"
            >
              Show {Math.min(CHILD_LIMIT, count - limit)} more of {count}
            </button>
          )}
          <div className="py-[1px] font-mono text-[11.5px] text-subtle">
            {Array.isArray(value) ? "]" : "}"}
          </div>
        </div>
      )}
    </div>
  );
}

export function JsonView({
  value,
  forceOpen,
  revision,
}: {
  value: Json;
  /** Expand every branch regardless of depth (expand-all control). */
  forceOpen?: boolean;
  /** Bumped by the parent to reset expansion state. */
  revision?: number;
}) {
  if (value === undefined || value === null) {
    return <p className="px-3 py-4 text-center text-[12px] text-subtle">No data</p>;
  }

  if (!isPlainObject(value) && !Array.isArray(value)) {
    return (
      <div className="px-3 py-3 font-mono text-[11.5px]">
        <Scalar value={value} />
      </div>
    );
  }

  return (
    <div className="overflow-x-auto px-3 py-2.5">
      <Entry
        key={revision}
        value={value}
        depth={0}
        isLast
        defaultOpen
        forceOpen={forceOpen}
      />
    </div>
  );
}
