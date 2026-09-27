"use client";

import * as React from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { Segmented } from "@/components/ui/field";
import { TimeAgo, Duration } from "@/components/format/time";
import { hasActiveRows, useExecutionsStore } from "@/stores/executions";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { ExecutionView } from "@/lib/execution/types";
import type { ExecutionStatus } from "@/lib/workflow/types";

type StatusFilter = "all" | ExecutionStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const GRID = "md:grid-cols-[minmax(0,1fr)_136px_96px_92px]";

function startedToday(iso: string): boolean {
  const date = new Date(iso);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function StatusDot({ status }: { status: ExecutionStatus }) {
  const meta = statusMeta(status);
  return (
    <span className="relative mt-1.5 flex h-2 w-2 shrink-0 items-center justify-center">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          meta.dot,
          status === "running" && "kz-breathe",
        )}
        aria-hidden
      />
    </span>
  );
}

function Row({ execution }: { execution: ExecutionView }) {
  const meta = statusMeta(execution.status);
  const failed = execution.failedStepCount > 0 || execution.status === "failed";
  const active =
    execution.status === "running" ||
    execution.status === "queued" ||
    execution.status === "waiting";
  const [liveMs, setLiveMs] = React.useState(execution.durationMs);

  /* Active rows tick with real wall-clock time; finished rows use the
     persisted duration. The timer lives in an effect, never in render. */
  React.useEffect(() => {
    if (!active) return;
    const started = Date.parse(execution.startedAt);
    const timer = window.setInterval(() => {
      setLiveMs(Math.max(0, Date.now() - started));
    }, 500);
    return () => window.clearInterval(timer);
  }, [active, execution.startedAt]);

  const durationMs = active ? liveMs : execution.durationMs;

  return (
    <li>
      <Link
        href={`/workflows/${execution.workflowId}/executions/${execution.id}`}
        className={cn(
          "group grid grid-cols-1 items-start gap-x-4 gap-y-2 py-4 transition-colors",
          GRID,
          "border-b border-hairline last:border-0 hover:bg-raised/50",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal",
        )}
      >
        <span className="flex min-w-0 items-start gap-3">
          <StatusDot status={execution.status} />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="kz-display truncate text-[14.5px] font-semibold tracking-[-0.01em] text-fg">
                {execution.workflowName}
              </span>
              <span className="kz-num rounded-sm bg-inset px-1.5 py-[1px] text-[10.5px] text-subtle">
                {execution.id}
              </span>
              {execution.cancelRequested && active && (
                <span className="kz-eyebrow rounded-sm border border-warn/40 bg-warn-soft px-1.5 py-[1px] text-[8.5px] text-warn">
                  Cancelling
                </span>
              )}
              {execution.source === "seed" && (
                <span className="kz-eyebrow rounded-sm border border-warn/40 bg-warn-soft px-1.5 py-[1px] text-[8.5px] text-warn">
                  Seed
                </span>
              )}
            </span>
            <span className="mt-1 block truncate text-[12px] text-subtle">
              {execution.trigger.label} · {execution.stepCount} step
              {execution.stepCount === 1 ? "" : "s"}
              {execution.note ? ` · ${execution.note}` : ""}
            </span>
            {execution.error && (
              <span className="mt-1 block truncate text-[12px] text-danger">
                {execution.error.code} — {execution.error.message}
              </span>
            )}
            <span className="mt-1.5 flex items-center gap-2 md:hidden">
              <Badge status={execution.status} />
              <TimeAgo iso={execution.startedAt} className="text-[11px] text-subtle" />
              <Duration ms={durationMs} className="text-[11px] text-subtle" />
            </span>
          </span>
        </span>

        <span className="hidden pt-0.5 text-[12.5px] text-subtle md:block">
          <TimeAgo iso={execution.startedAt} />
        </span>

        <span className="hidden pt-0.5 md:block">
          <span
            className={cn(
              "kz-num text-[12.5px]",
              failed ? "text-danger" : "text-muted",
            )}
          >
            <Duration ms={durationMs} />
          </span>
        </span>

        <span className="hidden justify-self-end pt-0.5 md:block">
          <Badge status={execution.status} />
        </span>

        <span className="sr-only">
          {meta.label} run of {execution.workflowName}
        </span>
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div>
      {[0, 1, 2, 3].map((row) => (
        <div
          key={row}
          className="flex items-center gap-4 border-b border-hairline py-4 last:border-0"
        >
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-inset" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-1/3 animate-pulse rounded bg-inset" />
            <span className="block h-2.5 w-1/2 animate-pulse rounded bg-inset" />
          </span>
          <span className="hidden h-3 w-16 animate-pulse rounded bg-inset md:block" />
        </div>
      ))}
    </div>
  );
}

