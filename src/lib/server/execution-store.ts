import type {
  ExecutionError,
  ExecutionStatus,
  NodeStatus,
} from "@/lib/workflow/types";
import type { EngineEvent } from "@/lib/execution/events";
import type {
  ExecutionDetail,
  ExecutionStepView,
  ExecutionView,
} from "@/lib/execution/types";
import { fromJson, iso, queryAll, queryOne, run as sqlRun, toJson } from "./db";
import { HttpError } from "./http";
import { publishEvent } from "./realtime";
import { redact } from "./redact";
import type { Actor } from "./identity";

/**
 * Execution persistence — rows in, views out.
 *
 * The API service and the queue worker are two doors into the same
 * durable state; this module is the room behind both. Keeping the row
 * mapping and the event → SQL folding in one place is what guarantees
 * an execution looks identical no matter which process ran it.
 */

export interface ExecutionRow {
  id: string;
  workspace_id: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version_id: string;
  workflow_version: number;
  status: string;
  trigger_type: string;
  trigger_label: string;
  source: string;
  started_at: number;
  completed_at: number | null;
  duration_ms: number;
  input: string | null;
  output: string | null;
  error: string | null;
  note: string | null;
  metadata: string | null;
  step_count: number;
  failed_step_count: number;
  cancel_requested: number;
}

export interface StepRow {
  id: string;
  execution_id: string;
  seq: number;
  node_id: string;
  node_type: string;
  node_label: string;
  ref: string;
  status: string;
  attempt: number;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number;
  input: string | null;
  output: string | null;
  error: string | null;
  branch: string | null;
  metadata: string | null;
}

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

/**
 * Read-time redaction.
 *
 * Events are scrubbed on the way *into* the store (see `emitPersisted`);
 * this is the second pass on the way out, so a row written before a rule
 * existed — or by another process — still cannot leak a credential.
 */
function scrubbed(value: unknown): unknown {
  return value === null || value === undefined ? value : redact(value);
}

/**
 * Payloads are stored *and* streamed, so one 50 MB API response would
 * bloat the database and freeze the data viewer. Anything over the cap
 * becomes a small marker with a short preview.
 */
const MAX_PAYLOAD_CHARS = 200_000;

export function bounded(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const text = toJson(value);
  if (!text || text.length <= MAX_PAYLOAD_CHARS) return value;
  return {
    __truncated: true,
    bytes: text.length,
    notice: `This payload was ${text.length} characters — only a preview is kept.`,
    preview: text.slice(0, 2_000),
  };
}

export function stepRowToView(row: StepRow): ExecutionStepView {
  return {
    id: row.id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    nodeLabel: row.node_label,
    ref: row.ref,
    status: row.status as NodeStatus,
    attempt: row.attempt,
    startedAtMs: row.started_at,
    completedAtMs: row.completed_at,
    durationMs: row.duration_ms,
    input: scrubbed(fromJson<Record<string, unknown> | null>(row.input, null)) as
      | Record<string, unknown>
      | null,
    output: scrubbed(fromJson<Record<string, unknown> | null>(row.output, null)) as
      | Record<string, unknown>
      | null,
    error: row.error
      ? (scrubbed(fromJson<ExecutionError | undefined>(row.error, undefined)) as
          | ExecutionError
          | undefined)
      : undefined,
    metadata: row.metadata
      ? (scrubbed(fromJson<Record<string, unknown> | null>(row.metadata, null)) as
          | Record<string, unknown>
          | null)
      : null,
    branch: row.branch,
  };
}

export function rowToView(row: ExecutionRow): ExecutionView {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    status: row.status as ExecutionStatus,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: iso(row.completed_at),
    durationMs: row.duration_ms,
    trigger: { type: row.trigger_type, label: row.trigger_label },
    source:
      row.source === "seed"
        ? "seed"
        : row.source === "webhook"
          ? "webhook"
          : row.source === "schedule"
            ? "schedule"
            : "manual",
    stepCount: row.step_count,
    failedStepCount: row.failed_step_count,
    error: row.error
      ? (scrubbed(fromJson<ExecutionError | undefined>(row.error, undefined)) as
          | ExecutionError
          | undefined)
      : undefined,
    cancelRequested: row.cancel_requested === 1,
    note: row.note ?? undefined,
  };
}

