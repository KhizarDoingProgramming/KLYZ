import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { queryAll, queryOne, run as sqlRun, now } from "./db";
import { HttpError } from "./http";
import { decryptSecret, encryptSecret } from "./credentials";
import { redact, redactHeaders, redactMessage } from "./redact";
import type { Actor } from "./identity";
import { publishDefinition, assertRunnable, startPinnedRun } from "./execution-service";
import { assertWebhookTriggerArmed, getTriggerRow, resolvePinnedDefinition, type PinnedDefinition } from "./triggers";
import { recordAudit } from "./audit";
import { limitByKey } from "./rate-limit";
import type { Workflow } from "@/lib/workflow/types";

/**
 * Webhook endpoints.
 *
 * One endpoint per workflow. The `webhooks` row owns the runtime truth —
 * path, method, auth mode, encrypted secret, enabled flag, delivery
 * bookkeeping — while the workflow definition (versioned server-side on
 * publish) owns the graph the receiver executes. The receiver resolves
 * both without any session: the row carries the workspace.
 */

export type WebhookAuth = "none" | "header" | "hmac";

export interface WebhookView {
  id: string;
  workflowId: string;
  slug: string;
  url: string;
  path: string;
  method: string;
  auth: WebhookAuth;
  secretSet: boolean;
  enabled: boolean;
  deliveryCount: number;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
  sample: string | null;
  updatedAt: string;
}

export interface WebhookPublishInput {
  /** Full definition — versioned (secret-stripped) as part of publishing. */
  definition: Workflow;
  path?: string;
  method?: string;
  auth?: WebhookAuth;
  /** Plaintext secret from the editor; empty keeps the stored one. */
  secret?: string;
  enabled?: boolean;
}

interface WebhookRow {
  id: string;
  workspace_id: string;
  workflow_id: string;
  slug: string;
  path: string;
  method: string;
  auth: string;
  secret_enc: string | null;
  enabled: number;
  sample: string | null;
  delivery_count: number;
  last_delivery_at: number | null;
  last_delivery_status: string | null;
  created_at: number;
  updated_at: number;
}

const AUTH_MODES = new Set<WebhookAuth>(["none", "header", "hmac"]);
const SAMPLE_LIMIT = 4_000;

/* ------------------------------------------------------------------ */
/* Publish / read / unpublish                                          */
/* ------------------------------------------------------------------ */