export default function ExecutionsPage() {
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const rows = useExecutionsStore((state) => state.rows);
  const loaded = useExecutionsStore((state) => state.loaded);
  const error = useExecutionsStore((state) => state.error);
  const refresh = useExecutionsStore((state) => state.refresh);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  /* While a run is live, keep history fresh; refetch on return. */
  React.useEffect(() => {
    if (!loaded) return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = hasActiveRows(rows)
      ? window.setInterval(() => void refresh(), 4_000)
      : null;
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer) window.clearInterval(timer);
    };
  }, [loaded, rows, refresh]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((execution) => {
      if (status !== "all" && execution.status !== status) return false;
      if (!needle) return true;
      return (
        execution.workflowName.toLowerCase().includes(needle) ||
        execution.id.toLowerCase().includes(needle) ||
        execution.trigger.label.toLowerCase().includes(needle)
      );
    });
  }, [rows, query, status]);

  const counts = React.useMemo(() => {
    const map = new Map<ExecutionStatus, number>();
    for (const execution of rows) {
      map.set(execution.status, (map.get(execution.status) ?? 0) + 1);
    }
    return map;
  }, [rows]);

  const todayRows = React.useMemo(
    () => rows.filter((execution) => startedToday(execution.startedAt)),
    [rows],
  );
  const todayFinished = todayRows.filter(
    (execution) => execution.status === "completed" || execution.status === "failed",
  );
  const todayCompleted = todayFinished.filter(
    (execution) => execution.status === "completed",
  ).length;
  const todayFailures = todayRows.filter(
    (execution) => execution.status === "failed",
  ).length;
  const successRate = todayFinished.length
    ? Math.round((todayCompleted / todayFinished.length) * 100)
    : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="kz-frame py-8 lg:py-12">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="kz-eyebrow mb-2.5">Runs</p>
            <h1 className="text-page text-fg">Executions</h1>
            <p className="mt-1.5 max-w-[56ch] text-sm leading-relaxed text-muted">
              Every run KLYZ has taken, with the exact input, output and error for
              each step. Rows marked “Seed” are development data.
            </p>
          </div>

          <dl className="flex items-end gap-7">
            <div>
              <dt className="kz-eyebrow text-[9.5px]">Today</dt>
              <dd className="kz-display mt-1 text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-fg">
                {todayRows.length}
              </dd>
            </div>
            <div>
              <dt className="kz-eyebrow text-[9.5px]">Failures</dt>
              <dd className="kz-display mt-1 text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-danger">
                {todayFailures}
              </dd>
            </div>
            <div>
              <dt className="kz-eyebrow text-[9.5px]">Success</dt>
              <dd className="kz-display mt-1 text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ok">
                {successRate === null ? "—" : `${successRate}%`}
              </dd>
            </div>
          </dl>
        </header>

        {/* filters ---------------------------------------------------- */}
        <div className="mt-7 flex flex-wrap items-center gap-3 border-b border-edge pb-4">
          <Segmented
            ariaLabel="Filter by status"
            stretch={false}
            value={status}
            onChange={(next) => setStatus(next as StatusFilter)}
            options={STATUS_FILTERS.map((option) => {
              const count =
                option.value === "all"
                  ? rows.length
                  : (counts.get(option.value) ?? 0);
              return {
                ...option,
                meta: (
                  <span className="kz-num text-[10px]">{count}</span>
                ),
              };
            })}
          />

          <div className="relative ml-auto w-full sm:w-[260px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search runs, ids, triggers…"
              aria-label="Search executions"
              className="h-8 w-full rounded-md border border-line bg-inset pl-8 pr-2.5 text-[13px] text-fg placeholder:text-subtle transition-colors focus:border-signal/60 focus:outline-none focus:ring-2 focus:ring-signal/20"
            />
          </div>
        </div>

        {/* list ------------------------------------------------------- */}
        {error ? (
          <EmptyState
            title="Could not load executions"
            description={error}
            action={
              <Button variant="secondary" onClick={() => void refresh()}>
                Try again
              </Button>
            }
          />
        ) : !loaded ? (
          <ListSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No runs yet"
            description="Open a workflow and run it — executions appear here with every step's input and output."
            action={
              <Link href="/workflows" className={buttonClassName("secondary")}>
                Browse workflows
              </Link>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title="No runs match those filters"
            description="Clear the search or switch the status filter to see other executions."
          />
        ) : (
          <div>
            <div
              className={cn(
                "hidden gap-x-4 border-b border-edge py-2.5 md:grid",
                GRID,
              )}
            >
              <span className="kz-eyebrow text-[9.5px]">Run</span>
              <span className="kz-eyebrow text-[9.5px]">Started</span>
              <span className="kz-eyebrow text-[9.5px]">Duration</span>
              <span className="kz-eyebrow justify-self-end text-[9.5px]">
                Status
              </span>
            </div>
            <ul>
              {visible.map((execution) => (
                <Row key={execution.id} execution={execution} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
