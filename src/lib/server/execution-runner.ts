import type { ExecutionJob } from "@/lib/queue/types";
import { cancelPollMs, executionTimeoutMs } from "@/lib/config/env";
import { executeWorkflow } from "@/lib/engine/executor";
import {
  isFinishedEvent,
  type EngineEvent,
  type ExecutionFinishedEvent,
} from "@/lib/execution/events";
import type { Workflow } from "@/lib/workflow/types";
import { finishRun, registerRun } from "./active";
import {
  exec,
  fromJson,
  queryAll,
  queryOne,
} from "./db";
import {
  emitPersisted,
  findExecutionRow,
  isTerminalStatus,
} from "./execution-store";
import { redactMessage } from "./redact";

/**
 * The queue job processor — one execution, start to finish.
 *
 * Contract:
 *  - The database is the source of truth; the job only carries an id.
 *  - Entering an execution is a single guarded UPDATE (`queued` →
 *    `running`), so a duplicate delivery can never run the same
 *    execution twice.
 *  - Anything that cannot be reconciled (unknown execution, missing
 *    workflow version) throws {@link FatalJobError} and is never
 *    retried; everything else settles the execution with a terminal
 *    event so history never lies.
 */

/** Non-retryable job failure — the transport must not re-run it. */
export class FatalJobError extends Error {
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "FatalJobError";
    this.detail = detail;
  }
}

export interface JobContext {
  /** Number of previous delivery attempts (BullMQ `attemptsMade`). */
  attempt?: number;
}

export type JobOutcome =
  | "completed" /* ran to a terminal event */
  | "skipped" /* already settled or owned elsewhere */
  | "interrupted"; /* started before, no terminal — sweeper decides */

const RUNNING_CLAIM =
  "UPDATE executions SET status = 'running' WHERE id = ? AND status = 'queued'";

function terminalEvent(
  executionId: string,
  at: number,
  startedAt: number,
  metadata: Record<string, unknown>,
  error: ExecutionFinishedEvent["error"],
): ExecutionFinishedEvent {
  return {
    type: "execution.failed",
    executionId,
    status: "failed",
    durationMs: Math.max(at - startedAt, 0),
    output: null,
    error,
    metadata: { ...metadata, finalizedBy: "worker" },
    completedAt: new Date(at).toISOString(),
    at,
  };
}

