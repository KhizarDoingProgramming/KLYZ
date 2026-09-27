import { createHash, randomUUID } from "node:crypto";
import { getDefinition } from "@/lib/workflow/registry";
import { stripRuntimeState, stripWebhookSecrets } from "@/lib/workflow/sanitize";
import { errorCount, validateWorkflow } from "@/lib/workflow/validation";
import type { Workflow } from "@/lib/workflow/types";
import type { ExecutionDetail, ExecutionStepView, ExecutionView } from "@/lib/execution/types";
import { enqueueExecution, removeQueuedJob } from "@/lib/queue";
import { getRun } from "./active";
import { exec, fromJson, now, queryAll, queryOne, run as sqlRun, toJson } from "./db";
import {
  bounded,
  emitPersisted,
  getOwnedRow,
  isTerminalStatus,
  rowToDetail,
  rowToView,
  stepsFor,
  type ExecutionRow,
} from "./execution-store";
import { HttpError, isRecord, readJson } from "./http";
import {
  ensureIdentitySeed,
  requireAuthenticatedActor,
  type Actor,
} from "./identity";
import { redact, redactMessage } from "./redact";
import { ensureSeed } from "./seed";
import { ensureTriggerRow } from "./triggers";

/**
 * Execution service — the one door between the app and the engine.
 *
 * Route handlers stay thin: this module validates the graph, versions
 * the workflow, creates the execution record and puts a job on the
 * queue. The worker claims it and runs the engine (see
 * `execution-runner`), writing every event back through the same store
 * the API reads. Nothing here knows about React; nothing in the
 * browser talks to the database directly.
 */

const MAX_LIST_LIMIT = 200;
const DEFAULT_STEP_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 5;

function initServer(): void {
  ensureIdentitySeed();
  ensureSeed();
}

function shortId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* Workflow versioning                                                 */
/* ------------------------------------------------------------------ */

export interface VersionRef {
  versionId: string;
  version: number;
}

export function definitionHash(definition: Workflow): string {
  return createHash("sha256")
    .update(JSON.stringify({ nodes: definition.nodes, edges: definition.edges }))
    .digest("hex");
}

/**
 * Store an immutable version of this workflow.
 *
 * Called both by "run now" and by "publish", so a webhook delivery and
 * a manual run of the same definition share one version id.
 */
