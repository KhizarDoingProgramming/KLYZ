import { randomBytes } from "node:crypto";
import {
  exec,
  fromJson,
  iso,
  now,
  queryAll,
  queryOne,
  run,
  toJson,
} from "@/lib/server/db";
import { auditAs } from "@/lib/server/audit";
import { assertWorkflowAccess, type Permission } from "@/lib/server/authz";
import { HttpError } from "@/lib/server/http";
import type { ActorLike } from "@/lib/server/authz";
import type { Actor } from "@/lib/server/identity";
import type { Workflow } from "@/lib/workflow/types";
import {
  DEFAULT_TIMEZONE,
  SCHEDULE_PRESETS,
  ScheduleError,
  compileSchedule,
  cronFromConfig,
  nextOccurrence,
  occurrenceKey,
  occurrencesBetween,
  timezoneFromConfig,
} from "@/lib/workflow/schedule";

/**
 * Triggers — how a workflow gets started by someone (or something)
 * other than a person pressing Run.
 *
 * Three shapes only: `manual`, `webhook`, `schedule`. Everything here
 * is server state: a trigger row owns the enable switch and the
 * schedule, the endpoint card owns the webhook secret, and the
 * definition in `workflow_versions` is what actually runs. The editor
 * never decides whether a workflow may fire.
 *
 * A workflow with no trigger row is treated as armed. That is the
 * migration story — rows written before this module existed keep
 * behaving exactly as they did — and it means a missing row can never
 * silently stop something that used to work. Rows created from here on
 * are explicit, and an explicit `enabled = 0` is a hard stop.
 */

export type TriggerType = "manual" | "webhook" | "schedule";

const TRIGGER_NODE_TYPES: Record<string, TriggerType> = {
  "trigger.manual": "manual",
  "trigger.webhook": "webhook",
  "trigger.schedule": "schedule",
};

const SUPPORTED = new Set<TriggerType>(["manual", "webhook", "schedule"]);

export interface TriggerFireView {
  at: string;
  status: string;
  executionId: string | null;
  error: string | null;
}

export interface TriggerScheduleView {
  cron: string;
  /** The interval the card offered (`5m`, `15m`, `1h`, `1d`) or `cron`. */
  every: string;
  timezone: string;
  nextRunAt: string | null;
  /** The next few occurrences, so the card can show what "0 9 * * 1-5" means. */
  preview: string[];
}

export interface TriggerState {
  /** True when this workflow's trigger is one of the three KLYZ manages. */
  managed: boolean;
  type: TriggerType | null;
  enabled: boolean;
  /** Will this trigger actually start a run right now? */
  armed: boolean;
  /** Why it is not armed, in words the card can show verbatim. */
  blockedBy: string | null;
  schedule: TriggerScheduleView | null;
  webhook: { enabled: boolean } | null;
  last: TriggerFireView | null;
  recent: TriggerFireView[];
  updatedAt: string | null;
}