export async function processExecutionJob(
  job: ExecutionJob,
  context: JobContext = {},
): Promise<JobOutcome> {
  const { executionId } = job;

  let row = findExecutionRow(executionId);
  if (!row) {
    throw new FatalJobError(
      `Execution ${executionId} no longer exists.`,
      "The execution row was deleted after the job was enqueued.",
    );
  }
  if (isTerminalStatus(row.status)) return "skipped";

  /* Load the definition before claiming: a data problem must never
     consume the claim or leave a half-started run behind. */
  const version = queryOne<{
    definition: string;
    workflow_id: string;
    workspace_id: string;
  }>(
    "SELECT definition, workflow_id, workspace_id FROM workflow_versions WHERE id = ?",
    row.workflow_version_id,
  );
  if (!version) {
    throw new FatalJobError(
      `Workflow version ${row.workflow_version_id} is missing.`,
      "The execution points at a workflow version that no longer exists.",
    );
  }
  /* Tenant integrity: the version a run executes must belong to the
     same workflow and the same workspace as the execution row. A
     tampered row could otherwise load another tenant's definition. */
  if (
    version.workspace_id !== row.workspace_id ||
    version.workflow_id !== row.workflow_id
  ) {
    throw new FatalJobError(
      `Workflow version ${row.workflow_version_id} belongs to another workspace.`,
      "The execution references a workflow version outside its workspace.",
    );
  }

  let definition: Workflow;
  try {
    definition = JSON.parse(version.definition) as Workflow;
  } catch (error) {
    throw new FatalJobError(
      `Workflow version ${row.workflow_version_id} could not be parsed.`,
      redactMessage(error instanceof Error ? error.message : "invalid JSON"),
    );
  }

  /* --- claim ------------------------------------------------------- */
  if (exec(RUNNING_CLAIM, executionId) === 0) {
    row = findExecutionRow(executionId);
    if (!row || isTerminalStatus(row.status)) return "skipped";

    const started = queryOne<{ one: number }>(
      "SELECT 1 AS one FROM execution_events WHERE execution_id = ? AND type = 'execution.started'",
      executionId,
    );
    if (started) {
      /* Engine began earlier without settling: another worker owns it,
         or that worker died. Never restart a half-run — the sweeper
         finalises it once the job is provably gone. */
      return "interrupted";
    }

    /* No engine start: the previous attempt died before the engine
       began (a retry). Re-claim and run for real. */
    if ((context.attempt ?? 0) === 0) {
      /* First delivery lost the race — someone else just claimed it. */
      return "skipped";
    }
    if (
      exec(
        "UPDATE executions SET status = 'running' WHERE id = ? AND status NOT IN ('completed','failed','cancelled')",
        executionId,
      ) === 0
    ) {
      return "skipped";
    }
    row = findExecutionRow(executionId)!;
  }

  const metadata = fromJson<Record<string, unknown>>(row.metadata, {});
  const stepTimeoutMs = numberOr(metadata.stepTimeoutMs, 15_000);
  const maxAttempts = numberOr(metadata.maxAttempts, 1);
  const startedAt = row.started_at;

  /* --- watch this run --------------------------------------------- */
  const controller = new AbortController();
  registerRun(executionId, {
    controller,
    startedAt,
    workflowId: row.workflow_id,
    workspaceId: row.workspace_id,
  });

  const cancelPoll = setInterval(() => {
    const fresh = findExecutionRow(executionId);
    if (!fresh || fresh.cancel_requested) controller.abort();
  }, cancelPollMs());
  cancelPoll.unref?.();

  const budgetMs = executionTimeoutMs();
  let remaining = budgetMs;
  let lastTick = Date.now();
  let timedOut = false;
  const watchdog =
    budgetMs > 0
      ? setInterval(() => {
          const tick = Date.now();
          const fresh = findExecutionRow(executionId);
          /* Paused while `waiting` — a 24h delay is not a stuck run. */
          if (fresh && fresh.status !== "waiting") {
            remaining -= tick - lastTick;
            if (remaining <= 0 && !timedOut) {
              timedOut = true;
              controller.abort();
            }
          }
          lastTick = tick;
        }, 1_000)
      : null;
  watchdog?.unref?.();

  let sawTerminal = false;
  const emit = (event: EngineEvent): void => {
    let out: EngineEvent = event;
    if (timedOut && isFinishedEvent(event) && event.status === "cancelled") {
      out = {
        ...event,
        type: "execution.failed",
        status: "failed",
        error: {
          code: "EXECUTION_TIMEOUT",
          message: `The execution exceeded its ${Math.round(budgetMs / 1000)}s limit and was stopped.`,
          detail: "Raise KLYZ_EXECUTION_TIMEOUT_MS or split the workflow into smaller runs.",
        },
      } satisfies ExecutionFinishedEvent;
    }
    if (isFinishedEvent(out)) sawTerminal = true;
    emitPersisted(executionId, out);
  };

  try {
    await executeWorkflow({
      executionId,
      workspaceId: row.workspace_id,
      workflow: definition,
      workflowVersionId: row.workflow_version_id,
      workflowVersion: row.workflow_version,
      input: fromJson<unknown>(row.input, null),
      retry: { maxAttempts },
      stepTimeoutMs,
      signal: controller.signal,
      source: typeof metadata.source === "string" ? metadata.source : undefined,
      emit,
    });
  } catch (error) {
    if (!sawTerminal) {
      const at = Date.now();
      emitPersisted(
        executionId,
        terminalEvent(executionId, at, startedAt, metadata, {
          code: "ENGINE_ERROR",
          message: "The run stopped unexpectedly.",
          detail: redactMessage(
            error instanceof Error ? error.message : "The engine hit an unexpected error.",
          ),
          hint: "Check the step that ran last and try again.",
        }),
      );
      sawTerminal = true;
    }
  } finally {
    clearInterval(cancelPoll);
    if (watchdog) clearInterval(watchdog);
    finishRun(executionId);
  }

  return sawTerminal ? "completed" : "interrupted";
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/* ------------------------------------------------------------------ */
/* Sweeper                                                             */
/* ------------------------------------------------------------------ */

export interface SweepResult {
  inspected: number;
  requeued: string[];
  finalized: Array<{ executionId: string; reason: string }>;
}

interface PendingRow {
  id: string;
  status: string;
  started_at: number;
  cancel_requested: number;
}

const LIVE_JOB_STATES = new Set(["waiting", "active", "delayed"]);

/**
 * Reconcile executions against the queue.
 *
 * Runs on a timer inside the worker. It is the backstop for every
 * transport-level failure mode: a lost Redis key (execution stuck in
 * `queued`), a worker that died mid-run (`running` with no live job)
 * and retries that were exhausted. Nothing here invents success — a
 * run that cannot be proven alive ends as a failure with a stated
 * reason.
 */
export async function sweepExecutions(options: {
  state: (executionId: string) => Promise<string>;
  enqueue: (job: ExecutionJob) => Promise<void>;
  /** Grace period before a live-looking state is treated as lost. */
  staleMs?: number;
  now?: number;
}): Promise<SweepResult> {
  const staleMs = options.staleMs ?? 60_000;
  const now = options.now ?? Date.now();
  const result: SweepResult = { inspected: 0, requeued: [], finalized: [] };

  const rows: PendingRow[] = [
    ...pendingRows("queued"),
    ...pendingRows("running"),
    ...pendingRows("waiting"),
  ];

  for (const row of rows) {
    result.inspected += 1;
    const jobState = await options.state(row.id);
    if (LIVE_JOB_STATES.has(jobState)) continue;

    const age = now - row.started_at;

    if (row.status === "queued") {
      if (jobState === "completed" || jobState === "failed") {
        finalizeLost(
          row.id,
          "QUEUE_LOST",
          jobState === "failed"
            ? "The queued job failed before the workflow could run."
            : "The queued job was settled before the workflow could run.",
        );
        result.finalized.push({ executionId: row.id, reason: "QUEUE_LOST" });
        continue;
      }
      if (age < staleMs) continue;
      try {
        await options.enqueue({ executionId: row.id });
        result.requeued.push(row.id);
      } catch {
        /* transport unreachable — try again on the next sweep */
      }
      continue;
    }

    /* running / waiting with no live job behind it */
    if (jobState === "unknown" && age < staleMs) continue;
    if (row.cancel_requested) {
      finalizeLost(row.id, "CANCELLED", "Execution cancelled.");
      result.finalized.push({ executionId: row.id, reason: "CANCELLED" });
      continue;
    }
    finalizeLost(
      row.id,
      "WORKER_LOST",
      "The worker running this execution stopped before it finished.",
    );
    result.finalized.push({ executionId: row.id, reason: "WORKER_LOST" });
  }

  return result;
}

function pendingRows(status: string): PendingRow[] {
  return queryAll<PendingRow>(
    "SELECT id, status, started_at, cancel_requested FROM executions WHERE status = ?",
    status,
  );
}

function finalizeLost(executionId: string, code: string, message: string): void {
  const row = findExecutionRow(executionId);
  if (!row || isTerminalStatus(row.status)) return;
  const at = Date.now();
  const metadata = {
    ...fromJson<Record<string, unknown>>(row.metadata, {}),
    finalizedBy: "sweeper",
  };
  const base = {
    executionId,
    durationMs: Math.max(at - row.started_at, 0),
    output: fromJson<unknown>(row.output, null),
    metadata,
    completedAt: new Date(at).toISOString(),
    at,
  };

  const event: ExecutionFinishedEvent =
    code === "CANCELLED"
      ? {
          ...base,
          type: "execution.cancelled",
          status: "cancelled",
          error: { code: "CANCELLED", message },
        }
      : {
          ...base,
          type: "execution.failed",
          status: "failed",
          error: {
            code,
            message,
            detail:
              "No worker reported progress for this execution, so it was closed as failed instead of being left open.",
            hint: "Check the worker logs and re-run the workflow.",
          },
        };

  emitPersisted(executionId, event);
}