export function upsertWorkflowVersion(
  actor: Actor,
  rawDefinition: Workflow,
  createdBy?: string | null,
): VersionRef {
  /* Secrets never enter the version store — see workflow/sanitize.ts,
     and neither does the run-time colour the canvas paints on nodes:
     it would change the hash and mint a version per run. */
  const definition = stripRuntimeState(stripWebhookSecrets(rawDefinition));
  const existing = queryOne<{ workspace_id: string }>(
    "SELECT workspace_id FROM workflows WHERE id = ?",
    definition.id,
  );
  /* A workflow id owned by another workspace is indistinguishable from
     one that never existed: no existence leak, no cross-tenant write. */
  if (existing && existing.workspace_id !== actor.workspaceId) {
    throw new HttpError(404, "NOT_FOUND", "That workflow does not exist.");
  }

  const hash = definitionHash(definition);
  const latest = queryOne<{ id: string; version: number; hash: string }>(
    "SELECT id, version, hash FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1",
    definition.id,
  );

  if (latest && latest.hash === hash) {
    sqlRun(
      "UPDATE workflows SET name = ?, updated_at = ? WHERE id = ?",
      definition.name,
      now(),
      definition.id,
    );
    return { versionId: latest.id, version: latest.version };
  }

  const version = (latest?.version ?? 0) + 1;
  const versionId = `wfv_${shortId()}`;
  const timestamp = now();

  if (!existing) {
    sqlRun(
      `INSERT INTO workflows
        (id, workspace_id, name, status, trigger_type, node_count, latest_version, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      definition.id,
      actor.workspaceId,
      definition.name,
      /* A definition from an older client may omit this — a missing
         column value must not crash the write. */
      definition.triggerType ?? "trigger.manual",
      definition.nodes.length,
      version,
      timestamp,
      timestamp,
    );
    /* A definition that reached the server before its workflow row did
       still needs a trigger row, or it could never be switched off. */
    ensureTriggerRow(actor.workspaceId, definition.id, definition);
  } else {
    sqlRun(
      "UPDATE workflows SET name = ?, trigger_type = ?, node_count = ?, latest_version = ?, updated_at = ? WHERE id = ?",
      definition.name,
      definition.triggerType ?? "trigger.manual",
      definition.nodes.length,
      version,
      timestamp,
      definition.id,
    );
  }

  sqlRun(
    `INSERT INTO workflow_versions (id, workflow_id, workspace_id, version, hash, definition, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    versionId,
    definition.id,
    actor.workspaceId,
    version,
    hash,
    toJson(definition) ?? "{}",
    timestamp,
    createdBy ?? null,
  );

  return { versionId, version };
}

/**
 * Make a version the one this workflow runs from.
 *
 * `upsertWorkflowVersion` decides *what* the immutable row looks like;
 * this decides that the workflow now points at it. Keeping the two
 * apart lets a webhook endpoint, an explicit publish and a run share
 * one content-addressed version without any of them writing to
 * `workflow_versions` twice.
 */
export function publishDefinition(actor: Actor, definition: Workflow): VersionRef {
  const ref = upsertWorkflowVersion(actor, definition, actor.userId);
  sqlRun(
    `UPDATE workflows
        SET published_version_id = ?, published_version = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
    ref.versionId,
    ref.version,
    now(),
    definition.id,
    actor.workspaceId,
  );
  return ref;
}

/* ------------------------------------------------------------------ */
/* Input parsing                                                       */
/* ------------------------------------------------------------------ */

export function parseDefinition(value: unknown): Workflow {
  if (!isRecord(value)) {
    throw new HttpError(400, "BAD_DEFINITION", "A workflow definition is required.");
  }
  const { id, name, nodes, edges } = value;
  if (typeof id !== "string" || !id) {
    throw new HttpError(400, "BAD_DEFINITION", "The workflow id is missing.");
  }
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new HttpError(
      400,
      "BAD_DEFINITION",
      "The workflow must include nodes and edges.",
    );
  }
  return {
    ...(value as unknown as Workflow),
    id,
    name: typeof name === "string" && name ? name : "Untitled workflow",
    nodes: nodes as Workflow["nodes"],
    edges: edges as Workflow["edges"],
  };
}

/** Validate a definition and throw a 422 with per-node issues if unusable. */
export function assertRunnable(definition: Workflow): void {
  if (definition.nodes.length === 0) {
    throw new HttpError(422, "EMPTY_WORKFLOW", "This workflow has no steps yet.", {
      issues: [
        {
          id: "empty",
          severity: "error",
          message: "This workflow has no steps.",
          hint: "Add a trigger and at least one step.",
        },
      ],
    });
  }
  const issues = validateWorkflow(definition);
  if (errorCount(issues) > 0) {
    throw new HttpError(422, "VALIDATION_FAILED", "This workflow cannot run yet.", {
      issues,
    });
  }
}

interface StartOptions {
  maxAttempts: number;
  stepTimeoutMs: number;
}

function parseOptions(value: unknown): StartOptions {
  const record = isRecord(value) ? value : {};
  const maxAttemptsRaw = Number(record.maxAttempts);
  const timeoutRaw = Number(record.stepTimeoutMs);
  return {
    maxAttempts: Number.isFinite(maxAttemptsRaw)
      ? Math.min(Math.max(Math.trunc(maxAttemptsRaw), 1), MAX_ATTEMPTS)
      : 1,
    stepTimeoutMs: Number.isFinite(timeoutRaw)
      ? Math.min(Math.max(Math.trunc(timeoutRaw), 100), 600_000)
      : DEFAULT_STEP_TIMEOUT_MS,
  };
}

/* ------------------------------------------------------------------ */
/* Starting a run                                                      */
/* ------------------------------------------------------------------ */

export interface RunParams {
  definition: Workflow;
  input?: unknown;
  source?: ExecutionSource;
  options?: unknown;
  /** Overrides taken from the definition's trigger, when a caller knows better. */
  trigger?: { type?: string; label?: string };
}

/** The three ways a run can be attributed in history. */
export type ExecutionSource = "manual" | "webhook" | "schedule";

export interface PinnedRunParams {
  /** The already-versioned definition. Never re-versioned by this call. */
  definition: Workflow;
  versionId: string;
  version: number;
  input?: unknown;
  source: ExecutionSource;
  trigger?: { type?: string; label?: string };
  options?: unknown;
  /** Trigger bookkeeping carried into `executions.metadata`. */
  triggerId?: string | null;
  occurrenceKey?: string | null;
}

/**
 * Create the execution row, version the workflow and enqueue it.
 *
 * Shared by the run endpoint and by the webhook receiver — both must
 * produce exactly the same record so history stays uniform.
 */
export async function startWorkflowRun(
  actor: Actor,
  params: RunParams,
): Promise<ExecutionDetail> {
  initServer();

  const definition = params.definition;
  assertRunnable(definition);
  const options = parseOptions(params.options);
  const version = upsertWorkflowVersion(actor, definition);

  return createExecutionRow(actor, {
    definition,
    versionId: version.versionId,
    version: version.version,
    input: params.input,
    options,
    source: params.source ?? "manual",
    trigger: params.trigger,
  });
}

/**
 * Queue a run against a version that already exists.
 *
 * Used by every automatic trigger — a webhook delivery or a scheduled
 * occurrence must run exactly what was published, and must never
 * publish anything itself. There is no `upsertWorkflowVersion` on this
 * path by construction: the trigger cannot invent a version.
 */
export async function startPinnedRun(
  actor: Actor,
  params: PinnedRunParams,
): Promise<ExecutionDetail> {
  initServer();
  return createExecutionRow(actor, {
    definition: params.definition,
    versionId: params.versionId,
    version: params.version,
    input: params.input,
    options: parseOptions(params.options),
    source: params.source,
    trigger: params.trigger,
    triggerId: params.triggerId,
    occurrenceKey: params.occurrenceKey,
  });
}

interface ExecutionRowParams {
  definition: Workflow;
  versionId: string;
  version: number;
  input?: unknown;
  options: ReturnType<typeof parseOptions>;
  source: ExecutionSource;
  trigger?: { type?: string; label?: string };
  triggerId?: string | null;
  occurrenceKey?: string | null;
}

async function createExecutionRow(
  actor: Actor,
  params: ExecutionRowParams,
): Promise<ExecutionDetail> {
  const { definition, versionId, version, options, source } = params;

  const executionId = `ex_${shortId()}`;
  const startedAt = now();
  const triggerType =
    params.trigger?.type ||
    definition.triggerType ||
    definition.nodes.find((node) => getDefinition(node.type)?.trigger)?.type ||
    "trigger.manual";
  const triggerLabel =
    params.trigger?.label ?? getDefinition(triggerType)?.title ?? "Trigger";

  const metadata: Record<string, unknown> = {
    requestedBy: actor.userId,
    stepTimeoutMs: options.stepTimeoutMs,
    maxAttempts: options.maxAttempts,
    source,
  };
  if (params.triggerId) metadata.triggerId = params.triggerId;
  if (params.occurrenceKey) metadata.occurrenceKey = params.occurrenceKey;

  sqlRun(
    `INSERT INTO executions
      (id, workspace_id, workflow_id, workflow_name, workflow_version_id, workflow_version,
       status, trigger_type, trigger_label, source, started_at, completed_at, duration_ms,
       input, output, error, note, metadata, step_count, failed_step_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, NULL, 0, ?, NULL, NULL, NULL, ?, 0, 0, ?)`,
    executionId,
    actor.workspaceId,
    definition.id,
    definition.name,
    versionId,
    version,
    triggerType,
    triggerLabel,
    source,
    startedAt,
    /* Run input is user data and may carry a token a trigger pasted in:
       it is scrubbed before it ever reaches the row. */
    toJson(bounded(redact(params.input ?? null))),
    toJson(metadata),
    startedAt,
  );

  try {
    await enqueueExecution({ executionId });
  } catch (error) {
    const at = now();
    emitPersisted(executionId, {
      type: "execution.failed",
      executionId,
      status: "failed",
      durationMs: 0,
      output: null,
      error: {
        code: "QUEUE_UNAVAILABLE",
        message: "Execution could not be queued.",
        detail: redactMessage(
          error instanceof Error ? error.message : "The execution queue is unreachable.",
        ),
        hint: "Check that Redis is running and try again.",
      },
      metadata: { requestedBy: actor.userId, source, finalizedBy: "api" },
      completedAt: new Date(at).toISOString(),
      at,
    });
    throw new HttpError(
      503,
      "QUEUE_UNAVAILABLE",
      "Execution could not be queued.",
      { detail: "The execution queue is unreachable. Start Redis and try again." },
    );
  }

  return getExecutionDetailById(actor, executionId);
}

export async function startExecution(
  request: Request,
  workflowId: string,
): Promise<ExecutionDetail> {
  const actor = resolveRequestActor(request);
  return startExecutionFor(actor, workflowId, await readJson(request));
}

/**
 * Actor-based start — used by route handlers and by tests/server code
 * that already resolved an actor (no HTTP request in sight).
 */
export async function startExecutionFor(
  actor: Actor,
  workflowId: string,
  body: unknown,
): Promise<ExecutionDetail> {
  if (!isRecord(body)) {
    throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
  }
  const definition = parseDefinition(body.definition);
  if (definition.id !== workflowId) {
    throw new HttpError(
      400,
      "ID_MISMATCH",
      "The definition does not match the workflow in the URL.",
    );
  }
  return startWorkflowRun(actor, { definition, input: body.input, options: body.options });
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function listExecutions(
  request: Request,
  query: URLSearchParams,
): { executions: ExecutionView[]; total: number } {
  return listExecutionsFor(resolveRequestActor(request), query);
}

/** Actor-based listing — shared by routes, tests and server pages. */
export function listExecutionsFor(
  actor: Actor,
  query: URLSearchParams,
): { executions: ExecutionView[]; total: number } {
  initServer();

  const clauses = ["workspace_id = ?"];
  const params: Array<string | number> = [actor.workspaceId];

  const workflowId = query.get("workflowId");
  if (workflowId) {
    clauses.push("workflow_id = ?");
    params.push(workflowId);
  }
  const status = query.get("status");
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  } else if (query.get("active") === "1") {
    clauses.push("status IN ('queued', 'running', 'waiting')");
  }
  const source = query.get("source");
  if (source === "seed" || source === "manual" || source === "webhook") {
    clauses.push("source = ?");
    params.push(source);
  }

  /* `query.get` returns `null` when the parameter is absent, and
     `Number(null)` is `0` — a missing `limit` must mean "the default",
     not "one row". */
  const limitParam = query.get("limit");
  const limitRaw = limitParam === null ? Number.NaN : Number(limitParam);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_LIST_LIMIT)
    : 50;

  const where = clauses.join(" AND ");
  const total =
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM executions WHERE ${where}`,
      ...params,
    )?.total ?? 0;
  const rows = queryAll<ExecutionRow>(
    `SELECT * FROM executions WHERE ${where} ORDER BY started_at DESC LIMIT ?`,
    ...params,
    limit,
  );

  return { executions: rows.map(rowToView), total };
}

export function getExecutionDetail(request: Request, executionId: string): ExecutionDetail {
  return getExecutionDetailFor(resolveRequestActor(request), executionId);
}

/** Actor-based detail — shared by routes, tests and server pages. */
export function getExecutionDetailFor(actor: Actor, executionId: string): ExecutionDetail {
  initServer();
  return getExecutionDetailById(actor, executionId);
}

function getExecutionDetailById(actor: Actor, executionId: string): ExecutionDetail {
  const row = getOwnedRow(actor, executionId);
  return rowToDetail(row, stepsFor(executionId));
}

export function getExecutionSteps(
  request: Request,
  executionId: string,
): { steps: ExecutionStepView[] } {
  initServer();
  const actor = resolveRequestActor(request);
  getOwnedRow(actor, executionId);
  return { steps: stepsFor(executionId) };
}

/* ------------------------------------------------------------------ */
/* The graph a run used                                                */
/* ------------------------------------------------------------------ */

export interface ExecutionDefinitionView {
  workflowId: string;
  workflowVersion: number;
  workflowVersionId: string;
  name: string;
  nodes: Workflow["nodes"];
  edges: Workflow["edges"];
}

function versionDefinition(row: ExecutionRow): Workflow {
  const version = queryOne<{ definition: string }>(
    "SELECT definition FROM workflow_versions WHERE id = ?",
    row.workflow_version_id,
  );
  if (!version) {
    throw new HttpError(
      404,
      "VERSION_MISSING",
      "The workflow version this run used no longer exists.",
      { detail: "Only the run record survived — the graph cannot be replayed." },
    );
  }
  try {
    return JSON.parse(version.definition) as Workflow;
  } catch {
    throw new HttpError(
      500,
      "VERSION_UNREADABLE",
      "The stored workflow version could not be read.",
    );
  }
}

/**
 * The graph *behind* a run.
 *
 * An execution row stores what happened (steps), not the canvas it
 * happened on — so the debugger asks for the immutable version the run
 * pinned, and can draw the real graph instead of a flat list.
 */
export function getExecutionDefinitionFor(
  actor: Actor,
  executionId: string,
): ExecutionDefinitionView {
  initServer();
  const row = getOwnedRow(actor, executionId);
  const definition = versionDefinition(row);
  return {
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    workflowVersionId: row.workflow_version_id,
    name: definition.name,
    nodes: definition.nodes,
    edges: definition.edges,
  };
}

export function getExecutionDefinition(
  request: Request,
  executionId: string,
): ExecutionDefinitionView {
  return getExecutionDefinitionFor(resolveRequestActor(request), executionId);
}

/* ------------------------------------------------------------------ */
/* Re-running                                                           */
/* ------------------------------------------------------------------ */

export interface RerunBody {
  options?: { maxAttempts?: number; stepTimeoutMs?: number };
}

/**
 * Start a fresh execution from the exact version the original pinned.
 *
 * Same definition, same input, same trigger — a new row, so history
 * stays append-only. Never re-runs the old execution in place: the
 * original remains the record of what actually happened.
 */
export async function rerunExecutionFor(
  actor: Actor,
  executionId: string,
  body: RerunBody = {},
): Promise<ExecutionDetail> {
  initServer();
  const row = getOwnedRow(actor, executionId);
  const definition = versionDefinition(row);
  const stored = fromJson<Record<string, unknown>>(row.metadata, {});

  return startWorkflowRun(actor, {
    definition,
    input: fromJson<unknown>(row.input, null),
    source: row.source === "webhook" ? "webhook" : "manual",
    trigger: { type: row.trigger_type, label: row.trigger_label },
    options: {
      maxAttempts:
        typeof body.options?.maxAttempts === "number"
          ? body.options.maxAttempts
          : stored.maxAttempts,
      stepTimeoutMs:
        typeof body.options?.stepTimeoutMs === "number"
          ? body.options.stepTimeoutMs
          : stored.stepTimeoutMs,
    },
  });
}

export async function rerunExecution(
  request: Request,
  executionId: string,
): Promise<ExecutionDetail> {
  const actor = resolveRequestActor(request);
  return rerunExecutionFor(actor, executionId, await readRerunBody(request));
}

/** Rerun bodies are optional — an empty POST means "same again". */
async function readRerunBody(request: Request): Promise<RerunBody> {
  const text = await request.text().catch(() => "");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as RerunBody;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
  }
}

/* ------------------------------------------------------------------ */
/* Cancellation                                                        */
/* ------------------------------------------------------------------ */

export async function cancelExecution(
  request: Request,
  executionId: string,
): Promise<{ accepted: boolean; status: string }> {
  return cancelExecutionFor(resolveRequestActor(request), executionId);
}

/**
 * Ask an execution to stop.
 *
 * Three cases, all of them real:
 *  - running in *this* process → abort the controller directly;
 *  - running elsewhere (the worker) → set `cancel_requested`, which the
 *    worker's poll turns into an abort within a second;
 *  - still queued → take it off the queue and settle it now.
 */
export async function cancelExecutionFor(
  actor: Actor,
  executionId: string,
): Promise<{ accepted: boolean; status: string }> {
  initServer();
  const row = getOwnedRow(actor, executionId);

  if (isTerminalStatus(row.status)) {
    throw new HttpError(
      409,
      "ALREADY_FINISHED",
      `This execution already finished with status "${row.status}".`,
    );
  }

  sqlRun(
    "UPDATE executions SET cancel_requested = 1 WHERE id = ?",
    executionId,
  );

  const active = getRun(executionId);
  if (active) {
    active.controller.abort();
    return { accepted: true, status: row.status };
  }

  if (row.status === "queued") {
    /* Still waiting for a worker: settle it here, synchronously, so the
       caller does not have to poll for an execution it just cancelled. */
    const removed = await removeQueuedJob(executionId).catch(() => false);
    const stillQueued = exec(
      "UPDATE executions SET status = 'running' WHERE id = ? AND status = 'queued'",
      executionId,
    );
    if (stillQueued === 1) {
      const at = now();
      emitPersisted(executionId, {
        type: "execution.cancelled",
        executionId,
        status: "cancelled",
        durationMs: Math.max(at - row.started_at, 0),
        output: null,
        error: { code: "CANCELLED", message: "Execution cancelled before it started." },
        metadata: { requestedBy: actor.userId, cancelledWhile: "queued", queueRemoved: removed },
        completedAt: new Date(at).toISOString(),
        at,
      });
    }
    const after = getOwnedRow(actor, executionId);
    return { accepted: true, status: after.status };
  }

  /* Running (or waiting) under the worker: it will stop on its own. */
  return { accepted: true, status: row.status };
}

function resolveRequestActor(request: Request): Actor {
  /* Cookie-backed session identity + membership: the header is only a
     workspace *selection* hint and is verified against membership. */
  return requireAuthenticatedActor(request);
}
