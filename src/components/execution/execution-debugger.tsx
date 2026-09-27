"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ExternalLink,
  Hammer,
  OctagonX,
  RotateCcw,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { TimeAgo } from "@/components/format/time";
import { ErrorPanel } from "@/components/workflow/execution/data-view";
import { FailureExplainCard } from "@/components/ai/failure-explain";
import { ExecutionCanvas } from "./execution-canvas";
import { ExecutionTimeline } from "./execution-timeline";
import { StepInspector } from "./step-inspector";
import {
  ApiError,
  cancelExecution,
  executionEventsUrl,
  getExecution,
  getExecutionDefinition,
  rerunExecution,
  type ExecutionDefinition,
} from "@/lib/execution/api";
import { createFeed } from "@/lib/execution/feed";
import { isFinishedEvent, type EngineEvent } from "@/lib/execution/events";
import {
  applyEvent,
  isTerminal,
  planFromExecution,
} from "@/lib/execution/projector";
import {
  failedStepOf,
  sideEffectsFor,
  stepVisualState,
  waitingStepOf,
  type StepVisualState,
} from "@/lib/execution/debugger";
import { statusMeta } from "@/lib/status";
import { formatDuration, cn } from "@/lib/utils";
import type {
  ExecutionDetail,
  ExecutionPlan,
  ExecutionPlanEdge,
} from "@/lib/execution/types";

/**
 * The execution debugger.
 *
 * One run, three synchronized views: the graph it walked, the timeline
 * of what it did, and the data behind the selected step. Everything is
 * server truth — a snapshot plus the live event stream — so a refresh
 * mid-run lands in exactly the same place.
 */

type LoadState = "loading" | "ready" | "missing" | "error";

export function ExecutionDebugger({
  id,
  workflowId,
}: {
  id: string;
  /** Known when deep-linked from a workflow; used for the back link. */
  workflowId?: string;
}) {
  /* Remounting per id gives every run clean fetch/subscription state. */
  return <DebuggerBody key={id} id={id} workflowId={workflowId} />;
}

function planEdgesOf(definition: ExecutionDefinition): ExecutionPlanEdge[] {
  return definition.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    branch: edge.data?.branch,
  }));
}

