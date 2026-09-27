import { randomBytes } from "node:crypto";
import { auditAs } from "./audit";
import { requirePermission } from "./authz";
import { fromJson, now, queryAll, queryOne, run as sqlRun, toJson } from "./db";
import {
  assertRunnable,
  definitionHash,
  parseDefinition,
  publishDefinition,
  startWorkflowRun,
  type VersionRef,
} from "./execution-service";
import { uniqueWebhookPath } from "./webhooks";
import { HttpError, isRecord } from "./http";
import { ensureIdentitySeed, type Actor } from "./identity";
import { assertManualTriggerArmed, disarmScheduleTrigger, ensureTriggerRow, syncTriggerRow } from "./triggers";
import { getDefinition } from "@/lib/workflow/registry";
import {
  collectCredentialValueIssues,
  stripRuntimeState,
  stripWebhookSecrets,
} from "@/lib/workflow/sanitize";
import type {
  Workflow,
  WorkflowDocument,
  WorkflowVersionInfo,
} from "@/lib/workflow/types";
import type { ExecutionDetail } from "@/lib/execution/types";

/**
 * Workflow service — the server's own idea of what a workflow *is*.
 *
 * Before this module a workflow existed only in the browser: the editor
 * wrote it to localStorage and posted it wholesale when it wanted to run.
 * That made the database a record of runs of definitions nobody could
 * reproduce, and it meant anyone who could reach the execute endpoint
 * could run any graph they cared to name.
 *
 * Three objects replace that, and nothing else is invented:
 *
 *  - **Workflow row** — workspace-owned record plus an editable draft.
 *    The draft is the only definition any authoring path may change,
 *    and every write is checked against a revision number so two tabs
 *    cannot silently overwrite each other.
 *  - **Workflow version** — immutable, content-addressed, minted only
 *    here. `workflow_versions` is never updated, only inserted.
 *  - **Execution** — always pinned to one version id.
 *
 * The client sends a workflow *id* and an input; it never sends a graph
 * to be executed.
 */

/* ------------------------------------------------------------------ */
/* Row + view types                                                    */
/* ------------------------------------------------------------------ */

interface WorkflowRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  status: string;
  trigger_type: string;
  node_count: number;
  latest_version: number;
  draft: string;
  draft_revision: number;
  published_version_id: string | null;
  published_version: number;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
  archived_at: number | null;
}

/** A workflow as the editor sees it: summary, graph and version state. */
export type ServerWorkflow = WorkflowDocument;

export type WorkflowVersionView = WorkflowVersionInfo;

interface ExecStats {
  total: number;
  completed: number;
  finished: number;
  avgMs: number | null;
  lastAt: number | null;
}

const DEFAULT_TRIGGER = "trigger.manual";

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

function shortId(): string {
  return randomBytes(9).toString("base64url");
}

function skeletonDefinition(id: string): Workflow {
  return {
    id,
    name: "Untitled workflow",
    description: "",
    status: "draft",
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastExecutedAt: null,
    executionCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    triggerType: DEFAULT_TRIGGER,
    nodeCount: 1,
    nodes: [
      {
        id: "n_start",
        type: DEFAULT_TRIGGER,
        position: { x: 360, y: 160 },
        data: { ref: "manual", config: {} },
      },
    ],
    edges: [],
  };
}

function draftOf(row: WorkflowRow): Partial<Workflow> {
  const parsed = fromJson<unknown>(row.draft, null);
  return isRecord(parsed) ? (parsed as Partial<Workflow>) : {};
}

/**
 * The definition an authoring path works from: the draft when it holds
 * a graph, otherwise the published version (a workflow row can be
 * created by a webhook or a run before anybody saved a draft).
 */
function definitionOf(row: WorkflowRow): Workflow {
  const draft = draftOf(row);
  if (Array.isArray(draft.nodes) && Array.isArray(draft.edges)) {
    return { ...(draft as Workflow), id: row.id, name: row.name };
  }
  const published = publishedDefinitionOf(row);
  if (published) return published;
  return { ...skeletonDefinition(row.id), name: row.name };
}

