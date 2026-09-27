"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { statusMeta } from "@/lib/status";
import {
  formatOffset,
  nodeStatusOf,
  stepOffset,
  stepVisualState,
  type StepVisualState,
} from "@/lib/execution/debugger";
import { formatDuration, cn } from "@/lib/utils";
import type { ExecutionStepView } from "@/lib/execution/types";

/**
 * Run timeline — what happened, in order, with real timings.
 *
 * Offsets are computed from the run's start (never from a local clock),
 * so a refreshed page shows the same numbers as the live one. Long runs
 * render a window around the active step instead of the whole list.
 */

const WINDOW = 120;

const STATE_CHIP: Record<StepVisualState, string | null> = {
  idle: null,
  pending: null,
  running: null,
  retrying: "bg-warn-soft text-warn",
  waiting: "bg-info-soft text-info",
  completed: null,
  failed: null,
  skipped: null,
  cancelled: "bg-raised text-muted",
};

const STATE_LABEL: Record<StepVisualState, string | null> = {
  idle: null,
  pending: null,
  running: null,
  retrying: "retrying",
  waiting: "waiting",
  completed: null,
  failed: null,
  skipped: null,
  cancelled: "cancelled",
};

/**
 * Which pass through a Loop body a step belongs to.
 *
 * Loop iterations each record their own step, so the same node can
 * appear several times — the key (`0`, `1`, `0.1` when nested) is what
 * tells the passes apart in the list.
 */
function iterationOf(step: ExecutionStepView): string | null {
  const value = step.metadata?.iteration;
  return typeof value === "string" && value ? value : null;
}

function StateGlyph({ state }: { state: StepVisualState }) {
  const meta = statusMeta(nodeStatusOf(state));
  if (state === "running" || state === "retrying") {
    return (
      <span className="flex h-4 w-4 items-center justify-center">
        <Loader2
          className={cn("h-3.5 w-3.5", state === "retrying" ? "text-warn" : "animate-spin text-signal")}
        />
      </span>
    );
  }
  if (state === "pending" || state === "idle") {
    return (
      <span className="flex h-4 w-4 items-center justify-center">
        <span className="h-2 w-2 rounded-full border border-strong" aria-hidden />
      </span>
    );
  }
  return (
    <span className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)} aria-hidden />
  );
}

export function ExecutionTimeline({
  steps,
  runStartedAtMs,
  selectedNodeId,
  onSelect,
}: {
  steps: ExecutionStepView[];
  runStartedAtMs: number | null;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  const activeIndex = React.useMemo(() => {
    if (selectedNodeId) {
      const index = steps.findIndex((step) => step.nodeId === selectedNodeId);
      if (index !== -1) return index;
    }
    const live = steps.findIndex(
      (step) => step.status === "running" || step.status === "waiting",
    );
    if (live !== -1) return live;
    const failed = steps.findIndex((step) => step.status === "failed");
    return failed !== -1 ? failed : steps.length - 1;
  }, [steps, selectedNodeId]);

  const windowStart =
    steps.length > WINDOW
      ? Math.max(0, Math.min(activeIndex - Math.floor(WINDOW / 2), steps.length - WINDOW))
      : 0;
  const visible = steps.slice(windowStart, windowStart + WINDOW);
  const hidden = steps.length - visible.length;

  const activeRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (steps.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-[12.5px] text-subtle">
        No steps recorded yet — the engine writes them as it goes.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="kz-eyebrow text-[9.5px]">Timeline</span>
        <span className="kz-num ml-auto text-[10.5px] text-subtle">
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
      </div>

      <ol className="relative min-h-0 flex-1 overflow-y-auto py-1">
        <span
          aria-hidden
          className="absolute bottom-4 left-[54px] top-4 w-px bg-line"
        />
        {visible.map((step, index) => {
          const absoluteIndex = windowStart + index;
          const state = stepVisualState(step);
          const active = (selectedNodeId ?? null) === step.nodeId;
          const offset = stepOffset(step, runStartedAtMs);
          const chip = STATE_CHIP[state];
          const label = STATE_LABEL[state];
          const pass = iterationOf(step);

          return (
            <li key={`${step.nodeId}-${absoluteIndex}`}>
              <button
                type="button"
                ref={active ? activeRef : undefined}
                onClick={() => onSelect(step.nodeId)}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "relative flex w-full items-start gap-3 px-3 py-2 text-left transition-colors",
                  active ? "bg-raised/60" : "hover:bg-raised/40",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal",
                )}
              >
                <span className="kz-num w-[42px] shrink-0 pt-0.5 text-right text-[10.5px] tabular-nums text-subtle">
                  {offset === null ? "—" : formatOffset(offset)}
                </span>

                <span className="relative z-10 mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-app ring-2 ring-app">
                  <StateGlyph state={state} />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "truncate text-[13px] font-medium",
                        state === "skipped" || state === "pending"
                          ? "text-disabled"
                          : "text-fg",
                      )}
                    >
                      {step.nodeLabel}
                    </span>
                    {step.attempt > 1 && (
                      <span className="kz-num rounded-sm bg-raised px-1.5 py-[1px] text-[9.5px] text-muted">
                        attempt {step.attempt}
                      </span>
                    )}
                    {pass !== null && (
                      <span className="kz-num rounded-sm bg-raised px-1.5 py-[1px] text-[9.5px] text-muted">
                        pass {pass}
                      </span>
                    )}
                    {label && chip && (
                      <span
                        className={cn(
                          "kz-eyebrow rounded-sm px-1.5 py-[1px] text-[8.5px]",
                          chip,
                        )}
                      >
                        {label}
                      </span>
                    )}
                    <span className="kz-num ml-auto shrink-0 text-[10.5px] text-subtle">
                      {step.status === "pending"
                        ? "—"
                        : step.status === "skipped"
                          ? "skipped"
                          : formatDuration(step.durationMs)}
                    </span>
                  </span>

                  <span className="mt-0.5 flex items-center gap-2 truncate font-mono text-[11px] text-subtle">
                    <span className="truncate">{step.ref}</span>
                    <span className="text-disabled">·</span>
                    <span className="truncate">{step.nodeType}</span>
                  </span>

                  {step.error && (
                    <span className="mt-1 block truncate text-[11.5px] text-danger">
                      {step.error.code} — {step.error.message}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}

        {hidden > 0 && (
          <li className="px-3 py-2 text-center">
            <span className="kz-eyebrow text-[9px] text-subtle">
              {windowStart > 0 ? `${windowStart} earlier · ` : ""}
              {steps.length - (windowStart + visible.length)} later steps not shown
            </span>
          </li>
        )}
      </ol>
    </div>
  );
}
