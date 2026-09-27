"use client";

import * as React from "react";
import { Braces, Search } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { getDefinition } from "@/lib/workflow/registry";
import { outputPaths, sampleValueFor } from "@/lib/execution/io";
import { fuzzyMatch } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

interface Reference {
  path: string;
  ref: string;
  label: string;
  sample: string;
}

export function DataPicker({
  excludeNodeId,
  onSelect,
  label = "Insert a reference",
}: {
  excludeNodeId?: string;
  onSelect: (expression: string) => void;
  label?: string;
}) {
  const nodes = useEditorStore((state) => state.nodes);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const references = React.useMemo(() => {
    const list: Reference[] = [];
    for (const node of nodes) {
      if (node.id === excludeNodeId) continue;
      const definition = getDefinition(node.type);
      if (!definition) continue;
      const ref = node.data.ref;
      for (const output of outputPaths(definition.outputs)) {
        list.push({
          path: `${ref}.${output}`,
          ref,
          label: `${definition.title} · ${output}`,
          sample: sampleValueFor(output),
        });
      }
    }
    return list;
  }, [nodes, excludeNodeId]);

  const filtered = React.useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return references;
    return references.filter(
      (reference) =>
        fuzzyMatch(trimmed, reference.path) !== null ||
        fuzzyMatch(trimmed, reference.label) !== null,
    );
  }, [references, query]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, Reference[]>();
    for (const reference of filtered) {
      const bucket = map.get(reference.ref);
      if (bucket) bucket.push(reference);
      else map.set(reference.ref, [reference]);
    }
    return [...map.entries()];
  }, [filtered]);

  const [prevOpen, setPrevOpen] = React.useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setQuery("");
  }

  React.useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors",
          open
            ? "border-signal/60 bg-signal-soft text-signal-text"
            : "border-line bg-inset text-subtle hover:border-strong hover:text-muted",
        )}
      >
        <Braces className="h-3.5 w-3.5" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-20"
            onMouseDown={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 top-full z-30 mt-1.5 w-[330px] overflow-hidden rounded-lg border border-edge bg-panel shadow-lg">
            <div className="flex items-center gap-2 border-b border-edge px-3">
              <Search className="h-3.5 w-3.5 shrink-0 text-subtle" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setOpen(false);
                  }
                }}
                placeholder="Search available data…"
                aria-label="Search references"
                className="h-9 min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-subtle"
              />
            </div>

            <div className="max-h-[268px] overflow-y-auto overscroll-contain p-1.5">
              {grouped.length === 0 && (
                <p className="px-3 py-6 text-center text-[12px] text-subtle">
                  No upstream data yet. Add a step before this one.
                </p>
              )}

              {grouped.map(([ref, items]) => {
                const node = nodes.find((item) => item.data.ref === ref);
                const definition = node ? getDefinition(node.type) : undefined;
                return (
                  <div key={ref} className="mb-1 last:mb-0">
                    <div className="flex items-center gap-2 px-2 pb-1 pt-1.5">
                      <span className="kz-eyebrow text-[9.5px]">
                        {definition?.title ?? ref}
                      </span>
                      <span className="h-px flex-1 bg-hairline" />
                    </div>
                    {items.map((reference) => (
                      <button
                        key={reference.path}
                        type="button"
                        onClick={() => {
                          onSelect(`{{${reference.path}}}`);
                          setOpen(false);
                        }}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-raised"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
                          {reference.path}
                        </span>
                        <span className="kz-num shrink-0 max-w-[96px] truncate text-[10.5px] text-subtle">
                          {reference.sample}
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Renders a compact preview of what an expression resolves to. */
export function ExpressionPreview({ value }: { value: string }) {
  const matches = value.match(/\{\{([^}]+)\}\}/g);
  if (!matches) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {matches.map((match) => (
        <span
          key={match}
          className="rounded-sm border border-edge bg-raised px-1.5 py-[2px] font-mono text-[10px] text-subtle"
        >
          {match}
        </span>
      ))}
    </span>
  );
}
