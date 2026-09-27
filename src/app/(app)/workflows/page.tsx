"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpDown,
  ChevronDown,
  Copy,
  FileJson,
  Layers,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/feedback";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { Segmented, Select } from "@/components/ui/field";
import { Glyph } from "@/components/icons";
import { TimeAgo, Duration } from "@/components/format/time";
import { openImportDialog } from "@/components/workflow/import-dialog";
import { exportWorkflow, saveWorkflowAsTemplate } from "@/lib/workflows/api";
import { useWorkflowsStore } from "@/stores/workflows";
import { getDefinition } from "@/lib/workflow/registry";
import { CATEGORY_STYLE } from "@/lib/workflow/category";
import { cn } from "@/lib/utils";
import type { Workflow, WorkflowStatus } from "@/lib/workflow/types";

type StatusFilter = "all" | WorkflowStatus;
type SortKey = "recent" | "name" | "runs" | "success";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "paused", label: "Paused" },
  { value: "disabled", label: "Disabled" },
];

const SORTS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recently run" },
  { value: "name", label: "Name" },
  { value: "runs", label: "Most runs" },
  { value: "success", label: "Success rate" },
];

const GRID = "md:grid-cols-[minmax(0,1fr)_84px_84px_104px_112px_40px]";

export default function WorkflowsPage() {
  const router = useRouter();
  const workflows = useWorkflowsStore((state) => state.workflows);
  const ready = useWorkflowsStore((state) => state.ready);
  const storeError = useWorkflowsStore((state) => state.error);
  const init = useWorkflowsStore((state) => state.init);
  const setStatus = useWorkflowsStore((state) => state.setStatus);
  const duplicate = useWorkflowsStore((state) => state.duplicate);
  const remove = useWorkflowsStore((state) => state.remove);
  const create = useWorkflowsStore((state) => state.create);

  const [query, setQuery] = React.useState("");
  const [status, setStatusFilter] = React.useState<StatusFilter>("all");
  const [sort, setSort] = React.useState<SortKey>("recent");
  const [actionError, setActionError] = React.useState<string | null>(null);

  const run = React.useCallback((task: () => Promise<unknown>) => {
    void task().catch((cause: unknown) => {
      setActionError(cause instanceof Error ? cause.message : "That action failed.");
    });
  }, []);

  const startNew = React.useCallback(async () => {
    try {
      const id = await create();
      setActionError(null);
      router.push(`/workflows/${id}`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not create a workflow.");
    }
  }, [create, router]);

  React.useEffect(() => {
    void init();
  }, [init]);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") !== "1") return;
    params.delete("new");
    const next = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${next ? `?${next}` : ""}`,
    );
    const timer = window.setTimeout(() => void startNew(), 0);
    return () => window.clearTimeout(timer);
  }, [startNew]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    let list = workflows.filter((workflow) => {
      if (status !== "all" && workflow.status !== status) return false;
      if (!needle) return true;
      return (
        workflow.name.toLowerCase().includes(needle) ||
        workflow.description.toLowerCase().includes(needle) ||
        workflow.tags.some((tag) => tag.includes(needle))
      );
    });

    list = [...list].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "runs") return b.executionCount - a.executionCount;
      if (sort === "success") return b.successRate - a.successRate;
      const aTime = a.lastExecutedAt ? Date.parse(a.lastExecutedAt) : 0;
      const bTime = b.lastExecutedAt ? Date.parse(b.lastExecutedAt) : 0;
      return bTime - aTime;
    });
    return list;
  }, [workflows, query, status, sort]);

  const filtersActive = query.trim().length > 0 || status !== "all";

  return (
    <div className="h-full overflow-y-auto">
      <div className="kz-frame py-8 lg:py-12">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="kz-eyebrow mb-2.5">Automations</p>
            <h1 className="text-page text-fg">Workflows</h1>
            <p className="mt-1.5 text-sm text-muted">
              {workflows.length} definitions ·{" "}
              {workflows.filter((workflow) => workflow.status === "active").length}{" "}
              active
            </p>
          </div>
          <Menu
            label="New workflow"
            align="end"
            items={[
              {
                id: "blank",
                label: "Blank workflow",
                icon: <Plus className="h-3.5 w-3.5" />,
                onSelect: () => void startNew(),
              },
              {
                id: "template",
                label: "From a template",
                icon: <Layers className="h-3.5 w-3.5" />,
                onSelect: () => router.push("/templates"),
              },
              {
                id: "import",
                label: "Import a file…",
                icon: <Upload className="h-3.5 w-3.5" />,
                onSelect: openImportDialog,
              },
            ]}
            trigger={(props) => (
              <Button {...props} variant="primary">
                <Plus className="h-4 w-4" />
                New workflow
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            )}
          />
        </header>

        {storeError || actionError ? (
          <p
            role="status"
            className="mt-5 rounded-md border border-line bg-raised px-3 py-2 text-[12.5px] leading-relaxed text-danger"
          >
            {storeError ?? actionError}
          </p>
        ) : null}

        {/* toolbar ------------------------------------------------- */}
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1 sm:max-w-[320px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search workflows…"
              aria-label="Search workflows"
              className="h-8 w-full rounded-md border border-line bg-surface pl-8 pr-8 text-[13px] text-fg outline-none transition-colors placeholder:text-subtle focus:border-signal/60 focus:ring-2 focus:ring-signal/20"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle hover:text-fg"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <Segmented
            ariaLabel="Filter by status"
            stretch={false}
            value={status}
            onChange={(next) => setStatusFilter(next as StatusFilter)}
            options={STATUS_FILTERS}
          />

          <label className="ml-auto inline-flex items-center gap-2 text-[12px] text-subtle">
            <ArrowUpDown className="h-3.5 w-3.5" />
            <span className="sr-only">Sort by</span>
            <Select
              aria-label="Sort workflows"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
        </div>

        {/* list ---------------------------------------------------- */}
        <div className="mt-6 border-t border-line">
          <div
            className={cn(
              "hidden gap-4 border-b border-edge py-2.5 md:grid",
              GRID,
            )}
          >
            <span className="kz-eyebrow">Workflow</span>
            <span className="kz-eyebrow text-right">Runs</span>
            <span className="kz-eyebrow text-right">Success</span>
            <span className="kz-eyebrow text-right">Last run</span>
            <span className="kz-eyebrow text-right">Status</span>
            <span className="sr-only">Actions</span>
          </div>

          {!ready ? (
            <div className="divide-y divide-hairline">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="flex items-center gap-3 py-4">
                  <div className="h-7 w-7 animate-pulse rounded-sm bg-raised" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-44 animate-pulse rounded bg-raised" />
                    <div className="h-2.5 w-72 max-w-full animate-pulse rounded bg-raised" />
                  </div>
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            filtersActive ? (
              <EmptyState
                title="No workflows match"
                description="Try a different search term or clear the filters to see everything in this workspace."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQuery("");
                      setStatusFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No workflows yet"
                description="Create your first automation, start from a template, or bring one over from another workspace."
                action={
                  <span className="flex gap-2">
                    <Button variant="primary" onClick={() => void startNew()}>
                      <Plus className="h-4 w-4" />
                      Create workflow
                    </Button>
                    <Button variant="secondary" onClick={openImportDialog}>
                      <FileJson className="h-4 w-4" />
                      Import
                    </Button>
                  </span>
                }
              />
            )
          ) : (
            <ul>
              {visible.map((workflow) => (
                <WorkflowRow
                  key={workflow.id}
                  workflow={workflow}
                  onToggleStatus={() => {
                    setActionError(null);
                    run(() =>
                      setStatus(workflow.id, workflow.status === "active" ? "paused" : "active"),
                    );
                  }}
                  onDuplicate={() => {
                    setActionError(null);
                    void duplicate(workflow.id).then((next) => {
                      if (next) router.push(`/workflows/${next}`);
                    });
                  }}
                  onSaveTemplate={() => {
                    setActionError(null);
                    run(async () => {
                      const name = window.prompt("Template name", workflow.name);
                      if (!name || !name.trim()) return;
                      const template = await saveWorkflowAsTemplate(workflow.id, {
                        name: name.trim(),
                      });
                      setActionError(null);
                      router.push(`/templates?q=${encodeURIComponent(template.name)}`);
                    });
                  }}
                  onExport={() => {
                    setActionError(null);
                    run(async () => {
                      const result = await exportWorkflow(workflow.id);
                      const blob = new Blob([JSON.stringify(result.portable, null, 2)], {
                        type: "application/json",
                      });
                      const href = URL.createObjectURL(blob);
                      const anchor = document.createElement("a");
                      anchor.href = href;
                      anchor.download = result.filename;
                      anchor.click();
                      URL.revokeObjectURL(href);
                    });
                  }}
                  onRemove={() => {
                    setActionError(null);
                    run(() => remove(workflow.id));
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkflowRow({
  workflow,
  onToggleStatus,
  onDuplicate,
  onSaveTemplate,
  onExport,
  onRemove,
}: {
  workflow: Workflow;
  onToggleStatus: () => void;
  onDuplicate: () => void;
  onSaveTemplate: () => void;
  onExport: () => void;
  onRemove: () => void;
}) {
  const router = useRouter();
  const trigger = getDefinition(workflow.triggerType);
  const style = CATEGORY_STYLE[trigger?.category ?? "trigger"];

  const items: MenuItem[] = [
    {
      id: "open",
      label: "Open editor",
      icon: <Search className="h-3.5 w-3.5" />,
      onSelect: () => router.push(`/workflows/${workflow.id}`),
    },
    {
      id: "toggle",
      label: workflow.status === "active" ? "Pause workflow" : "Activate workflow",
      icon:
        workflow.status === "active" ? (
          <Pause className="h-3.5 w-3.5" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        ),
      onSelect: onToggleStatus,
    },
    { id: "dup", label: "Duplicate", icon: <Copy className="h-3.5 w-3.5" />, onSelect: onDuplicate },
    {
      id: "template",
      label: "Save as template",
      icon: <Layers className="h-3.5 w-3.5" />,
      onSelect: onSaveTemplate,
    },
    {
      id: "export",
      label: "Export…",
      icon: <FileJson className="h-3.5 w-3.5" />,
      onSelect: onExport,
    },
    {
      id: "archive",
      label: "Archive",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      danger: true,
      onSelect: onRemove,
    },
  ];

  return (
    <li>
      <div
        className={cn(
          "group relative grid grid-cols-1 items-center gap-x-4 gap-y-2 py-4 transition-colors",
          GRID,
          "border-b border-hairline last:border-b-0 hover:bg-raised/50",
        )}
      >
        <Link
          href={`/workflows/${workflow.id}`}
          className="flex min-w-0 items-start gap-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
        >
          <span
            className={cn(
              "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
              style.chip,
              style.text,
              style.border,
            )}
          >
            <Glyph name={trigger?.icon ?? "circle"} className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="kz-display truncate text-[14.5px] font-semibold tracking-[-0.01em] text-fg">
                {workflow.name}
              </span>
              <Badge status={workflow.status} className="md:hidden" />
            </span>
            <span className="mt-1 block truncate text-[12px] text-subtle">
              {workflow.description}
            </span>
          </span>
        </Link>

        <span className="hidden text-right text-[13px] text-muted md:block">
          <span className="kz-num">{workflow.executionCount.toLocaleString("en-US")}</span>
        </span>

        <span className="hidden text-right text-[13px] md:block">
          <span
            className={cn(
              "kz-num",
              workflow.successRate >= 97
                ? "text-ok"
                : workflow.successRate > 0
                  ? "text-warn"
                  : "text-disabled",
            )}
          >
            {workflow.successRate > 0 ? `${workflow.successRate.toFixed(1)}%` : "—"}
          </span>
        </span>

        <span className="hidden text-right text-[12px] text-subtle md:block">
          {workflow.lastExecutedAt ? (
            <>
              <TimeAgo iso={workflow.lastExecutedAt} />
              {workflow.avgDurationMs > 0 && (
                <span className="mt-0.5 block">
                  <Duration ms={workflow.avgDurationMs} className="text-subtle" />
                </span>
              )}
            </>
          ) : (
            "Never"
          )}
        </span>

        <span className="hidden justify-end md:flex">
          <Badge status={workflow.status} />
        </span>

        {/* mobile meta line */}
        <span className="flex items-center gap-3 text-[11px] text-subtle md:hidden">
          <span className="kz-num">
            {workflow.executionCount.toLocaleString("en-US")} runs
          </span>
          <span aria-hidden>·</span>
          <TimeAgo iso={workflow.lastExecutedAt} />
        </span>

        <span className="absolute right-3 top-3 md:static md:justify-self-end">
          <Menu
            label={`Actions for ${workflow.name}`}
            items={items}
            trigger={(props) => (
              <button
                {...props}
                type="button"
                aria-label={`Actions for ${workflow.name}`}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-all",
                  "hover:bg-panel hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal",
                  "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
                )}
              >
                <span className="sr-only">Actions</span>
                <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
                  <circle cx="8" cy="3.5" r="1.35" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.35" fill="currentColor" />
                  <circle cx="8" cy="12.5" r="1.35" fill="currentColor" />
                </svg>
              </button>
            )}
          />
        </span>
      </div>
    </li>
  );
}