export function rowToDetail(row: ExecutionRow, steps: ExecutionStepView[]): ExecutionDetail {
  return {
    ...rowToView(row),
    input: scrubbed(fromJson<unknown>(row.input, null)),
    output: scrubbed(fromJson<unknown>(row.output, null)),
    workflowVersion: row.workflow_version,
    workflowVersionId: row.workflow_version_id,
    metadata: (scrubbed(fromJson<Record<string, unknown>>(row.metadata, {})) ??
      {}) as Record<string, unknown>,
    steps,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function findExecutionRow(executionId: string): ExecutionRow | undefined {
  return queryOne<ExecutionRow>("SELECT * FROM executions WHERE id = ?", executionId);
}

export function getOwnedRow(actor: Actor, executionId: string): ExecutionRow {
  const row = queryOne<ExecutionRow>(
    "SELECT * FROM executions WHERE id = ? AND workspace_id = ?",
    executionId,
    actor.workspaceId,
  );
  if (!row) {
    throw new HttpError(404, "NOT_FOUND", "That execution does not exist.");
  }
  return row;
}

export function stepsFor(executionId: string): ExecutionStepView[] {
  return queryAll<StepRow>(
    "SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY seq ASC",
    executionId,
  ).map(stepRowToView);
}

/* ------------------------------------------------------------------ */
/* Event persistence                                                   */
/* ------------------------------------------------------------------ */

/**
 * Fold one engine event into the database.
 *
 * Synchronous on purpose: the engine's emit contract is synchronous,
 * and SQLite gives us a transaction-free but atomic single-statement
 * fold per event type.
 */

/** Read the step's current metadata, merge, and return the stored JSON. */
function mergeStepMetadata(
  stepId: string,
  incoming: Record<string, unknown> | undefined,
): string | null {
  const row = queryOne<{ metadata: string | null }>(
    "SELECT metadata FROM execution_steps WHERE id = ?",
    stepId,
  );
  const base = row?.metadata
    ? fromJson<Record<string, unknown>>(row.metadata, {})
    : {};
  const merged = { ...base, ...(incoming ?? {}) };
  return Object.keys(merged).length > 0 ? toJson(bounded(merged)) : null;
}

/** Append one retry to the step's attempt log (bounded so a flapping
 *  upstream cannot grow a row without limit). */
function mergeRetry(stepId: string, entry: Record<string, unknown>): string | null {
  const row = queryOne<{ metadata: string | null }>(
    "SELECT metadata FROM execution_steps WHERE id = ?",
    stepId,
  );
  const base = row?.metadata
    ? fromJson<Record<string, unknown>>(row.metadata, {})
    : {};
  const existing = Array.isArray(base.retries) ? base.retries : [];
  const retries = existing.length >= 10 ? existing.slice(-9) : existing.slice();
  retries.push(entry);
  return toJson(bounded({ ...base, retries }));
}

export function persistEvent(event: EngineEvent): void {
  sqlRun(
    "INSERT INTO execution_events (execution_id, type, at, data) VALUES (?, ?, ?, ?)",
    event.executionId,
    event.type,
    event.at,
    toJson(event) ?? "{}",
  );

  switch (event.type) {
    case "execution.started":
      sqlRun(
        "UPDATE executions SET status = 'running', workflow_name = ?, workflow_version_id = ?, workflow_version = ?, started_at = ? WHERE id = ? AND status NOT IN ('completed','failed','cancelled')",
        event.workflowName,
        event.workflowVersionId,
        event.workflowVersion,
        Date.parse(event.startedAt),
        event.executionId,
      );
      return;

    case "execution.status":
      sqlRun(
        "UPDATE executions SET status = ? WHERE id = ? AND status NOT IN ('completed','failed','cancelled')",
        event.status,
        event.executionId,
      );
      return;

    case "execution.node.started": {
      const step = event.step;
      const seq =
        (queryOne<{ next: number }>(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM execution_steps WHERE execution_id = ?",
          event.executionId,
        )?.next ?? 1);
      sqlRun(
        `INSERT INTO execution_steps
          (id, execution_id, seq, node_id, node_type, node_label, ref, status,
           attempt, started_at, completed_at, duration_ms, input, output, error, branch, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL, 0, ?, NULL, NULL, NULL, NULL)`,
        step.id,
        event.executionId,
        seq,
        step.nodeId,
        step.nodeType,
        step.nodeLabel,
        step.ref,
        step.attempt,
        step.startedAtMs,
        toJson(bounded(step.input)) ?? null,
      );
      return;
    }

    case "execution.node.completed":
      sqlRun(
        `UPDATE execution_steps
           SET status = 'completed', completed_at = ?, duration_ms = ?, output = ?,
               branch = ?, attempt = ?, error = NULL, metadata = ?
         WHERE id = ?`,
        event.at,
        event.durationMs,
        toJson(bounded(event.output)) ?? null,
        event.branch,
        event.attempt,
        mergeStepMetadata(event.stepId, event.metadata),
        event.stepId,
      );
      return;

    case "execution.node.retrying":
      /* Not settled: the step is mid-backoff, so only the attempt, the
         last error and the attempt log move. Status stays `running` with
         an error attached — which is how the debugger tells "retrying"
         from "still going" on a page that reloads mid-backoff. */
      sqlRun(
        `UPDATE execution_steps
           SET attempt = ?, error = ?, metadata = ?
         WHERE id = ?`,
        event.nextAttempt,
        toJson(event.error),
        mergeRetry(event.stepId, {
          attempt: event.attempt,
          nextAttempt: event.nextAttempt,
          delayMs: event.delayMs,
          code: event.error.code,
          message: event.error.message,
          at: event.at,
        }),
        event.stepId,
      );
      return;

    case "execution.node.waiting":
      sqlRun(
        "UPDATE execution_steps SET status = ? WHERE id = ?",
        event.waiting ? "waiting" : "running",
        event.stepId,
      );
      return;

    case "execution.node.failed":
      sqlRun(
        `UPDATE execution_steps
           SET status = 'failed', completed_at = ?, duration_ms = ?, error = ?,
               attempt = ?, metadata = ?, branch = NULL
         WHERE id = ?`,
        event.at,
        event.durationMs,
        toJson(event.error),
        event.attempt,
        mergeStepMetadata(event.stepId, event.metadata),
        event.stepId,
      );
      return;

    case "execution.node.skipped": {
      /* Two ways to get here: a step whose incoming edge was never
         taken (nothing was written yet), or a step that ran and then
         refused the data (a Filter — the row exists from `started`).
         Settle in place when it does, so the step is not inserted twice. */
      const started = queryOne<{ id: string }>(
        "SELECT id FROM execution_steps WHERE id = ?",
        event.stepId,
      );
      if (started) {
        sqlRun(
          `UPDATE execution_steps
             SET status = 'skipped', completed_at = ?,
                 duration_ms = MAX(0, ? - COALESCE(started_at, ?)),
                 error = NULL, branch = NULL, metadata = ?
           WHERE id = ?`,
          event.at,
          event.at,
          event.at,
          mergeStepMetadata(event.stepId, event.metadata),
          event.stepId,
        );
        return;
      }
      sqlRun(
        `INSERT INTO execution_steps
          (id, execution_id, seq, node_id, node_type, node_label, ref, status,
           attempt, started_at, completed_at, duration_ms, input, output, error, branch, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', 1, ?, ?, 0, NULL, NULL, NULL, NULL, NULL)`,
        event.stepId,
        event.executionId,
        queryOne<{ next: number }>(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM execution_steps WHERE execution_id = ?",
          event.executionId,
        )?.next ?? 1,
        event.nodeId,
        event.nodeType,
        event.nodeLabel,
        event.ref,
        event.at,
        event.at,
      );
      return;
    }

    case "execution.completed":
    case "execution.failed":
    case "execution.cancelled": {
      sqlRun(
        `UPDATE executions
           SET status = ?, completed_at = ?, duration_ms = ?, output = ?, error = ?,
               metadata = ?,
               step_count = (SELECT COUNT(*) FROM execution_steps WHERE execution_id = ?),
               failed_step_count = (SELECT COUNT(*) FROM execution_steps WHERE execution_id = ? AND status = 'failed')
         WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`,
        event.status,
        event.at,
        event.durationMs,
        toJson(event.output),
        toJson(event.error),
        toJson(event.metadata),
        event.executionId,
        event.executionId,
        event.executionId,
      );
      return;
    }

    default:
      return;
  }
}

/**
 * Persist, then fan out. Exactly once per event: either the realtime
 * relay (Redis) carries it to other processes, or — when Redis is not
 * in play — the in-process bus does. Both land on the same listeners.
 *
 * The event is redacted *before either door*: the row in SQLite and the
 * frame on the wire carry the same scrubbed payload, so there is no path
 * where a token reaches history but not the stream (or the reverse).
 */
export function emitPersisted(executionId: string, event: EngineEvent): void {
  const safe = redact(event) as EngineEvent;
  persistEvent(safe);
  publishEvent(executionId, safe);
}
