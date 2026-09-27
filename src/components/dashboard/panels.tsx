"use client";

import * as React from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Glyph } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { TimeAgo, Duration } from "@/components/format/time";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";
import { CATEGORY_STYLE } from "@/lib/workflow/category";
import { getDefinition } from "@/lib/workflow/registry";
import { useClientValue } from "@/lib/react";
import type {
  WorkspaceMetrics,
  WorkflowHealthRow,
} from "@/lib/server/dashboard";
import type { ExecutionDetail } from "@/lib/execution/types";

/* ------------------------------------------------------------------ */
/* Greeting                                                            */
/* ------------------------------------------------------------------ */

function greetingForHour(hour: number): string {
  if (hour < 5) return "Still up?";
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

export function Greeting() {
  const text = useClientValue("Welcome back.", () =>
    greetingForHour(new Date().getHours()),
  );

  return (
    <h1 suppressHydrationWarning className="text-page text-fg">
      {text}
    </h1>
  );
}

/* ------------------------------------------------------------------ */
/* Health strip                                                        */
/* ------------------------------------------------------------------ */

interface HealthCell {
  value: string;
  label: string;
  detail: string;
  tone?: "warn" | "ok";
  href?: string;
}

export function HealthStrip({ metrics }: { metrics: WorkspaceMetrics }) {
  const cells: HealthCell[] = [
    {
      value: String(metrics.activeWorkflows),
      label: "workflows active",
      detail: `of ${metrics.totalWorkflows} in this workspace`,
      tone: "ok",
    },
    {
      value: String(metrics.runsToday),
      label: "runs today",
      detail:
        metrics.successRate === null
          ? "no finished runs yet"
          : `${metrics.successRate}% successful`,
    },
    {
      value: String(metrics.failures),
      label: metrics.failures === 1 ? "needs attention" : "need attention",
      detail:
        metrics.oldestFailureHours === null
          ? "nothing failing"
          : `oldest ${metrics.oldestFailureHours} hour${
              metrics.oldestFailureHours === 1 ? "" : "s"
            } ago`,
      tone: "warn",
      href: "/executions?status=failed",
    },
  ];

  return (
    <div className="grid grid-cols-1 divide-y divide-edge border-y border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      {cells.map((cell) => {
        const inner = (
          <>
            <div className="flex items-baseline gap-3">
              <span
                className={cn(
                  "kz-display text-[34px] font-semibold leading-none tracking-[-0.02em] tabular-nums",
                  cell.tone === "warn" ? "text-warn" : "text-fg",
                )}
              >
                {cell.value}
              </span>
              <span className="font-mono text-[10.5px] uppercase leading-none tracking-[0.1em] text-subtle">
                {cell.label}
              </span>
            </div>
            <p className="mt-2 text-[12px] leading-none text-muted">
              {cell.detail}
            </p>
          </>
        );

        if (cell.href) {
          return (
            <Link
              key={cell.label}
              href={cell.href}
              className="group px-0 py-5 transition-colors hover:bg-raised/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal sm:px-6 sm:first:pl-0 sm:last:pr-0"
            >
              <div className="flex items-start justify-between gap-3">
                <div>{inner}</div>
                <ChevronRight className="mt-1.5 h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-warn" />
              </div>
            </Link>
          );
        }
        return (
          <div
            key={cell.label}
            className="px-0 py-5 sm:px-6 sm:first:pl-0 sm:last:pr-0"
          >
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Run chain — connected nodes of the most recent run                  */
/* ------------------------------------------------------------------ */

export function RunChain({
  execution,
  className,
}: {
  execution: ExecutionDetail;
  className?: string;
}) {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={`Steps in ${execution.workflowName}`}
      className={cn(
        "kz-canvas-grid flex items-center gap-0 overflow-x-auto rounded-lg border border-line bg-canvas px-5 py-7 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal",
        className,
      )}
    >
      {execution.steps.map((step, index) => {
        const definition = getDefinition(step.nodeType);
        const category = definition?.category ?? "action";
        const style = CATEGORY_STYLE[category];
        const meta = statusMeta(step.status);
        const isLast = index === execution.steps.length - 1;

        return (
          /* A loop runs the same node once per item, so the row key has to
             be the step, not the node, or React drops the duplicates. */
          <React.Fragment key={step.id}>
            <div
              className={cn(
                "group flex w-[142px] shrink-0 flex-col gap-2",
                step.status === "skipped" && "opacity-55",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2.5 rounded-md border bg-surface px-2.5 py-2 transition-colors",
                  step.status === "failed"
                    ? "border-danger/55"
                    : "border-line",
                )}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-sm",
                    style.chip,
                    style.text,
                  )}
                >
                  <Glyph name={definition?.icon ?? "circle"} className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium leading-tight text-fg">
                    {step.nodeLabel}
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 block truncate text-[10px] uppercase tracking-[0.08em] leading-none",
                      meta.text,
                    )}
                  >
                    {meta.label}
                  </span>
                </span>
                <StatusGlyph status={step.status} />
              </div>
              <div className="px-1">
                <Duration
                  ms={step.durationMs}
                  className={cn(
                    "text-[10px] leading-none",
                    step.status === "skipped" ? "text-disabled" : "text-subtle",
                  )}
                />
              </div>
            </div>

            {!isLast && (
              <div aria-hidden className="relative flex h-8 w-10 shrink-0 items-center">
                <span
                  className={cn(
                    "h-px w-full",
                    step.status === "completed" ? "bg-ok/45" : "bg-line",
                  )}
                />
                <span
                  className={cn(
                    "absolute -right-0.5 h-1.5 w-1.5 rotate-45 border-r border-t",
                    step.status === "completed"
                      ? "border-ok/70"
                      : "border-strong",
                  )}
                />
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function StatusGlyph({ status }: { status: string }) {
  const meta = statusMeta(status);
  return (
    <span
      aria-hidden
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Workflow health                                                     */
/* ------------------------------------------------------------------ */

export function WorkflowHealth({ rows }: { rows: WorkflowHealthRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-5 text-[12.5px] text-subtle">
        No workflows yet — create one to start automating.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {rows.map((workflow) => {
        const meta = statusMeta(workflow.status);
        const trigger = getDefinition(workflow.triggerType);
        const style = CATEGORY_STYLE[trigger?.category ?? "trigger"];
        return (
          <li key={workflow.id}>
            <Link
              href={`/workflows/${workflow.id}`}
              className="group flex items-center gap-3 border-b border-hairline py-3.5 transition-colors last:border-b-0 hover:bg-raised/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-sm",
                  style.chip,
                  style.text,
                )}
              >
                <Glyph name={trigger?.icon ?? "circle"} className="h-3.5 w-3.5" />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-fg">
                    {workflow.name}
                  </span>
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} />
                </span>
                <span className="mt-1 flex items-center gap-2 text-[11px] text-subtle">
                  <span>{workflow.executionCount.toLocaleString("en-US")} runs</span>
                  <span aria-hidden className="text-disabled">
                    ·
                  </span>
                  <span>
                    {workflow.successRate === null
                      ? "no finished runs"
                      : `${workflow.successRate.toFixed(1)}% ok`}
                  </span>
                </span>
              </span>

              <span className="hidden shrink-0 text-right sm:block">
                <span className="block text-[11px] text-subtle">
                  {workflow.lastExecutedAt ? (
                    <TimeAgo iso={workflow.lastExecutedAt} />
                  ) : (
                    "Never run"
                  )}
                </span>
                <span
                  className={cn(
                    "mt-1 block text-[11px] font-medium",
                    meta.text,
                  )}
                >
                  {meta.label}
                </span>
              </span>

              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-signal-text" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Recent activity                                                     */
/* ------------------------------------------------------------------ */

export function RecentActivity({
  rows,
  limit = 7,
}: {
  rows: ExecutionDetail[];
  limit?: number;
}) {
  const visible = rows.slice(0, limit);

  if (visible.length === 0) {
    return (
      <p className="py-5 text-[12.5px] text-subtle">
        No runs yet — executions appear here as soon as you trigger one.
      </p>
    );
  }

  return (
    <ul className="flex flex-col">
      {visible.map((execution) => {
        const meta = statusMeta(execution.status);
        const failedStep = execution.steps.find((step) => step.status === "failed");
        return (
          <li key={execution.id}>
            <Link
              href={`/executions/${execution.id}`}
              className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-hairline py-3.5 transition-colors last:border-b-0 hover:bg-raised/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal sm:grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1fr)_auto_auto]"
            >
              <span
                aria-hidden
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  meta.dot,
                  execution.status === "running" && "animate-pulse",
                )}
              />

              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-fg">
                    {execution.workflowName}
                  </span>
                  {execution.source === "seed" && (
                    <span className="kz-eyebrow shrink-0 rounded-sm border border-warn/40 bg-warn-soft px-1 py-[1px] text-[8px] text-warn">
                      Seed
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-subtle sm:hidden">
                  {execution.trigger.label} · {execution.steps.length} steps
                </span>
              </span>

              <span className="hidden min-w-0 truncate text-[12px] text-subtle sm:block">
                {failedStep ? failedStep.nodeLabel : `${execution.trigger.label} · ${execution.steps.length} steps`}
              </span>

              <span className="hidden text-right text-[12px] sm:block">
                <Duration ms={execution.durationMs} className="text-muted" />
              </span>

              <span className="flex items-center justify-end gap-2">
                <Badge status={execution.status} dot={false} />
                <span className="hidden w-[68px] text-right text-[11px] text-subtle md:block">
                  <TimeAgo iso={execution.startedAt} />
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