function publishedDefinitionOf(row: WorkflowRow): Workflow | null {
  /* The pointer is the answer; the "latest version" branch only covers
     rows written before it existed (a webhook publish, a legacy run). */
  const version = row.published_version_id
    ? queryOne<{ definition: string }>(
        "SELECT definition FROM workflow_versions WHERE id = ? AND workflow_id = ? AND workspace_id = ?",
        row.published_version_id,
        row.id,
        row.workspace_id,
      )
    : queryOne<{ definition: string }>(
        "SELECT definition FROM workflow_versions WHERE workflow_id = ? AND workspace_id = ? ORDER BY version DESC LIMIT 1",
        row.id,
        row.workspace_id,
      );
  if (!version) return null;
  try {
    const parsed = JSON.parse(version.definition) as Workflow;
    return { ...parsed, id: row.id };
  } catch {
    return null;
  }
}

function triggerTypeOf(definition: Workflow): string {
  const trigger = definition.nodes.find(
    (node) => getDefinition(node.type)?.trigger,
  );
  return trigger?.type ?? definition.triggerType ?? DEFAULT_TRIGGER;
}

/* ------------------------------------------------------------------ */
/* Credential-value rejection                                          */
/* ------------------------------------------------------------------ */

/**
 * A definition may *reference* a credential, never contain one.
 *
 * Config values that look like raw secrets are refused before they can
 * reach a draft or, worse, a version — versions are readable through
 * the API. Two things are deliberately allowed: an expression
 * (`{{ ... }}`) that resolves at run time, and the webhook trigger's
 * own `secret` field, which is a submission channel for a value the
 * server encrypts into `webhooks.secret_enc` and strips before
 * versioning (`workflow/sanitize.ts`).
 *
 * The pattern itself lives in `workflow/sanitize.ts` so the export gate
 * and this one can never drift apart.
 */
