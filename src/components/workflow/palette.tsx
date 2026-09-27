"use client";

import * as React from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { Glyph } from "@/components/icons";
import { useEditorStore } from "@/stores/editor";
import { DEFINITIONS_BY_CATEGORY } from "@/lib/workflow/registry";
import { CATEGORY_LABEL, CATEGORY_STYLE } from "@/lib/workflow/category";
import type { NodeCategory, NodeDefinition } from "@/lib/workflow/types";
import { fuzzyMatch, highlightParts } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

interface ScoredDefinition {
  definition: NodeDefinition;
  indices: number[];
  score: number;
  /** Position in the flattened, keyboard-navigable result list. */
  index: number;
}

function scoreDefinition(query: string, definition: NodeDefinition): number | null {
  const title = fuzzyMatch(query, definition.title);
  const summary = fuzzyMatch(query, definition.summary);
  const tags = (definition.tags ?? [])
    .map((tag) => fuzzyMatch(query, tag))
    .filter((match): match is NonNullable<typeof match> => match !== null);

  const best = [title, summary, ...tags].filter(
    (match): match is NonNullable<typeof match> => match !== null,
  );
  if (best.length === 0) return null;
  return Math.max(...best.map((match) => match.score));
}

function Highlight({ label, indices }: { label: string; indices: number[] }) {
  const parts = highlightParts(label, indices);
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <span key={index} className="text-fg">
            {part.text}
          </span>
        ) : (
          <span key={index} className="text-muted">
            {part.text}
          </span>
        ),
      )}
    </>
  );
}