interface TriggerRow {
  id: string;
  workflow_id: string;
  workspace_id: string;
  type: string;
  enabled: number;
  config: string;
  schedule_cron: string | null;
  schedule_timezone: string | null;
  next_run_at: number | null;
  last_fire_at: number | null;
  last_execution_id: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface WorkflowSnapshot {
  id: string;
  workspace_id: string;
  status: string;
  published_version_id: string | null;
  draft: string;
  trigger_type: string;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Which of the three managed triggers a definition declares, if any. */
export function triggerTypeOf(definition: Workflow): TriggerType | null {
  const fromField = TRIGGER_NODE_TYPES[definition.triggerType ?? ""];
  if (fromField) return fromField;
  for (const node of definition.nodes) {
    const type = TRIGGER_NODE_TYPES[node.type];
    if (type) return type;
  }
  return null;
}

/**
 * The trigger type a definition actually declares, read from its graph.
 *
 * `workflows.trigger_type` is a denormalised copy of what the canvas
 * holds, and two writers used to fill it from the optional top-level
 * `triggerType` field alone — so a definition that carried a
 * `trigger.webhook` node but no field was recorded as
 * `trigger.manual`, after which every read (the trigger card, the
 * dashboard, a toggle) reported the wrong kind of trigger.
 *
 * The node is the truth: it is what the executor dispatches on, and it
 * survives a client that round-trips only `nodes`/`edges`. The field is
 * the fallback for a definition with no trigger node yet, and `null`
 * means "this definition says nothing" so the caller can keep what it
 * already has instead of inventing a default.
 */
export function declaredTriggerType(
  definition: Pick<Workflow, "nodes" | "triggerType">,
): string | null {
  const node = definition.nodes.find(
    (candidate) => typeof candidate.type === "string" && candidate.type.startsWith("trigger."),
  );
  if (node) return node.type;
  const field = definition.triggerType;
  return typeof field === "string" && field ? field : null;
}

/**
 * The full picture for the trigger card.
 *
 * Reads only — nothing here writes, so opening the editor on a
 * workflow never changes a revision, a trigger row, or an audit log.
 */
export function readTriggerFor(
  actor: ActorLike,
  workflowId: string,
  permission: Permission = "workflow:read",
): TriggerState {
  const snapshot = workflowSnapshot(actor, workflowId, permission);
  const type = derivedType(snapshot);
  const row = getTriggerRow(workflowId);
  const state = buildState(type, row, snapshot);
  return state;
}

/**
 * Write the enable switch and (for schedules) the timing.
 *
 * Only ever touches `workflow_triggers`. The endpoint card keeps
 * owning `webhooks`, and the published definition is untouched — a
 * schedule you change now applies to the next occurrence, it never
 * rewrites what an earlier execution already pinned.
 */
export function setTriggerFor(
  actor: ActorLike,
  workflowId: string,
  body: unknown,
): TriggerState {
  const snapshot = workflowSnapshot(actor, workflowId, "workflow:write");
  const type = derivedType(snapshot);
  if (!type) {
    throw new HttpError(
      422,
      "UNSUPPORTED_TRIGGER",
      "This workflow's trigger is managed on its own endpoint card.",
    );
  }

  const input = isRecord(body) ? body : {};
  const enabled = typeof input.enabled === "boolean" ? input.enabled : undefined;

  const previous = getTriggerRow(workflowId);
  const scheduleInput = isRecord(input.schedule) ? input.schedule : null;
  /* A row can be missing (a workflow written before triggers existed,
     or one whose row was dropped). Fall back to the definition's own
     trigger node so the first write does not have to invent a cron. */
  const existingConfig = previous ? rowConfig(previous) : draftTriggerConfig(snapshot);
  let config = existingConfig;
  let cron: string | null = previous?.schedule_cron ?? null;
  let timezone: string | null = previous?.schedule_timezone ?? null;

  if (type === "schedule" && scheduleInput) {
    /* An explicit schedule write is compiled here, before anything is
       persisted: an unparseable expression or an unknown timezone is a
       422, never a row that will silently never fire. */
    const merged = { ...existingConfig, ...scheduleInput };
    try {
      const compiled = compileSchedule(merged);
      config = merged;
      cron = compiled.cron;
      timezone = compiled.timezone;
    } catch (error) {
      throw scheduleHttpError(error);
    }
  } else if (type === "schedule" && !cron && Object.keys(existingConfig).length > 0) {
    /* Toggling only, on a row whose cursor columns were never filled
       in — derive them once so a plain enable does not wipe them. */
    try {
      const compiled = compileSchedule(existingConfig);
      cron = compiled.cron;
      timezone = compiled.timezone;
    } catch {
      /* Leave them empty; `readTriggerFor` reports the bad expression
         rather than failing a toggle the user did ask for. */
    }
  }

  const nextEnabled = enabled ?? (previous ? previous.enabled === 1 : true);
  const at = now();

  if (previous) {
    run(
      `UPDATE workflow_triggers
          SET enabled = ?, config = ?, schedule_cron = ?, schedule_timezone = ?,
              next_run_at = ?, updated_at = ?
        WHERE id = ?`,
      nextEnabled ? 1 : 0,
      toJson(config) ?? "{}",
      type === "schedule" ? cron : previous.schedule_cron,
      type === "schedule" ? timezone : previous.schedule_timezone,
      /* An unchanged schedule keeps its place in the queue; a changed
         one re-derives on the next tick rather than firing the new
         expression against a stale instant. */
      type === "schedule" && previous.schedule_cron !== cron ? null : previous.next_run_at,
      at,
      previous.id,
    );
  } else {
    run(
      `INSERT INTO workflow_triggers
         (id, workflow_id, workspace_id, type, enabled, config, schedule_cron,
          schedule_timezone, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      triggerId(),
      workflowId,
      snapshot.workspace_id,
      type,
      nextEnabled ? 1 : 0,
      toJson(config) ?? "{}",
      type === "schedule" ? cron : null,
      type === "schedule" ? timezone : null,
      null,
      at,
      at,
    );
  }

  if (typeof enabled === "boolean" && enabled !== (previous?.enabled === 1)) {
    auditAs(actor, enabled ? "trigger.enabled" : "trigger.disabled", {
      resourceType: "workflow",
      resourceId: workflowId,
      metadata: { type, enabled },
    });
  }
  auditAs(actor, "trigger.updated", {
    resourceType: "workflow",
    resourceId: workflowId,
    metadata:
      type === "schedule"
        ? { type, enabled: nextEnabled, cron, timezone }
        : { type, enabled: nextEnabled },
  });

  return buildState(type, getTriggerRow(workflowId), snapshot);
}

/* ------------------------------------------------------------------ */
/* Arming                                                              */
/* ------------------------------------------------------------------ */

/**
 * Gate for a manual run.
 *
 * Manual runs keep their implicit publish — a viewer can press Run and
 * the draft is versioned first. What a disabled manual trigger stops is
 * the button, not the publish.
 */
export function assertManualTriggerArmed(actor: ActorLike, workflowId: string): void {
  const row = getTriggerRow(workflowId);
  if (!row || row.enabled === 1) return;
  if (row.workspace_id !== actor.workspaceId) return; /* tenant mismatch → the usual 404 */
  auditAs(actor, "trigger.invoked", {
    resourceType: "workflow",
    resourceId: workflowId,
    metadata: { type: row.type, outcome: "disabled" },
  });
  throw new HttpError(
    422,
    "TRIGGER_DISABLED",
    "This workflow's trigger is turned off. Turn it back on to run it.",
  );
}

/**
 * Gate for an inbound webhook delivery.
 *
 * Throws the *same* 404 a missing endpoint throws: a caller must not be
 * able to tell "no such endpoint" from "someone turned this off", or
 * the endpoint URL becomes an oracle. Returns silently when armed.
 */
export function assertWebhookTriggerArmed(workflowId: string, workspaceId: string): void {
  const row = getTriggerRow(workflowId);
  if (!row || row.enabled === 1) return;
  if (row.workspace_id !== workspaceId) return;
  throw new HttpError(404, "WEBHOOK_NOT_FOUND", "No enabled endpoint matches this URL.");
}

/* ------------------------------------------------------------------ */
/* Published definition resolution                                     */
/* ------------------------------------------------------------------ */

export interface PinnedDefinition {
  definition: Workflow;
  versionId: string;
  version: number;
}

/**
 * The published version a webhook or a schedule must run.
 *
 * Unlike a manual run there is no implicit publish here — a trigger
 * firing on behalf of a person nobody asked must never invent a
 * version. `null` means "nothing published yet" and the caller decides
 * what that costs (a webhook 404s, a scheduler tick skips the row).
 */
export function resolvePinnedDefinition(
  workflowId: string,
  workspaceId: string,
): PinnedDefinition | null {
  const pinned = queryOne<{ definition: string; id: string; version: number }>(
    `SELECT v.definition, v.id, v.version
       FROM workflows w
       JOIN workflow_versions v ON v.id = w.published_version_id
      WHERE w.id = ? AND w.workspace_id = ?`,
    workflowId,
    workspaceId,
  );
  const version =
    pinned ??
    queryOne<{ definition: string; id: string; version: number }>(
      `SELECT definition, id, version FROM workflow_versions
        WHERE workflow_id = ? AND workspace_id = ?
        ORDER BY version DESC LIMIT 1`,
      workflowId,
      workspaceId,
    );
  if (!version) return null;
  try {
    return {
      definition: JSON.parse(version.definition) as Workflow,
      versionId: version.id,
      version: version.version,
    };
  } catch {
    return null;
  }
}

export function isPublished(workflowId: string, workspaceId: string): boolean {
  const row = queryOne<{ published_version_id: string | null }>(
    "SELECT published_version_id FROM workflows WHERE id = ? AND workspace_id = ?",
    workflowId,
    workspaceId,
  );
  if (!row) return false;
  if (row.published_version_id) return true;
  const any = queryOne<{ id: string }>(
    "SELECT id FROM workflow_versions WHERE workflow_id = ? AND workspace_id = ? LIMIT 1",
    workflowId,
    workspaceId,
  );
  return !!any;
}

/* ------------------------------------------------------------------ */
/* Trigger row maintenance                                             */
/* ------------------------------------------------------------------ */

/**
 * Create the row a workflow needs in order to be controllable.
 *
 * Called when a workflow is created and when a schedule is written.
 * Idempotent: a second call on a workflow that already has a row is a
 * no-op, so it is safe to reach for from more than one creation path.
 */
export function ensureTriggerRow(
  workspaceId: string,
  workflowId: string,
  definition: Workflow,
): TriggerRow | null {
  const type = triggerTypeOf(definition);
  if (!type || !SUPPORTED.has(type)) return null;
  const existing = getTriggerRow(workflowId);
  if (existing) return existing;

  const config = triggerNodeConfig(definition);
  const at = now();
  const cron = type === "schedule" ? cronFromConfig(config) || null : null;
  const timezone = type === "schedule" ? timezoneFromConfig(config) || null : null;

  run(
    `INSERT INTO workflow_triggers
       (id, workflow_id, workspace_id, type, enabled, config, schedule_cron,
        schedule_timezone, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?)`,
    triggerId(),
    workflowId,
    workspaceId,
    type,
    toJson(config) ?? "{}",
    cron,
    timezone,
    at,
    at,
  );
  return getTriggerRow(workflowId);
}

/**
 * Turn a schedule off the moment a *copy* of it is created.
 *
 * A duplicated, imported or template-created workflow starts as a
 * draft, so nothing fires straight away — but publishing preserves the
 * enable switch exactly as it found it, and a second workflow on the
 * same expression would double production executions the first time
 * somebody published. Copying is therefore the one moment where the
 * server decides for the user: a copied schedule starts paused and the
 * owner arms it deliberately. Manual and webhook triggers are left
 * alone (a webhook copy has no endpoint row yet, and a manual copy is
 * inert until someone presses Run).
 */
export function disarmScheduleTrigger(workflowId: string): void {
  run(
    `UPDATE workflow_triggers
        SET enabled = 0, next_run_at = NULL, updated_at = ?
      WHERE workflow_id = ? AND type = 'schedule'`,
    now(),
    workflowId,
  );
}

/**
 * Bring the trigger row in line with a definition that was just
 * published.
 *
 * The schedule is authored as a node in the graph, so publishing is
 * the moment the server adopts it: `every`, `cron` and `timezone` are
 * copied across, the enable switch is left exactly as the owner set it,
 * and the cursor is cleared so the *next* occurrence is computed from
 * the *new* expression rather than the old one. A definition whose
 * trigger changed shape (schedule → webhook) is not silently
 * re-typed here — `ensureTriggerRow` created the row for the shape it
 * had, and the next publish of the new shape is what re-types it.
 */
export function syncTriggerRow(
  workspaceId: string,
  workflowId: string,
  definition: Workflow,
): TriggerRow | null {
  const row = ensureTriggerRow(workspaceId, workflowId, definition);
  if (!row) return null;

  const type = triggerTypeOf(definition);
  if (!type || type !== row.type) return row;

  const config = triggerNodeConfig(definition);
  const cron = type === "schedule" ? cronFromConfig(config) || null : null;
  const timezone = type === "schedule" ? timezoneFromConfig(config) || null : null;
  const cursorChanged = type === "schedule" && (row.schedule_cron ?? null) !== cron;

  run(
    `UPDATE workflow_triggers
        SET config = ?, schedule_cron = ?, schedule_timezone = ?,
            next_run_at = ?, updated_at = ?
      WHERE id = ?`,
    toJson(config) ?? "{}",
    cron,
    timezone,
    cursorChanged ? null : row.next_run_at,
    now(),
    row.id,
  );
  return getTriggerRow(workflowId);
}

export function getTriggerRow(workflowId: string): TriggerRow | null {
  return queryOne<TriggerRow>(
    "SELECT * FROM workflow_triggers WHERE workflow_id = ?",
    workflowId,
  ) ?? null;
}

/* ------------------------------------------------------------------ */
/* Occurrence bookkeeping                                              */
/* ------------------------------------------------------------------ */

/**
 * Claim one occurrence.
 *
 * `INSERT OR IGNORE` against a `(trigger_id, occurrence_key)` primary
 * key is the whole race story: two scheduler ticks, or a tick and a
 * manual re-fire, both try, exactly one gets a row, and only that one
 * goes on to create an execution. Returns true for the winner.
 */
export function claimOccurrence(
  row: TriggerRow,
  key: string,
  at: number = now(),
): boolean {
  const result = exec(
    `INSERT OR IGNORE INTO trigger_fires
       (trigger_id, workspace_id, workflow_id, occurrence_key, fired_at, status)
     VALUES (?, ?, ?, ?, ?, 'claimed')`,
    row.id,
    row.workspace_id,
    row.workflow_id,
    key,
    at,
  );
  return result > 0;
}

export function finishOccurrence(
  triggerId: string,
  key: string,
  outcome: { executionId?: string | null; status: string; error?: string | null },
): void {
  run(
    `UPDATE trigger_fires
        SET status = ?, execution_id = ?, error = ?
      WHERE trigger_id = ? AND occurrence_key = ?`,
    outcome.status,
    outcome.executionId ?? null,
    outcome.error ? outcome.error.slice(0, 500) : null,
    triggerId,
    key,
  );
  const at = now();
  run(
    `UPDATE workflow_triggers
        SET last_fire_at = ?, last_execution_id = ?, last_status = ?, last_error = ?, updated_at = ?
      WHERE id = ?`,
    at,
    outcome.executionId ?? null,
    outcome.status,
    outcome.error ? outcome.error.slice(0, 500) : null,
    at,
    triggerId,
  );
}

/** Move the cursor to the next occurrence after `fromMs`. */
export function advanceNextRun(row: TriggerRow, fromMs: number = now()): number | null {
  if (row.type !== "schedule") return null;
  const cron = row.schedule_cron ?? "";
  const timezone = row.schedule_timezone ?? DEFAULT_TIMEZONE;
  if (!cron) {
    run("UPDATE workflow_triggers SET next_run_at = NULL, updated_at = ? WHERE id = ?", now(), row.id);
    return null;
  }
  let next: number | null;
  try {
    next = nextOccurrence(cron, timezone, fromMs);
  } catch {
    next = null;
  }
  run(
    "UPDATE workflow_triggers SET next_run_at = ?, updated_at = ? WHERE id = ?",
    next,
    now(),
    row.id,
  );
  return next;
}

export interface DueSchedule {
  row: TriggerRow;
  occurrenceAt: number;
  key: string;
}

/**
 * Schedule rows whose time has come, oldest first.
 *
 * `next_run_at IS NULL` means "never computed" (a schedule written
 * before this tick, or one whose cursor was deliberately cleared). It
 * is filled in here without firing, so a freshly saved schedule waits a
 * full interval instead of firing the moment it is switched on.
 */
export function dueSchedules(at: number = now(), limit = 50): DueSchedule[] {
  const rows = queryAll<TriggerRow>(
    `SELECT * FROM workflow_triggers
      WHERE type = 'schedule' AND enabled = 1
        AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY COALESCE(next_run_at, 0) ASC
      LIMIT ?`,
    at,
    limit,
  );

  const due: DueSchedule[] = [];
  for (const row of rows) {
    const cron = row.schedule_cron ?? "";
    if (!cron) {
      run("UPDATE workflow_triggers SET next_run_at = NULL, updated_at = ? WHERE id = ?", at, row.id);
      continue;
    }
    if (row.next_run_at === null) {
      /* Prime the cursor; fire on the following tick. */
      try {
        advanceNextRun(row, at);
      } catch {
        /* invalid expression — leave NULL and let readTriggerFor report it */
      }
      continue;
    }
    due.push({ row, occurrenceAt: row.next_run_at, key: occurrenceKey(row.next_run_at) });
  }
  return due;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function workflowSnapshot(
  actor: ActorLike,
  workflowId: string,
  permission: Permission,
): WorkflowSnapshot {
  const access = assertWorkflowAccess(actor, workflowId, permission);
  const row = queryOne<WorkflowSnapshot>(
    `SELECT id, workspace_id, status, published_version_id, draft, trigger_type
       FROM workflows WHERE id = ? AND workspace_id = ?`,
    workflowId,
    access.workspaceId,
  );
  if (!row) throw new HttpError(404, "NOT_FOUND", "That workflow does not exist.");
  return row;
}

function derivedType(snapshot: WorkflowSnapshot): TriggerType | null {
  const direct = TRIGGER_NODE_TYPES[snapshot.trigger_type];
  if (direct) return direct;
  try {
    const draft = JSON.parse(snapshot.draft || "{}") as { nodes?: { type?: string }[] };
    for (const node of draft.nodes ?? []) {
      const type = TRIGGER_NODE_TYPES[node.type ?? ""];
      if (type) return type;
    }
  } catch {
    /* an unreadable draft simply has no trigger to report */
  }
  return null;
}

function triggerNodeConfig(definition: Workflow): Record<string, unknown> {
  const node = definition.nodes.find((candidate) => TRIGGER_NODE_TYPES[candidate.type]);
  const raw = node?.data?.config;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const config = { ...(raw as Record<string, unknown>) };
  delete config.secret;
  return config;
}

function draftTriggerConfig(snapshot: WorkflowSnapshot): Record<string, unknown> {
  try {
    const draft = JSON.parse(snapshot.draft || "{}") as { nodes?: BackfillNodeLike[] };
    const node = draft.nodes?.find((candidate) => TRIGGER_NODE_TYPES[candidate.type ?? ""]);
    const raw = node?.data?.config;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const config = { ...(raw as Record<string, unknown>) };
    delete config.secret;
    return config;
  } catch {
    return {};
  }
}

interface BackfillNodeLike {
  type?: string;
  data?: { config?: unknown };
}

function rowConfig(row: TriggerRow | null): Record<string, unknown> {
  if (!row) return {};
  return fromJson<Record<string, unknown>>(row.config, {});
}

function buildState(
  type: TriggerType | null,
  row: TriggerRow | null,
  snapshot: WorkflowSnapshot,
): TriggerState {
  const managed = !!type;
  const enabled = row ? row.enabled === 1 : true;
  const config = rowConfig(row);

  let schedule: TriggerScheduleView | null = null;
  let blockedBy: string | null = null;

  if (type === "schedule") {
    const cron = cronFromConfig(config) || row?.schedule_cron || "";
    const timezone =
      timezoneFromConfig(config) || row?.schedule_timezone || DEFAULT_TIMEZONE;
    let preview: string[] = [];
    let next: number | null = null;
    try {
      preview = occurrencesBetween(cron, timezone, now(), now() + 30 * 86_400_000, 4).map(
        (ms) => new Date(ms).toISOString(),
      );
      const cursor = row?.next_run_at ?? null;
      next = cursor && cursor > now() ? cursor : (nextOccurrence(cron, timezone, now()) ?? null);
    } catch (error) {
      blockedBy =
        error instanceof ScheduleError
          ? error.message
          : "This schedule could not be read. Set it again.";
      preview = [];
      next = null;
    }
    const declaredEvery = typeof config.every === "string" ? config.every.trim() : "";
    const every =
      declaredEvery === "cron" || !declaredEvery
        ? "cron"
        : SCHEDULE_PRESETS[declaredEvery]
          ? declaredEvery
          : "cron";
    schedule = { cron, every, timezone, nextRunAt: iso(next), preview };
  }

  const published = isPublished(snapshot.id, snapshot.workspace_id);
  const endpoint = type === "webhook" ? webhookEnabled(snapshot.id) : true;
  if (type === "schedule" && blockedBy === null && !schedule?.cron) {
    blockedBy = "No schedule is set yet.";
  }
  if (blockedBy === null && !enabled) {
    blockedBy = "The trigger is turned off.";
  }
  if (blockedBy === null && type === "webhook" && !endpoint) {
    blockedBy = "This endpoint is not published yet.";
  }
  if (blockedBy === null && (type === "webhook" || type === "schedule") && !published) {
    blockedBy = "No published version yet — publish the workflow first.";
  }

  const recent = queryAll<{
    fired_at: number;
    status: string;
    execution_id: string | null;
    error: string | null;
  }>(
    `SELECT fired_at, status, execution_id, error FROM trigger_fires
      WHERE workflow_id = ? ORDER BY fired_at DESC LIMIT 5`,
    snapshot.id,
  );

  const fires: TriggerFireView[] = recent.map((fire) => ({
    at: new Date(fire.fired_at).toISOString(),
    status: fire.status,
    executionId: fire.execution_id,
    error: fire.error,
  }));

  return {
    managed,
    type,
    enabled,
    armed: managed && blockedBy === null,
    blockedBy,
    schedule,
    webhook:
      type === "webhook"
        ? { enabled: webhookEnabled(snapshot.id) }
        : null,
    last: fires[0] ?? null,
    recent: fires,
    updatedAt: iso(row?.updated_at ?? null),
  };
}

function webhookEnabled(workflowId: string): boolean {
  const row = queryOne<{ enabled: number }>(
    "SELECT enabled FROM webhooks WHERE workflow_id = ?",
    workflowId,
  );
  return row ? row.enabled === 1 : false;
}

function scheduleHttpError(error: unknown): HttpError {
  if (error instanceof ScheduleError) {
    return new HttpError(422, error.code, error.message, { detail: error.detail });
  }
  return new HttpError(422, "BAD_SCHEDULE", "The schedule could not be read.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function triggerId(): string {
  return `trg_${randomBytes(9).toString("base64url")}`;
}

/** Exported for the API layer's audit trail. */
export function auditTriggerInvoked(
  actor: Actor,
  workflowId: string,
  type: TriggerType,
  executionId: string,
): void {
  auditAs(actor, "trigger.invoked", {
    resourceType: "workflow",
    resourceId: workflowId,
    metadata: { type, executionId },
  });
}
