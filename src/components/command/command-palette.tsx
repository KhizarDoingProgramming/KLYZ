"use client";

import * as React from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CornerDownLeft,
  Moon,
  Plus,
  Search,
  Sun,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { Glyph } from "@/components/icons";
import { Kbd } from "@/components/ui/kbd";
import { DEMO_WORKFLOWS } from "@/lib/demo/workflows";
import { DEFINITIONS_BY_CATEGORY } from "@/lib/workflow/registry";
import { fuzzyMatch, highlightParts } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { useClientValue } from "@/lib/react";

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  keywords?: string;
  run: () => void;
}

interface ScoredCommand {
  command: Command;
  score: number;
  indices: number[];
}

const PALETTE_EVENT = "klyz:palette";

function readDomTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT));
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const clientTheme = useClientValue<"dark" | "light">("dark", readDomTheme);
  const [themeOverride, setThemeOverride] = React.useState<"dark" | "light" | null>(null);
  const theme = themeOverride ?? clientTheme;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  /* Reset selection when the palette opens or the query changes — done
     during render so no state is set inside an effect. */
  const [prevOpen, setPrevOpen] = React.useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQuery("");
      setActive(0);
    }
  }
  const [prevQuery, setPrevQuery] = React.useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setActive(0);
  }

  React.useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(PALETTE_EVENT, onOpen);
    return () => window.removeEventListener(PALETTE_EVENT, onOpen);
  }, []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const commands = React.useMemo<Command[]>(() => {
    const go = (href: string) => () => {
      setOpen(false);
      router.push(href);
    };

    const list: Command[] = [
      { id: "nav_dash", group: "Navigate", label: "Dashboard", icon: <Glyph name="dashboard" className="h-4 w-4" />, run: go("/dashboard") },
      { id: "nav_flow", group: "Navigate", label: "Workflows", icon: <Glyph name="workflow" className="h-4 w-4" />, run: go("/workflows") },
      { id: "nav_runs", group: "Navigate", label: "Executions", icon: <Glyph name="runs" className="h-4 w-4" />, run: go("/executions") },
      { id: "nav_ai", group: "Navigate", label: "AI builder", icon: <Glyph name="network" className="h-4 w-4" />, run: go("/ai"), keywords: "generate plan natural language describe" },
      { id: "nav_int", group: "Navigate", label: "Integrations", icon: <Glyph name="integrations" className="h-4 w-4" />, run: go("/integrations") },
      { id: "nav_set", group: "Navigate", label: "Settings", icon: <Glyph name="settings" className="h-4 w-4" />, run: go("/settings") },

      {
        id: "act_new",
        group: "Actions",
        label: "New workflow",
        hint: "N",
        icon: <Plus className="h-4 w-4" />,
        keywords: "create build automation",
        run: () => {
          setOpen(false);
          router.push("/workflows?new=1");
        },
      },
      {
        id: "act_theme",
        group: "Actions",
        label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        icon: theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />,
        run: () => {
          const next = theme === "dark" ? "light" : "dark";
          document.documentElement.setAttribute("data-theme", next);
          try {
            localStorage.setItem("klyz.theme", next);
          } catch {
            /* ignore */
          }
          setThemeOverride(next);
        },
      },
      {
        id: "act_docs",
        group: "Actions",
        label: "Keyboard shortcuts",
        hint: "?",
        icon: <Kbd>?</Kbd>,
        run: () => {
          setOpen(false);
          window.dispatchEvent(new CustomEvent("klyz:shortcuts"));
        },
      },
    ];

    for (const workflow of DEMO_WORKFLOWS) {
      list.push({
        id: `wf_${workflow.id}`,
        group: "Workflows",
        label: workflow.name,
        hint: workflow.status,
        icon: <WorkflowIcon className="h-4 w-4" />,
        keywords: `${workflow.description} ${workflow.tags.join(" ")}`,
        run: go(`/workflows/${workflow.id}`),
      });
      list.push({
        id: `run_${workflow.id}`,
        group: "Run",
        label: `Run ${workflow.name}`,
        icon: <ArrowRight className="h-4 w-4" />,
        keywords: "execute start play test",
        run: () => {
          setOpen(false);
          router.push(`/workflows/${workflow.id}?run=1`);
        },
      });
    }

    for (const { category, definitions } of DEFINITIONS_BY_CATEGORY) {
      for (const definition of definitions) {
        list.push({
          id: `node_${definition.type}`,
          group: `${category[0]!.toUpperCase()}${category.slice(1)} nodes`,
          label: definition.title,
          hint: definition.summary,
          icon: <Glyph name={definition.icon} className="h-4 w-4" />,
          keywords: `${definition.description} ${definition.tags?.join(" ") ?? ""}`,
          run: go("/workflows"),
        });
      }
    }

    return list;
  }, [router, theme]);

  const results = React.useMemo<ScoredCommand[]>(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      return commands
        .filter((command) => ["nav_dash", "nav_flow", "nav_runs", "act_new", "act_theme"].includes(command.id) ||
          command.group === "Workflows")
        .slice(0, 10)
        .map((command) => ({ command, score: 0, indices: [] }));
    }
    const scored: ScoredCommand[] = [];
    for (const command of commands) {
      const haystack = `${command.label} ${command.keywords ?? ""} ${command.hint ?? ""}`;
      const match = fuzzyMatch(trimmed, haystack);
      if (!match) continue;
      const labelMatch = fuzzyMatch(trimmed, command.label);
      scored.push({
        command,
        score: match.score + (labelMatch ? labelMatch.score : 0),
        indices: labelMatch?.indices ?? [],
      });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 12);
  }, [commands, query]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => Math.min(index + 1, results.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const selected = results[active];
        if (selected) selected.command.run();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, results, active]);

  React.useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-70 flex items-start justify-center px-4 pt-[12vh]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={MOTION.micro}
          >
            <button
              type="button"
              aria-label="Close command palette"
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="kz-scrim absolute inset-0"
            />

            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="Command palette"
              initial={{ opacity: 0, y: -10, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.99 }}
              transition={MOTION.standard}
              className="relative w-full max-w-[620px] overflow-hidden rounded-xl border border-line bg-overlay shadow-lg"
            >
              <div className="flex items-center gap-3 border-b border-edge px-4">
                <Search className="h-4 w-4 shrink-0 text-subtle" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search workflows, nodes and commands…"
                  aria-label="Search commands"
                  className="h-12 w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-subtle"
                />
                <Kbd className="shrink-0">ESC</Kbd>
              </div>

              <div
                ref={listRef}
                role="listbox"
                aria-label="Command results"
                className="max-h-[52vh] overflow-y-auto p-1.5"
              >
                {results.length === 0 && (
                  <div className="px-3 py-8 text-center text-[13px] text-subtle">
                    No matches for “{query}”.
                  </div>
                )}

                {results.map((result, index) => {
                  const groupChanged =
                    index === 0 ||
                    results[index - 1]!.command.group !== result.command.group;
                  const isActive = index === active;
                  return (
                    <React.Fragment key={result.command.id}>
                      {groupChanged && (
                        <div className="kz-eyebrow px-2.5 pb-1 pt-3">
                          {result.command.group}
                        </div>
                      )}
                      <button
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        data-index={index}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => result.command.run()}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-micro",
                          isActive ? "bg-raised" : "transparent",
                        )}
                      >
                        <span
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-edge bg-surface transition-colors",
                            isActive && "border-signal/40 text-signal-text",
                            !isActive && "text-subtle",
                          )}
                        >
                          {result.command.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-fg">
                            {highlightParts(result.command.label, result.indices).map(
                              (part, partIndex) => (
                                <span
                                  key={partIndex}
                                  className={part.match ? "font-medium text-signal-text" : ""}
                                >
                                  {part.text}
                                </span>
                              ),
                            )}
                          </span>
                          {result.command.hint && (
                            <span className="block truncate text-[11px] text-subtle">
                              {result.command.hint}
                            </span>
                          )}
                        </span>
                        {isActive && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-subtle" />}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>

              <div className="flex items-center gap-4 border-t border-edge px-4 py-2 text-[11px] text-subtle">
                <span className="flex items-center gap-1.5">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> navigate
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd>↵</Kbd> open
                </span>
                <span className="ml-auto">KLYZ command palette</span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}