export function publishWebhook(actor: Actor, input: WebhookPublishInput): WebhookView {
  const definition = input.definition;
  const trigger = definition.nodes.find((node) => node.type === "trigger.webhook");
  if (!trigger) {
    throw new HttpError(422, "NO_WEBHOOK_TRIGGER", "Add a Webhook trigger before publishing.");
  }
  const nodeConfig =
    trigger.data && typeof trigger.data.config === "object" && trigger.data.config
      ? (trigger.data.config as Record<string, unknown>)
      : {};

  const path = normalisePath(input.path ?? String(nodeConfig.path ?? ""));
  const method = (input.method ?? String(nodeConfig.method ?? "POST")).toUpperCase();
  const auth = parseAuth(input.auth ?? String(nodeConfig.auth ?? "none"));
  const existing = findRowForWorkflow(actor, definition.id);

  const editorSecret =
    typeof input.secret === "string" && input.secret.trim()
      ? input.secret.trim()
      : typeof nodeConfig.secret === "string" && nodeConfig.secret.trim()
        ? nodeConfig.secret.trim()
        : "";

  let secretEnc = existing?.secret_enc ?? null;
  if (auth === "none") {
    secretEnc = null;
  } else if (editorSecret) {
    secretEnc = encryptSecret(editorSecret);
  } else if (!secretEnc) {
    /* Never publish an auth mode with no secret — generate one so the
       caller can copy it straight into the external service. */
    secretEnc = encryptSecret(generateSecret());
  }

  const clash = queryOne<{ id: string }>(
    "SELECT id FROM webhooks WHERE path = ? AND id != ?",
    path,
    existing?.id ?? "",
  );
  if (clash) {
    throw new HttpError(409, "PATH_IN_USE", "Another endpoint already uses that path.", {
      path,
    });
  }

  /* Version the definition (secret stripped inside) so receivers and
     manual runs of the same graph share a version id — and point the
     workflow at it, so a delivery runs exactly what was published. */
  publishDefinition(actor, definition);

  const timestamp = now();
  if (existing) {
    sqlRun(
      `UPDATE webhooks
         SET path = ?, method = ?, auth = ?, secret_enc = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
      path,
      method,
      auth,
      secretEnc,
      input.enabled === false ? 0 : 1,
      timestamp,
      existing.id,
    );
  } else {
    sqlRun(
      `INSERT INTO webhooks
         (id, workspace_id, workflow_id, slug, path, method, auth, secret_enc, enabled,
          delivery_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      `whrow_${randomBytes(9).toString("base64url")}`,
      actor.workspaceId,
      definition.id,
      `wh_${randomBytes(9).toString("base64url")}`,
      path,
      method,
      auth,
      secretEnc,
      input.enabled === false ? 0 : 1,
      timestamp,
      timestamp,
    );
  }

  return getWebhookFor(actor, definition.id)!;
}

export function getWebhookFor(actor: Actor, workflowId: string): WebhookView | null {
  const row = queryOne<WebhookRow>(
    "SELECT * FROM webhooks WHERE workflow_id = ? AND workspace_id = ?",
    workflowId,
    actor.workspaceId,
  );
  return row ? toView(row) : null;
}

export function unpublishWebhook(actor: Actor, workflowId: string): void {
  const row = queryOne<WebhookRow>(
    "SELECT * FROM webhooks WHERE workflow_id = ? AND workspace_id = ?",
    workflowId,
    actor.workspaceId,
  );
  if (!row) {
    throw new HttpError(404, "NOT_FOUND", "This workflow has no published endpoint.");
  }
  sqlRun("DELETE FROM webhooks WHERE id = ?", row.id);
}

/* ------------------------------------------------------------------ */
/* Receiver                                                            */
/* ------------------------------------------------------------------ */

/**
 * Inbound payloads are capped: a public endpoint must not become an
 * unbounded memory sink. Generous for any realistic GitHub/Stripe
 * event, small enough that a flood costs nothing.
 */
const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

export interface WebhookDelivery {
  executionId: string;
  status: string;
  receivedAt: string;
}

export async function receiveWebhook(
  request: Request,
  key: string,
): Promise<WebhookDelivery> {
  const row = lookupEnabledEndpoint(key);
  if (!row) {
    throw new HttpError(404, "WEBHOOK_NOT_FOUND", "No enabled endpoint matches this URL.");
  }
  const method = request.method.toUpperCase();
  if (method !== row.method) {
    throw new HttpError(
      405,
      "WEBHOOK_METHOD_NOT_ALLOWED",
      `This endpoint accepts ${row.method} only.`,
    );
  }

  /* Second, independent switch: the trigger card's own enable. It
     answers with the same 404 as a missing endpoint, so turning a
     trigger off never tells a caller that the URL exists. */
  assertWebhookTriggerArmed(row.workflow_id, row.workspace_id);
  /* A single workspace cannot be flooded through one endpoint even if
     every request comes from a different address. */
  limitByKey("webhook:workspace", row.workspace_id, 600, 60_000);

  const rawBody = await safeReadBody(request);
  verifyAuth(row, request, rawBody);

  const pinned = publishedPinned(row);
  assertRunnable(pinned.definition);
  const receivedAt = new Date().toISOString();
  const payload = {
    body: parseBody(rawBody, request.headers.get("content-type")),
    headers: redactHeaders(Object.fromEntries([...request.headers.entries()])),
    query: Object.fromEntries(new URL(request.url).searchParams.entries()),
    receivedAt,
    endpoint: { id: row.id, slug: row.slug, path: row.path },
  };

  const trigger = getTriggerRow(row.workflow_id);
  const execution = await startPinnedRun(
    { userId: "u_webhook", workspaceId: row.workspace_id },
    {
      definition: pinned.definition,
      versionId: pinned.versionId,
      version: pinned.version,
      input: payload,
      source: "webhook",
      trigger: { type: "trigger.webhook" },
      triggerId: trigger?.id ?? null,
      occurrenceKey: `wh_${receivedAt}_${row.delivery_count + 1}`,
    },
  );

  recordAudit({
    workspaceId: row.workspace_id,
    actorId: null,
    action: "trigger.invoked",
    resourceType: "workflow",
    resourceId: row.workflow_id,
    metadata: { type: "webhook", executionId: execution.id },
  });
  recordDelivery(row, "accepted", rawBody);
  return { executionId: execution.id, status: execution.status, receivedAt };
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function findRowForWorkflow(actor: Actor, workflowId: string): WebhookRow | undefined {
  return queryOne<WebhookRow>(
    "SELECT * FROM webhooks WHERE workflow_id = ? AND workspace_id = ?",
    workflowId,
    actor.workspaceId,
  );
}

function lookupEnabledEndpoint(key: string): WebhookRow | null {
  const candidate = key.trim().replace(/^\/+|\/+$/g, "");
  if (!candidate) return null;
  const row =
    queryOne<WebhookRow>("SELECT * FROM webhooks WHERE slug = ?", candidate) ??
    queryOne<WebhookRow>(
      "SELECT * FROM webhooks WHERE path = ?",
      `/${candidate.replace(/^\/+/, "")}`,
    );
  if (!row) return null;
  return row.enabled === 1 ? row : null;
}

function publishedPinned(row: WebhookRow): PinnedDefinition {
  /* The workflow's own pointer is what a delivery runs, and it is
     pinned by id — a webhook never runs "the newest version", it runs
     the one a human published. The "latest version" fallback exists
     only for rows written before that pointer existed. */
  const pinned = resolvePinnedDefinition(row.workflow_id, row.workspace_id);
  if (!pinned) {
    throw new HttpError(
      404,
      "WEBHOOK_WORKFLOW_INACTIVE",
      "This endpoint has no published workflow yet.",
    );
  }
  return pinned;
}

function verifyAuth(row: WebhookRow, request: Request, rawBody: string): void {
  if (row.auth === "none") return;

  let secret: string;
  try {
    secret = row.secret_enc ? decryptSecret(row.secret_enc) : "";
  } catch {
    throw new HttpError(
      401,
      "WEBHOOK_AUTH_FAILED",
      "This endpoint's secret could not be read — publish it again.",
    );
  }
  if (!secret) {
    throw new HttpError(
      401,
      "WEBHOOK_AUTH_FAILED",
      "This endpoint requires a secret but none is configured.",
    );
  }

  if (row.auth === "header") {
    const provided = request.headers.get("x-klyz-webhook-secret") ?? "";
    if (!safeEqual(provided, secret)) {
      throw new HttpError(
        401,
        "WEBHOOK_AUTH_FAILED",
        "Missing or incorrect webhook secret header.",
      );
    }
    return;
  }

  const signature =
    request.headers.get("x-klyz-signature") ?? request.headers.get("x-hub-signature-256") ?? "";
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expected = `sha256=${digest}`;
  const provided = signature.startsWith("sha256=") ? signature : `sha256=${signature}`;
  if (!safeEqual(provided.toLowerCase(), expected.toLowerCase())) {
    throw new HttpError(
      401,
      "WEBHOOK_AUTH_FAILED",
      "The HMAC signature does not match the payload.",
    );
  }
}

function recordDelivery(row: WebhookRow, status: string, rawBody: string): void {
  const at = now();
  sqlRun(
    `UPDATE webhooks
        SET delivery_count = delivery_count + 1,
            last_delivery_at = ?,
            last_delivery_status = ?,
            sample = COALESCE(sample, ?),
            updated_at = ?
      WHERE id = ?`,
    at,
    status,
    samplePayload(rawBody),
    at,
    row.id,
  );
}

function samplePayload(rawBody: string): string | null {
  if (!rawBody.trim()) return null;
  const trimmed = rawBody.length > SAMPLE_LIMIT ? `${rawBody.slice(0, SAMPLE_LIMIT)}…` : rawBody;
  try {
    return JSON.stringify(redact(JSON.parse(trimmed))).slice(0, SAMPLE_LIMIT);
  } catch {
    return redactMessage(trimmed).slice(0, SAMPLE_LIMIT);
  }
}

async function safeReadBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
    throw new HttpError(
      413,
      "WEBHOOK_BODY_TOO_LARGE",
      `Webhook payloads are limited to ${MAX_WEBHOOK_BODY_BYTES} bytes.`,
    );
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new HttpError(400, "WEBHOOK_BAD_BODY", "The request body could not be read.");
  }
  if (text.length > MAX_WEBHOOK_BODY_BYTES) {
    throw new HttpError(
      413,
      "WEBHOOK_BODY_TOO_LARGE",
      `Webhook payloads are limited to ${MAX_WEBHOOK_BODY_BYTES} bytes.`,
    );
  }
  return text;
}