export function assertNoCredentialValues(definition: Workflow): void {
  const issues = collectCredentialValueIssues(definition);
  if (issues.length > 0) {
    throw new HttpError(
      422,
      "CREDENTIAL_VALUE_IN_DEFINITION",
      "This workflow stores a credential value. Use a saved credential instead.",
      { issues },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

function statsByWorkflow(actor: Actor): Map<string, ExecStats> {
  const rows = queryAll<{
    workflow_id: string;
    total: number;
    completed: number;
    finished: number;
    avg_ms: number | null;
    last_at: number | null;
  }>(
    `SELECT workflow_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status IN ('completed','failed','cancelled') THEN 1 ELSE 0 END) AS finished,
            AVG(CASE WHEN status IN ('completed','failed') AND duration_ms IS NOT NULL THEN duration_ms END) AS avg_ms,
            MAX(started_at) AS last_at
       FROM executions
      WHERE workspace_id = ?
      GROUP BY workflow_id`,
    actor.workspaceId,
  );
  return new Map(
    rows.map((row) => [
      row.workflow_id,
      {
        total: row.total,
        completed: row.completed,
        finished: row.finished,
        avgMs: row.avg_ms,
        lastAt: row.last_at,
      },
    ]),
  );
}

function rowToView(row: WorkflowRow, stats?: ExecStats): ServerWorkflow {
  const definition = definitionOf(row);
  const draft = draftOf(row);
  const publishedHash = row.published_version_id
    ? queryOne<{ hash: string }>(
        "SELECT hash FROM workflow_versions WHERE id = ?",
        row.published_version_id,
      )?.hash
    : undefined;
  const draftHash = definitionHash(
    stripRuntimeState(stripWebhookSecrets({ ...definition, id: row.id })),
  );

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as Workflow["status"],
    tags: Array.isArray(draft.tags) ? draft.tags : [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastExecutedAt: stats?.lastAt ? new Date(stats.lastAt).toISOString() : null,
    executionCount: stats?.total ?? 0,
    successRate:
      stats && stats.finished > 0
        ? Math.round((stats.completed / stats.finished) * 100)
        : 0,
    avgDurationMs: stats?.avgMs ? Math.round(stats.avgMs) : 0,
    triggerType: row.trigger_type,
    nodeCount: definition.nodes.length,
    nodes: definition.nodes,
    edges: definition.edges,
    revision: row.draft_revision,
    publishedVersionId: row.published_version_id,
    publishedVersion: row.published_version,
    hasUnpublishedChanges: row.published_version_id
      ? draftHash !== publishedHash
      : draftHash !== "",
  };
}

function rowFor(actor: Actor, id: string): WorkflowRow {
  const row = queryOne<WorkflowRow>(
    "SELECT * FROM workflows WHERE id = ? AND workspace_id = ? AND archived_at IS NULL",
    id,
    actor.workspaceId,
  );
  /* A workflow owned by another tenant is indistinguishable from one
     that never existed: no existence leak, no cross-tenant read. */
  if (!row) {
    throw new HttpError(404, "NOT_FOUND", "That workflow does not exist.");
  }
  return row;
}

function viewOf(actor: Actor, id: string): ServerWorkflow {
  const row = rowFor(actor, id);
  return rowToView(row, statsByWorkflow(actor).get(row.id));
}

export function listWorkflowsFor(actor: Actor): ServerWorkflow[] {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:read");
  const rows = queryAll<WorkflowRow>(
    `SELECT * FROM workflows
      WHERE workspace_id = ? AND archived_at IS NULL
      ORDER BY updated_at DESC`,
    actor.workspaceId,
  );
  const stats = statsByWorkflow(actor);
  return rows.map((row) => rowToView(row, stats.get(row.id)));
}

export function getWorkflowFor(actor: Actor, id: string): ServerWorkflow {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:read");
  return viewOf(actor, id);
}

/**
 * The definition a server-side publish path must use.
 *
 * Endpoint publishing used to take its graph from the request body.
 * It takes it from here instead, so a workflow has exactly one
 * definition and nobody can publish a graph the editor never held.
 */
export function getDraftDefinitionFor(actor: Actor, id: string): Workflow {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:read");
  const row = rowFor(actor, id);
  return { ...definitionOf(row), id: row.id, name: row.name };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

interface DraftBody {
  definition: Workflow;
  revision: number;
}

function readDraftBody(body: unknown): DraftBody {
  if (!isRecord(body)) {
    throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
  }
  const definition = parseDefinition(body.definition);
  const revision = Number(body.revision);
  if (!Number.isFinite(revision) || revision < 0) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      "A draft revision is required so two editors cannot overwrite each other.",
    );
  }
  return { definition, revision };
}

function writeDraft(
  actor: Actor,
  row: WorkflowRow,
  definition: Workflow,
  revision: number,
): ServerWorkflow {
  const timestamp = now();
  const triggerType = triggerTypeOf(definition);
  sqlRun(
    `UPDATE workflows
        SET name = ?, description = ?, status = ?, trigger_type = ?, node_count = ?,
            draft = ?, draft_revision = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND workspace_id = ?`,
    definition.name,
    definition.description ?? "",
    definition.status ?? row.status,
    triggerType,
    definition.nodes.length,
    toJson(stripRuntimeState({ ...definition, id: row.id, name: definition.name })) ??
      "{}",
    revision,
    timestamp,
    actor.userId,
    row.id,
    actor.workspaceId,
  );
  return viewOf(actor, row.id);
}

/**
 * Save the working draft.
 *
 * The caller must present the revision it based its edits on. A tab
 * that has been open for an hour loses the race on purpose rather than
 * silently replacing newer work — the 409 carries the server's copy so
 * the editor can offer a reload.
 */
export function saveDraftFor(
  actor: Actor,
  id: string,
  body: unknown,
): ServerWorkflow {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:write");
  const row = rowFor(actor, id);
  const { definition, revision } = readDraftBody(body);

  if (definition.id !== id) {
    throw new HttpError(
      400,
      "ID_MISMATCH",
      "The definition does not match the workflow in the URL.",
    );
  }
  if (revision !== row.draft_revision) {
    throw new HttpError(
      409,
      "REVISION_CONFLICT",
      "This workflow changed somewhere else since you opened it.",
      {
        serverRevision: row.draft_revision,
        workflow: rowToView(row, statsByWorkflow(actor).get(row.id)),
      },
    );
  }

  assertNoCredentialValues(definition);
  return writeDraft(actor, row, definition, row.draft_revision + 1);
}

export function updateWorkflowFor(
  actor: Actor,
  id: string,
  body: unknown,
): ServerWorkflow {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:write");
  const row = rowFor(actor, id);
  if (!isRecord(body)) {
    throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
  }
  const definition = { ...definitionOf(row) };
  if (typeof body.name === "string" && body.name.trim()) {
    definition.name = body.name.trim();
  }
  if (typeof body.description === "string") {
    definition.description = body.description;
  }
  if (typeof body.status === "string" && body.status) {
    definition.status = body.status as Workflow["status"];
  }
  if (body.definition !== undefined) {
    const parsed = parseDefinition(body.definition);
    if (parsed.id !== id) {
      throw new HttpError(
        400,
        "ID_MISMATCH",
        "The definition does not match the workflow in the URL.",
      );
    }
    assertNoCredentialValues(parsed);
    Object.assign(definition, parsed, { id });
  }
  const revision = Number.isFinite(Number(body.revision))
    ? Number(body.revision)
    : row.draft_revision;
  if (revision !== row.draft_revision) {
    throw new HttpError(409, "REVISION_CONFLICT", "This workflow changed somewhere else.", {
      serverRevision: row.draft_revision,
      workflow: rowToView(row, statsByWorkflow(actor).get(row.id)),
    });
  }
  const view = writeDraft(actor, row, definition, row.draft_revision + 1);
  auditAs(actor, "workflow.updated", {
    resourceType: "workflow",
    resourceId: id,
    metadata: { name: view.name, status: view.status },
  });
  return view;
}

export function createWorkflowFor(
  actor: Actor,
  input: unknown,
): ServerWorkflow {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:write");

  const record = isRecord(input) ? input : {};
  const id =
    typeof record.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(record.id)
      ? record.id
      : `wf_${shortId()}`;

  const clash = queryOne<{ workspace_id: string }>(
    "SELECT workspace_id FROM workflows WHERE id = ?",
    id,
  );
  if (clash) {
    throw clash.workspace_id === actor.workspaceId
      ? new HttpError(409, "ID_IN_USE", "A workflow with that id already exists.")
      : new HttpError(404, "NOT_FOUND", "That workflow does not exist.");
  }

  const base = skeletonDefinition(id);
  const definition: Workflow = {
    ...base,
    name:
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : base.name,
    description:
      typeof record.description === "string" ? record.description : "",
    ...(isRecord(record.definition)
      ? (() => {
          const parsed = parseDefinition(record.definition);
          assertNoCredentialValues(parsed);
          return { ...parsed, id };
        })()
      : {}),
  };

  const timestamp = now();
  sqlRun(
    `INSERT INTO workflows
      (id, workspace_id, name, description, status, trigger_type, node_count, latest_version,
       draft, draft_revision, published_version_id, published_version,
       created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, NULL, 0, ?, ?, ?, ?)`,
    id,
    actor.workspaceId,
    definition.name,
    definition.description ?? "",
    definition.status ?? "draft",
    triggerTypeOf(definition),
    definition.nodes.length,
    toJson(definition) ?? "{}",
    actor.userId,
    actor.userId,
    timestamp,
    timestamp,
  );
  ensureTriggerRow(actor.workspaceId, id, definition);

  auditAs(actor, "workflow.created", {
    resourceType: "workflow",
    resourceId: id,
    metadata: { name: definition.name },
  });
  return viewOf(actor, id);
}

/**
 * Give a copy its own webhook identity.
 *
 * One endpoint per workflow, and paths are unique across a workspace,
 * so a copy that kept `/hooks/github` would collide with its own origin
 * on publish — and until then it would *look* live while the original
 * still owned the URL. The first webhook node gets a free path derived
 * from the original, and every webhook node loses its `secret`: that
 * value lives encrypted in `webhooks.secret_enc` for the workflow that
 * created it, and two workflows sharing one secret is exactly the
 * coupling duplication exists to avoid.
 */
function forkWebhookIdentity(definition: Workflow, workspaceId: string): Workflow {
  const paths = definition.nodes
    .filter((node) => node.type === "trigger.webhook")
    .map((node) => String(node.data?.config?.path ?? ""))
    .filter((path) => path.trim() !== "");

  let claimed = false;
  const nodes = definition.nodes.map((node) => {
    if (node.type !== "trigger.webhook") return node;
    const config = { ...(node.data?.config ?? {}) };
    config.secret = "";
    if (!claimed) {
      claimed = true;
      const base = String(config.path ?? "");
      config.path = uniqueWebhookPath(base, [...paths, base], workspaceId);
    }
    return { ...node, data: { ...node.data, config } };
  });
  return { ...definition, nodes };
}

/**
 * Copy a workflow's draft into a new, unpublished workflow.
 *
 * What the copy keeps is the graph: nodes, edges, layout, references,
 * configuration and — because it stays in the same workspace — the
 * *references* to credentials it shares with its origin. What it never
 * carries is state: no published version, no execution history, no
 * audit history, no ownership fields, no trigger identity. It is a
 * draft, and it has to be published before it can run.
 */
export function duplicateWorkflowFor(actor: Actor, id: string): ServerWorkflow {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:write");
  const source = rowFor(actor, id);
  const copyId = `wf_${shortId()}`;
  const definition = forkWebhookIdentity(
    stripRuntimeState(stripWebhookSecrets({ ...definitionOf(source), id: copyId })),
    actor.workspaceId,
  );

  const copy = createWorkflowFor(actor, {
    id: copyId,
    name: `${source.name} copy`,
    description: source.description,
    definition: {
      ...definition,
      id: copyId,
      name: `${source.name} copy`,
      description: source.description,
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastExecutedAt: null,
      executionCount: 0,
      successRate: 0,
      avgDurationMs: 0,
    },
  });

  /* A second workflow on the same expression would double production
     executions the first time anyone published it. Copies start paused. */
  disarmScheduleTrigger(copy.id);

  auditAs(actor, "workflow.duplicated", {
    resourceType: "workflow",
    resourceId: copy.id,
    metadata: { name: copy.name, sourceWorkflowId: source.id },
  });
  return copy;
}

/**
 * Archive rather than delete.
 *
 * Executions keep their `workflow_version_id` forever, and the worker
 * reads the definition back through it — dropping the workflow row
 * would turn every finished run into a dangling reference. Archiving
 * removes it from every list while leaving history readable.
 */
export function archiveWorkflowFor(actor: Actor, id: string): void {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:delete");
  const row = rowFor(actor, id);
  sqlRun(
    "UPDATE workflows SET archived_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND workspace_id = ?",
    now(),
    now(),
    actor.userId,
    row.id,
    actor.workspaceId,
  );
  auditAs(actor, "workflow.deleted", {
    resourceType: "workflow",
    resourceId: row.id,
    metadata: { name: row.name, mode: "archived" },
  });
}

/* ------------------------------------------------------------------ */
/* Publishing                                                          */
/* ------------------------------------------------------------------ */

/**
 * Mint (or reuse) an immutable version and point the workflow at it.
 *
 * The insert itself lives in `execution-service.publishDefinition`;
 * this wrapper only records *who* moved the pointer, which is the
 * field the version history shows.
 */
function publish(actor: Actor, definition: Workflow): VersionRef {
  const ref = publishDefinition(actor, definition);
  sqlRun(
    "UPDATE workflows SET updated_by = ? WHERE id = ? AND workspace_id = ?",
    actor.userId,
    definition.id,
    actor.workspaceId,
  );
  return ref;
}

export function publishWorkflowFor(
  actor: Actor,
  id: string,
): { workflow: ServerWorkflow; version: WorkflowVersionView } {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:publish");
  const row = rowFor(actor, id);
  const definition = { ...definitionOf(row), id, name: row.name };

  assertNoCredentialValues(definition);
  assertRunnable(definition);

  const ref = publish(actor, definition);
  syncTriggerRow(actor.workspaceId, id, definition);
  auditAs(actor, "workflow.published", {
    resourceType: "workflow",
    resourceId: id,
    metadata: { version: ref.version, versionId: ref.versionId },
  });

  const view = viewOf(actor, id);
  const version = listVersionsFor(actor, id).find((item) => item.id === ref.versionId);
  if (!version) {
    throw new HttpError(500, "PUBLISH_FAILED", "The published version could not be read back.");
  }
  return { workflow: view, version };
}

export function listVersionsFor(actor: Actor, id: string): WorkflowVersionView[] {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:read");
  const row = rowFor(actor, id);
  const rows = queryAll<{
    id: string;
    version: number;
    hash: string;
    created_at: number;
    created_by: string | null;
    definition: string;
  }>(
    `SELECT id, version, hash, created_at, created_by, definition
       FROM workflow_versions
      WHERE workflow_id = ? AND workspace_id = ?
      ORDER BY version DESC`,
    row.id,
    actor.workspaceId,
  );
  return rows.map((item) => {
    let nodeCount = 0;
    try {
      const parsed = JSON.parse(item.definition) as { nodes?: unknown[] };
      nodeCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
    } catch {
      nodeCount = 0;
    }
    return {
      id: item.id,
      version: item.version,
      hash: item.hash,
      createdAt: new Date(item.created_at).toISOString(),
      createdBy: item.created_by,
      nodeCount,
      isPublished: item.id === row.published_version_id,
    };
  });
}

/**
 * Copy an old version into the draft. The version itself is untouched —
 * restoring creates new *working* state that still has to be published
 * before it can run.
 */
export function restoreVersionFor(actor: Actor, id: string, versionId: string): ServerWorkflow {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:write");
  const row = rowFor(actor, id);
  const version = queryOne<{ definition: string }>(
    "SELECT definition FROM workflow_versions WHERE id = ? AND workflow_id = ? AND workspace_id = ?",
    versionId,
    row.id,
    actor.workspaceId,
  );
  if (!version) {
    throw new HttpError(404, "NOT_FOUND", "That workflow version does not exist.");
  }
  let definition: Workflow;
  try {
    definition = parseDefinition(JSON.parse(version.definition));
  } catch {
    throw new HttpError(422, "BAD_VERSION", "That version could not be read.");
  }
  const view = writeDraft(actor, row, { ...definition, id: row.id, name: row.name }, row.draft_revision + 1);
  auditAs(actor, "workflow.version_restored", {
    resourceType: "workflow",
    resourceId: row.id,
    metadata: { versionId },
  });
  return view;
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

export interface RunBody {
  input?: unknown;
  options?: unknown;
}

function readRunBody(body: unknown): RunBody {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) {
    throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
  }
  /* Anything that looks like a graph is ignored on purpose: the
     definition that runs is the one the server already holds. */
  return { input: body.input, options: body.options };
}

/**
 * Run a workflow.
 *
 * The caller supplies an id and an input. The definition is resolved
 * from the row: if the draft still matches the published version we run
 * that version; if it has moved on, the draft is validated and versioned
 * here first — with the publisher's permission — so the execution always
 * ends up pinned to an immutable row in `workflow_versions`.
 */
export async function runWorkflowFor(
  actor: Actor,
  id: string,
  body: unknown,
): Promise<ExecutionDetail> {
  ensureIdentitySeed();
  requirePermission(actor, "execution:run");
  const row = rowFor(actor, id);
  const definition = { ...definitionOf(row), id, name: row.name };

  assertNoCredentialValues(definition);
  assertRunnable(definition);

  /* The manual trigger's own switch. A row that does not exist is
     armed — that is the pre-trigger behaviour, unchanged. */
  assertManualTriggerArmed(actor, id);

  /* A run is an implicit publish when the draft has moved — never for a
     viewer, and never without the draft being valid. */
  if (row.published_version_id) {
    requirePermission(actor, "workflow:publish");
  }
  const ref = publish(actor, definition);

  const published = queryOne<{ definition: string }>(
    "SELECT definition FROM workflow_versions WHERE id = ? AND workspace_id = ?",
    ref.versionId,
    actor.workspaceId,
  );
  if (!published) {
    throw new HttpError(500, "VERSION_MISSING", "The workflow version could not be stored.");
  }
  const pinned = parseDefinition(JSON.parse(published.definition));

  const { input, options } = readRunBody(body);
  const execution = await startWorkflowRun(actor, {
    definition: pinned,
    input,
    options,
  });
  auditAs(actor, "workflow.executed", {
    resourceType: "workflow",
    resourceId: id,
    metadata: { executionId: execution.id, version: ref.version, versionId: ref.versionId },
  });
  return execution;
}