function DebuggerBody({ id, workflowId }: { id: string; workflowId?: string }) {
  const router = useRouter();
  const [execution, setExecution] = React.useState<ExecutionDetail | null>(null);
  const [definition, setDefinition] = React.useState<ExecutionDefinition | null>(null);
  const [plan, setPlan] = React.useState<ExecutionPlan | null>(null);
  const [loadState, setLoadState] = React.useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [retryKey, setRetryKey] = React.useState(0);
  const [liveMs, setLiveMs] = React.useState(0);
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
  const [cancelPending, setCancelPending] = React.useState(false);
  const [rerunOpen, setRerunOpen] = React.useState(false);
  const [rerunning, setRerunning] = React.useState(false);
  const [rerunError, setRerunError] = React.useState<string | null>(null);

  /* ---- fetch + live subscription -------------------------------- */
  React.useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let planState: ExecutionPlan | null = null;

    getExecution(id)
      .then(async (loaded) => {
        /* The graph is best-effort: a run whose version was pruned still
           deserves a timeline and an inspector. */
        const pinned = await getExecutionDefinition(id).catch(() => null);
        if (cancelled) return;

        const edges = pinned ? planEdgesOf(pinned) : [];
        planState = planFromExecution(loaded, edges);
        setExecution(loaded);
        setDefinition(pinned);
        setPlan(planState);
        setLoadState("ready");
        if (isTerminal(loaded.status)) return;

        const feed = createFeed({
          onSnapshot: (snapshot) => {
            planState = planFromExecution(snapshot, edges);
            setExecution(snapshot);
            setPlan(planState);
          },
          onEvent: (event) => {
            if (!planState) return;
            planState = applyEvent(planState, event);
            const folded = planState;
            setPlan(folded);
            setExecution((previous) => (previous ? rollForward(previous, folded, event) : previous));
          },
        });

        source = new EventSource(executionEventsUrl(id));
        source.onmessage = (message) => {
          if (cancelled) {
            source?.close();
            return;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(message.data);
          } catch {
            return;
          }
          feed.push(payload);
        };
        source.onerror = () => {
          /* EventSource reconnects; the next snapshot re-syncs state. */
        };
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setLoadState("missing");
          return;
        }
        setErrorMessage(
          error instanceof ApiError ? error.message : "The execution could not be loaded.",
        );
        setLoadState("error");
      });

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [id, retryKey]);

  /* ---- live duration ticker while the run is going -------------- */
  const running = execution !== null && !isTerminal(execution.status);
  const startedAtIso = execution?.startedAt;
  React.useEffect(() => {
    if (!running || !startedAtIso) return;
    const started = Date.parse(startedAtIso);
    const timer = window.setInterval(() => {
      setLiveMs(Math.max(0, Date.now() - started));
    }, 250);
    return () => window.clearInterval(timer);
  }, [running, startedAtIso]);

  const steps = React.useMemo(
    () => plan?.steps ?? execution?.steps ?? [],
    [plan, execution],
  );
  const failedStep = React.useMemo(() => failedStepOf(steps), [steps]);
  const waitingStep = React.useMemo(() => waitingStepOf(steps), [steps]);

  /* Canvas vocabulary: the debugger knows `retrying` and `cancelled`,
     which the shared node-status maps do not. */
  const nodeStates = React.useMemo(() => {
    const states: Record<string, StepVisualState> = {};
    for (const step of steps) states[step.nodeId] = stepVisualState(step);
    return states;
  }, [steps]);

  const selectedStep = React.useMemo(() => {
    if (selectedNodeId) {
      const found = steps.find((item) => item.nodeId === selectedNodeId);
      if (found) return found;
    }
    /* No explicit selection: follow the run — the failure, then whatever
       is live, then the last thing that happened. */
    if (failedStep) return failedStep;
    const live =
      steps.find((item) => item.status === "running" || item.status === "waiting") ?? null;
    return live ?? steps[steps.length - 1] ?? null;
  }, [steps, selectedNodeId, failedStep]);

  const effectiveSelectedId = selectedStep?.nodeId ?? null;
  const meta = execution ? statusMeta(execution.status) : null;
  const shownMs = running ? liveMs : execution?.durationMs ?? 0;
  const completedCount = steps.filter((step) => step.status === "completed").length;
  const runStartedAtMs = execution ? Date.parse(execution.startedAt) : null;
  const canCancel = running && !cancelPending && execution?.cancelRequested !== true;

  const onCancel = React.useCallback(() => {
    setCancelPending(true);
    cancelExecution(id)
      .catch(() => undefined)
      .finally(() => setCancelPending(false));
  }, [id]);

  const onRerun = React.useCallback(async () => {
    setRerunning(true);
    setRerunError(null);
    try {
      const next = await rerunExecution(id);
      setRerunOpen(false);
      router.push(`/workflows/${next.workflowId}/executions/${next.id}`);
    } catch (error) {
      setRerunError(
        error instanceof ApiError ? error.message : "The run could not be started again.",
      );
    } finally {
      setRerunning(false);
    }
  }, [id, router]);

  /* ---- loading / missing / error --------------------------------- */
  if (loadState === "loading" || !execution) {
    if (loadState === "missing") {
      return (
        <RunStateShell>
          <EmptyState
            title="Run not found"
            description="That execution id does not exist. Pick a run from the list."
            action={
              <Link href="/executions" className={buttonClassName("secondary")}>
                Back to executions
              </Link>
            }
          />
        </RunStateShell>
      );
    }
    if (loadState === "error") {
      return (
        <RunStateShell>
          <EmptyState
            title="Could not load this run"
            description={errorMessage ?? "Something went wrong."}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setLoadState("loading");
                  setExecution(null);
                  setRetryKey((value) => value + 1);
                }}
              >
                Try again
              </Button>
            }
          />
        </RunStateShell>
      );
    }
    return (
      <RunStateShell>
        <p className="kz-eyebrow text-[10px]">Loading run…</p>
        <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
          {[0, 1, 2, 3].map((cell) => (
            <div key={cell} className="h-14 animate-pulse bg-raised/60" />
          ))}
        </div>
        <div className="mt-8 h-64 animate-pulse bg-raised/60" />
      </RunStateShell>
    );
  }

  const backHref = workflowId ? `/workflows/${workflowId}` : "/executions";
  const backLabel = workflowId ? "Workflow" : "Executions";
  const definitionNodes = definition?.nodes ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:overflow-hidden">
      {/* header ------------------------------------------------------ */}
      <div className="shrink-0 border-b border-line">
        <div className="kz-frame py-5 lg:py-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <Link
                href={backHref}
                className="kz-eyebrow inline-flex items-center gap-1.5 transition-colors hover:text-fg"
              >
                <ArrowLeft className="h-3 w-3" />
                {backLabel}
              </Link>

              <div className="mt-3 flex flex-wrap items-center gap-2.5">
                <h1 className="text-page text-fg">{execution.workflowName}</h1>
                <Badge status={execution.status} />
                {execution.cancelRequested && !isTerminal(execution.status) && (
                  <span className="kz-eyebrow rounded-sm border border-warn/40 bg-warn-soft px-1.5 py-[2px] text-[8.5px] text-warn">
                    Cancelling
                  </span>
                )}
                {execution.source === "seed" && (
                  <span className="kz-eyebrow rounded-sm border border-warn/40 bg-warn-soft px-1.5 py-[2px] text-[8.5px] text-warn">
                    Seed data
                  </span>
                )}
              </div>

              <dl className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <div className="flex items-baseline gap-2">
                  <dt className="kz-eyebrow text-[9px]">Run</dt>
                  <dd className="kz-num text-[12px] text-fg">{execution.id}</dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="kz-eyebrow text-[9px]">Started</dt>
                  <dd className="text-[12px] text-muted">
                    <TimeAgo iso={execution.startedAt} />
                  </dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="kz-eyebrow text-[9px]">Duration</dt>
                  <dd className="kz-num text-[12px] text-fg">
                    {formatDuration(shownMs)}
                    {running && <span className="text-subtle"> · live</span>}
                  </dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="kz-eyebrow text-[9px]">Steps</dt>
                  <dd className="kz-num text-[12px] text-fg">
                    {completedCount}/{steps.length}
                  </dd>
                </div>
                {meta && (
                  <div className="flex items-baseline gap-2">
                    <dt className="kz-eyebrow text-[9px]">State</dt>
                    <dd className={cn("text-[12px]", meta.text)}>{meta.label}</dd>
                  </div>
                )}
              </dl>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {canCancel && (
                <Button variant="danger" onClick={onCancel}>
                  <OctagonX className="h-3.5 w-3.5" />
                  {cancelPending ? "Cancelling…" : "Cancel run"}
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => {
                  setRerunError(null);
                  setRerunOpen(true);
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Run again
              </Button>
              <Link
                href={`/workflows/${execution.workflowId}`}
                className={buttonClassName("secondary", "md", "gap-1.5")}
              >
                <WorkflowIcon className="h-3.5 w-3.5" />
                Open workflow
                <ExternalLink className="h-3 w-3 text-subtle" />
              </Link>
            </div>
          </div>

          {/* banners ------------------------------------------------- */}
          {running && execution.status === "waiting" && (
            <p className="mt-4 flex items-start gap-2 rounded-md border border-info/40 bg-info-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted">
              <span className="text-info">Waiting. </span>
              {waitingStep
                ? `“${waitingStep.nodeLabel}” is parked — the run resumes when the wait ends.`
                : "The run is parked and will resume on its own."}
            </p>
          )}

          {execution.cancelRequested && !isTerminal(execution.status) && (
            <p className="mt-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted">
              <span className="text-warn">Cancellation requested. </span>
              The engine stops at the next safe point; this page updates as soon as it does.
            </p>
          )}

          {execution.status === "failed" && (
            <div className="mt-4">
              {execution.error && <ErrorPanel error={execution.error} />}
              {failedStep && (
                <p className="mt-2 text-[12.5px] text-muted">
                  Failed in{" "}
                  <span className="text-fg">{failedStep.nodeLabel}</span>
                  {failedStep.attempt > 1 ? ` after ${failedStep.attempt} attempts` : ""}.
                </p>
              )}
              <FailureExplainCard
                executionId={execution.id}
                className="mt-3 border-t border-line pt-3"
              />
            </div>
          )}

          {execution.status === "cancelled" && (
            <p className="mt-4 rounded-md border border-line bg-raised px-3.5 py-2.5 text-[12.5px] text-muted">
              This run was cancelled.{" "}
              {failedStep ? `It stopped in “${failedStep.nodeLabel}”.` : ""}
            </p>
          )}
        </div>
      </div>

      {/* body -------------------------------------------------------- */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        {/* graph + timeline */}
        <div className="flex min-h-0 flex-col border-b border-line lg:border-b-0 lg:border-r">
          <div className="h-[300px] shrink-0 border-b border-line sm:h-[360px] lg:h-[46%]">
            {definition ? (
              <ExecutionCanvas
                definition={definition}
                nodeStates={nodeStates}
                edgeStates={plan?.edgeStates ?? {}}
                steps={steps}
                selectedNodeId={effectiveSelectedId}
                onSelect={setSelectedNodeId}
                focusNodeId={selectedNodeId}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <p className="max-w-[42ch] text-[12.5px] leading-relaxed text-subtle">
                  The graph this run used is no longer stored, so the canvas cannot be
                  drawn. The timeline below is complete.
                </p>
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <ExecutionTimeline
              steps={steps}
              runStartedAtMs={runStartedAtMs}
              selectedNodeId={effectiveSelectedId}
              onSelect={setSelectedNodeId}
            />
          </div>
        </div>

        {/* inspector */}
        <aside className="flex min-h-0 flex-col bg-surface lg:overflow-hidden">
          <StepInspector step={selectedStep} runStartedAtMs={runStartedAtMs} />
        </aside>
      </div>

      {rerunOpen && (
        <RerunDialog
          nodes={definitionNodes}
          busy={rerunning}
          onCancel={() => setRerunOpen(false)}
          onConfirm={() => void onRerun()}
          errorMessage={rerunError}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function rollForward(
  previous: ExecutionDetail,
  folded: ExecutionPlan,
  event: EngineEvent,
): ExecutionDetail {
  const next: ExecutionDetail = {
    ...previous,
    status: folded.status,
    durationMs: folded.durationMs,
    steps: folded.steps,
  };
  if (isFinishedEvent(event)) {
    next.output = event.output;
    next.error = event.error;
    next.completedAt = event.completedAt;
    next.cancelRequested = false;
    next.failedStepCount = folded.steps.filter((step) => step.status === "failed").length;
    next.stepCount = folded.steps.length;
  }
  if (event.type === "execution.status") {
    next.status = event.status;
  }
  return next;
}

function RunStateShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="kz-frame py-8 lg:py-12">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Run-again confirmation                                               */
/* ------------------------------------------------------------------ */

function RerunDialog({
  nodes,
  busy,
  onCancel,
  onConfirm,
  errorMessage,
}: {
  nodes: { id: string; type: string; data?: { label?: unknown; config?: unknown } }[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  errorMessage: string | null;
}) {
  const effects = React.useMemo(() => sideEffectsFor(nodes), [nodes]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-app/70 p-4 backdrop-blur-sm sm:items-center"
      role="presentation"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Run this workflow again"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-[520px] rounded-lg border border-line bg-panel shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-edge bg-raised">
            <Hammer className="h-3.5 w-3.5 text-muted" />
          </span>
          <div className="min-w-0">
            <h2 className="kz-display text-[14px] font-semibold text-fg">
              Run this workflow again?
            </h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              The stored version and the original input are replayed as a new run. This
              run stays exactly as it is.
            </p>
          </div>
        </div>

        <div className="px-5 py-4">
          {effects.length > 0 ? (
            <>
              <p className="kz-eyebrow text-[9.5px]">These steps will act again</p>
              <ul className="mt-2 divide-y divide-hairline border-y border-edge">
                {effects.map((effect) => (
                  <li key={effect.nodeId} className="flex items-baseline gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
                      {effect.label}
                    </span>
                    <span className="shrink-0 text-right text-[11.5px] text-subtle">
                      {effect.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-muted">
              No step in this graph writes to an outside service — the rerun is safe to
              repeat.
            </p>
          )}

          {errorMessage && (
            <p className="mt-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-[12px] text-danger">
              {errorMessage}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>
            <RotateCcw className="h-3.5 w-3.5" />
            {busy ? "Starting…" : "Run again"}
          </Button>
        </div>
      </div>
    </div>
  );
}