function parseBody(raw: string, contentType: string | null): unknown {
  if (!raw.trim()) return null;
  if (contentType?.includes("json") || /^[[{]/.test(raw.trim())) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through — return the text as-is */
    }
  }
  if (contentType?.includes("form")) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  return raw;
}

function normalisePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new HttpError(422, "BAD_PATH", "Give the endpoint a path, e.g. /hooks/github.");
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withSlash.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (/[\s?#]/.test(collapsed)) {
    throw new HttpError(422, "BAD_PATH", "Endpoint paths cannot contain spaces, ? or #.");
  }
  return collapsed;
}

function parseAuth(value: string): WebhookAuth {
  const auth = value as WebhookAuth;
  if (!AUTH_MODES.has(auth)) {
    throw new HttpError(422, "BAD_AUTH", `Unknown webhook auth mode "${value}".`);
  }
  return auth;
}

function generateSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function toView(row: WebhookRow): WebhookView {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    slug: row.slug,
    url: webhookUrl(row.slug),
    path: row.path,
    method: row.method,
    auth: row.auth as WebhookAuth,
    secretSet: !!row.secret_enc,
    enabled: row.enabled === 1,
    deliveryCount: row.delivery_count,
    lastDeliveryAt: row.last_delivery_at ? new Date(row.last_delivery_at).toISOString() : null,
    lastDeliveryStatus: row.last_delivery_status,
    sample: row.sample,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Public URL for an endpoint — the same shape the UI shows for copying. */
/**
 * A path the duplicate may use, given the one it was copied from.
 *
 * Endpoint paths are unique across a workspace, so a copy that kept
 * `/hooks/github` would collide with its own origin the first time
 * somebody published it — and worse, the copy would look live while
 * the original still owned the URL. Deriving a free variant here means
 * the two identities are independent from the moment of duplication
 * rather than only after a failed publish.
 */
/**
 * Every path some workflow in the workspace is already asking for,
 * draft or published.
 *
 * The `webhooks` table only holds endpoints somebody has explicitly
 * published, so checking it alone would let two copies of a workflow
 * sit on the same path and only discover the clash when the second
 * publish failed. Drafts are claims too.
 */
function claimedPaths(workspaceId: string): string[] {
  const rows = queryAll<{ draft: string }>(
    "SELECT draft FROM workflows WHERE workspace_id = ?",
    workspaceId,
  );
  const paths: string[] = [];
  for (const row of rows) {
    if (!row.draft) continue;
    let graph: unknown;
    try {
      graph = JSON.parse(row.draft);
    } catch {
      continue;
    }
    if (!graph || typeof graph !== "object" || Array.isArray(graph)) continue;
    const nodes = (graph as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes)) continue;
    for (const entry of nodes) {
      if (!entry || typeof entry !== "object") continue;
      const node = entry as { type?: unknown; data?: { config?: { path?: unknown } } };
      if (node.type !== "trigger.webhook") continue;
      const path = String(node.data?.config?.path ?? "").trim();
      if (path) paths.push(path);
    }
  }
  return paths;
}

export function uniqueWebhookPath(
  base: string,
  reserved: Iterable<string> = [],
  workspaceId?: string,
): string {
  const raw = (base || "").trim();
  let start: string;
  try {
    start = normalisePath(raw);
  } catch {
    start = "/hooks/copy";
  }
  const taken = new Set(reserved);
  if (workspaceId) {
    for (const path of claimedPaths(workspaceId)) taken.add(path);
  }
  const clashes = (candidate: string) =>
    taken.has(candidate) ||
    Boolean(queryOne<{ id: string }>("SELECT id FROM webhooks WHERE path = ?", candidate));

  if (!clashes(start)) return start;
  for (let attempt = 2; attempt <= 200; attempt += 1) {
    const suffix = attempt === 2 ? "-copy" : `-copy-${attempt - 1}`;
    const candidate = `${start}${suffix}`;
    if (!clashes(candidate)) return candidate;
  }
  return `${start}-${randomBytes(3).toString("hex")}`;
}

export function webhookUrl(slug: string): string {
  const base = process.env.KLYZ_PUBLIC_URL?.trim().replace(/\/+$/, "");
  return `${base ?? ""}/api/webhooks/${slug}`;
}