export function NodePalette() {
  const open = useEditorStore((state) => state.paletteOpen);
  const query = useEditorStore((state) => state.paletteQuery);
  const setQuery = useEditorStore((state) => state.setPaletteQuery);
  const setOpen = useEditorStore((state) => state.setPaletteOpen);
  const addNode = useEditorStore((state) => state.addNode);

  const [active, setActive] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const optionRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const trimmed = query.trim();

  const results = React.useMemo<ScoredDefinition[]>(() => {
    const list: ScoredDefinition[] = [];
    for (const group of DEFINITIONS_BY_CATEGORY) {
      const scored = group.definitions
        .map<ScoredDefinition | null>((definition) => {
          if (!trimmed) {
            return { definition, indices: [], score: 0, index: 0 };
          }
          const score = scoreDefinition(trimmed, definition);
          if (score === null) return null;
          const match = fuzzyMatch(trimmed, definition.title);
          return {
            definition,
            indices: match?.indices ?? [],
            score,
            index: 0,
          };
        })
        .filter((item): item is ScoredDefinition => item !== null)
        .sort((a, b) => b.score - a.score);

      for (const item of scored) {
        list.push({ ...item, index: list.length });
      }
    }
    return list;
  }, [trimmed]);

  const groups = React.useMemo(() => {
    const map = new Map<NodeCategory, ScoredDefinition[]>();
    for (const item of results) {
      const bucket = map.get(item.definition.category);
      if (bucket) bucket.push(item);
      else map.set(item.definition.category, [item]);
    }
    return [...map.entries()].map(([category, items]) => ({ category, items }));
  }, [results]);

  /* Reset the highlight when the palette opens — during render, not in an
     effect, so React never schedules an extra pass just to clear it. */
  const [prevOpen, setPrevOpen] = React.useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setActive(0);
  }

  React.useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  React.useEffect(() => {
    const node = optionRefs.current[active];
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const insert = (type: string) => {
    addNode(type);
    setQuery("");
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index + 1) % Math.max(results.length, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(
        (index) => (index - 1 + results.length) % Math.max(results.length, 1),
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = results[active];
      if (target) insert(target.definition.type);
    }
  };

  return (
    <div
      className={cn(
        "absolute inset-0 z-60 flex items-start justify-center bg-app/50 px-4 pt-[10vh] backdrop-blur-[2px]",
        dragging && "pointer-events-none",
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
      role="presentation"
    >
      <div className="pointer-events-auto w-full max-w-[640px] overflow-hidden rounded-lg border border-edge bg-panel shadow-lg">
        {/* search ---------------------------------------------------- */}
        <div className="flex items-center gap-3 border-b border-edge px-4">
          <Search className="h-4 w-4 shrink-0 text-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search triggers, actions, logic, data…"
            aria-label="Search nodes"
            aria-controls="klyz-node-list"
            aria-activedescendant={results[active] ? `klyz-opt-${active}` : undefined}
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            className="h-12 min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-subtle"
          />
          <kbd className="kz-eyebrow hidden shrink-0 rounded border border-edge bg-raised px-1.5 py-0.5 text-[9.5px] text-subtle sm:block">
            Esc
          </kbd>
        </div>

        {/* results --------------------------------------------------- */}
        <div
          id="klyz-node-list"
          role="listbox"
          aria-label="Node results"
          className="max-h-[46vh] overflow-y-auto overscroll-contain p-2"
        >
          {results.length === 0 && (
            <div className="px-3 py-10 text-center">
              <p className="text-[13px] text-muted">No building blocks match “{trimmed}”.</p>
              <p className="mt-1 text-[12px] text-subtle">
                Try “slack”, “condition”, “loop”, or “webhook”.
              </p>
            </div>
          )}

          {groups.map((group) => {
            const style = CATEGORY_STYLE[group.category];
            return (
              <div key={group.category} className="mb-1.5 last:mb-0">
                <div className="flex items-center gap-2 px-2.5 pb-1 pt-2">
                  <span className={cn("h-1.5 w-1.5 rounded-full", style.dot)} />
                  <span className="kz-eyebrow text-[9.5px]">
                    {CATEGORY_LABEL[group.category]}
                  </span>
                  <span className="h-px flex-1 bg-hairline" />
                </div>

                {group.items.map((item) => {
                  const index = item.index;
                  const definition = item.definition;
                  const isActive = index === active;
                  const itemStyle = CATEGORY_STYLE[definition.category];

                  return (
                    <button
                      key={definition.type}
                      id={`klyz-opt-${index}`}
                      ref={(node) => {
                        optionRefs.current[index] = node;
                      }}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      tabIndex={-1}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          "application/klyz-node",
                          definition.type,
                        );
                        event.dataTransfer.effectAllowed = "move";
                        setDragging(true);
                      }}
                      onDragEnd={() => setDragging(false)}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => insert(definition.type)}
                      className={cn(
                        "group flex w-full items-center gap-3 rounded-sm px-2.5 py-2 text-left transition-colors",
                        isActive ? "bg-raised" : "hover:bg-raised/60",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-edge",
                          itemStyle.chip,
                          itemStyle.text,
                        )}
                      >
                        <Glyph name={definition.icon} className="h-4 w-4" />
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="kz-display block truncate text-[13px] font-semibold leading-snug">
                          <Highlight label={definition.title} indices={item.indices} />
                        </span>
                        <span className="mt-0.5 block truncate text-[11.5px] leading-snug text-subtle">
                          {definition.summary}
                        </span>
                      </span>

                      {definition.credentials && (
                        <span className="kz-eyebrow hidden shrink-0 rounded border border-edge px-1.5 py-0.5 text-[9px] sm:block">
                          Auth
                        </span>
                      )}

                      {isActive && (
                        <span className="flex shrink-0 items-center gap-1 rounded border border-edge bg-panel px-1.5 py-1 text-subtle">
                          <CornerDownLeft className="h-3 w-3" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* footer ---------------------------------------------------- */}
        <div className="flex items-center justify-between border-t border-edge px-4 py-2.5">
          <span className="text-[11px] text-subtle">
            Drag onto the canvas to place it anywhere
          </span>
          <span className="flex items-center gap-2 text-[11px] text-subtle">
            <kbd className="kz-eyebrow rounded border border-edge bg-raised px-1.5 py-0.5 text-[9.5px]">
              ↑↓
            </kbd>
            navigate
            <kbd className="kz-eyebrow rounded border border-edge bg-raised px-1.5 py-0.5 text-[9.5px]">
              ⏎
            </kbd>
            insert
          </span>
        </div>
      </div>
    </div>
  );
}
