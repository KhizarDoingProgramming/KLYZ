import { createHash, randomBytes } from "node:crypto";
import { exec, now, queryAll, queryOne, run as sqlRun } from "./db";
import { HttpError } from "./http";
import { decryptSecret, encryptSecret } from "./credentials";
import { redactMessage } from "./redact";
import type { Actor } from "./identity";
import { publishDefinition, startWorkflowRun } from "./execution-service";
import { loadConnection } from "@/lib/integrations/provider/connection";
import { slackSigningSecret } from "@/lib/integrations/provider/config";
import type { ProviderConnection, ProviderId } from "@/lib/integrations/provider/types";
import { matchesEvent, parseRepository, hookEventsFor } from "@/lib/integrations/github/config";
import { parseGitHubDelivery, verifyGitHubSignature } from "@/lib/integrations/github/webhook";
import { GITHUB_ERRORS, SLACK_ERRORS } from "@/lib/integrations/errors";
import { githubRequest } from "@/lib/integrations/github/api";
import {
  parseSlackChallenge,
  parseSlackDelivery,
  slackMessageKind,
  verifySlackSignature,
} from "@/lib/integrations/slack/webhook";
import { looksLikeChannelId, normaliseChannelRef } from "@/lib/integrations/slack/config";
import { findChannel } from "@/lib/integrations/slack/channels";
import { verifyGooglePushToken } from "./google-oidc";
import type { Workflow } from "@/lib/workflow/types";

/**
 * Provider-owned webhooks.
 *
 * GitHub needs a hook registered *on the repository*; Gmail needs a
 * Pub/Sub push endpoint the operator points a subscription at. Both end
 * up as one `provider_webhooks` row: an unguessable URL key, an
 * encrypted secret, the subscription it represents and its delivery
 * bookkeeping. The receiver resolves everything from that row — no
 * session, no workspace header.
 *
 * Idempotency is enforced on `(provider, workflow_id, delivery_id)`, so
 * GitHub's redeliveries and Pub/Sub at-least-once delivery create one
 * run, not many.
 */

export interface ProviderWebhookView {
  id: string;
  provider: ProviderId;
  workflowId: string;
  /** Public URL the provider posts to. */
  url: string;
  target: string;
  events: string[];
  mode: "managed" | "manual";
  status: "pending" | "active" | "ready" | "error" | "disabled";
  remoteHookId: string | null;
  lastError: string | null;
  secretSet: boolean;
  /** Plaintext secret — only present immediately after it was created. */
  secret?: string;
  deliveryCount: number;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
  updatedAt: string;
}

interface Row {
  id: string;
  provider: string;
  workspace_id: string;
  workflow_id: string;
  workflow_version_id: string | null;
  credential_id: string | null;
  target: string;
  events: string;
  url_key: string;
  secret_enc: string;
  mode: string;
  status: string;
  remote_hook_id: string | null;
  last_error: string | null;
  delivery_count: number;
  last_delivery_at: number | null;
  last_delivery_status: string | null;
  created_at: number;
  updated_at: number;
}

function triggerConfig(
  definition: Workflow,
  type: string,
): Record<string, unknown> | null {
  const node = definition.nodes.find((entry) => entry.type === type);
  if (!node) return null;
  const config = node.data?.config;
  return config && typeof config === "object" ? (config as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A `toggle` field, stored as a boolean or as the string "true". */
function flagOn(value: unknown): boolean {
  return value === true || text(value) === "true";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function providerTriggerType(definition: Workflow): string | null {
  if (triggerConfig(definition, "trigger.github")) return "trigger.github";
  if (triggerConfig(definition, "trigger.gmail")) return "trigger.gmail";
  if (triggerConfig(definition, "trigger.slack")) return "trigger.slack";
  return null;
}

/** The node a delivery from this provider starts. */
function triggerTypeFor(provider: ProviderId): string {
  if (provider === "github") return "trigger.github";
  if (provider === "gmail") return "trigger.gmail";
  return "trigger.slack";
}

/* ------------------------------------------------------------------ */
/* Read / publish / unpublish                                          */
/* ------------------------------------------------------------------ */

export function getProviderWebhook(
  actor: Actor,
  workflowId: string,
): ProviderWebhookView | null {
  const row = queryOne<Row>(
    "SELECT * FROM provider_webhooks WHERE workflow_id = ? AND workspace_id = ?",
    workflowId,
    actor.workspaceId,
  );
  return row ? toView(row) : null;
}

export interface PublishResult {
  webhook: ProviderWebhookView;
  /** Set when the remote registration failed and needs attention. */
  warning?: { code: string; message: string; hint: string };
}

/**
 * Publishes the workflow's provider trigger.
 *
 * Mirrors the generic endpoint flow: the definition is versioned, the
 * row is upserted and (for GitHub) a repository hook is created with
 * the exact events the node subscribes to. A refused registration is
 * **not** swallowed — it comes back as a `warning` with the row already
 * stored, so the endpoint URL and one-time secret can still be used to
 * register the hook by hand.
 */
export async function publishProviderWebhook(
  actor: Actor,
  definition: Workflow,
): Promise<PublishResult> {
  const type = providerTriggerType(definition);
  if (!type) {
    throw new HttpError(
      422,
      "NO_PROVIDER_TRIGGER",
      "Add a GitHub event, Gmail or Slack trigger before publishing.",
    );
  }

  const config = triggerConfig(definition, type)!;
  const provider: ProviderId =
    type === "trigger.github" ? "github" : type === "trigger.gmail" ? "gmail" : "slack";
  const credentialId = text(config.credential);
  if (!credentialId) {
    throw new HttpError(
      422,
      "NO_CONNECTION",
      "Connect an account on the trigger before publishing.",
    );
  }

  const existing = queryOne<Row>(
    "SELECT * FROM provider_webhooks WHERE workflow_id = ? AND workspace_id = ?",
    definition.id,
    actor.workspaceId,
  );
  const urlKey = existing?.url_key ?? randomBytes(18).toString("base64url");
  /* Slack signs with the app's *signing secret*, which lives in the
     environment — a generated value would simply never match, so the
     endpoint is published anyway and refuses every delivery until the
     operator sets it (see the warning below). */
  const signingSecret = slackSigningSecret();
  const missingSigningSecret = provider === "slack" && !signingSecret;
  const secret =
    provider === "slack"
      ? signingSecret || generateSecret()
      : existing
        ? decryptSecret(existing.secret_enc)
        : generateSecret();
  const url = endpointUrl(provider, urlKey);

  let events: string[];
  let target: string;
  if (provider === "github") {
    events = hookEventsFor(text(config.event));
    target = (() => {
      try {
        return parseRepository(config.repository).fullName;
      } catch {
        return text(config.repository);
      }
    })();
  } else if (provider === "slack") {
    /* The node's channel is the subscription: everything else Slack
       sends is dropped by the receiver before a run is started. */
    events = ["message"];
    target = text(config.channel);
  } else {
    events = [text(config.label)].filter(Boolean);
    target = text(config.query);
  }

  publishDefinition(actor, definition);

  const timestamp = now();
  if (existing) {
    sqlRun(
      `UPDATE provider_webhooks
          SET target = ?, events = ?, credential_id = ?, secret_enc = ?, status = ?, last_error = NULL, updated_at = ?
        WHERE id = ?`,
      target,
      events.join(","),
      credentialId,
      encryptSecret(secret),
      existing.status === "error" ? "pending" : existing.status,
      timestamp,
      existing.id,
    );
  } else {
    sqlRun(
      `INSERT INTO provider_webhooks
         (id, provider, workspace_id, workflow_id, workflow_version_id, credential_id,
          target, events, url_key, secret_enc, mode, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      `pwh_${randomBytes(9).toString("base64url")}`,
      provider,
      actor.workspaceId,
      definition.id,
      credentialId,
      target,
      events.join(","),
      urlKey,
      encryptSecret(secret),
      provider === "github" ? "managed" : "manual",
      timestamp,
      timestamp,
    );
  }

  const row = queryOne<Row>(
    "SELECT * FROM provider_webhooks WHERE workflow_id = ? AND workspace_id = ?",
    definition.id,
    actor.workspaceId,
  )!;

  if (provider === "github") {
    const registration = await registerGitHubHook(actor, row, url, secret, events);
    if (registration.warning) {
      const fresh = queryOne<Row>("SELECT * FROM provider_webhooks WHERE id = ?", row.id)!;
      return {
        webhook: { ...toView(fresh), secret },
        warning: registration.warning,
      };
    }
  } else if (provider === "slack") {
    sqlRun(
      `UPDATE provider_webhooks
          SET status = ?, last_error = ?, updated_at = ?
        WHERE id = ?`,
      missingSigningSecret ? "error" : "ready",
      missingSigningSecret
        ? "SLACK_SIGNING_SECRET is not set, so no delivery can be verified."
        : null,
      now(),
      row.id,
    );
    const slackRow = queryOne<Row>("SELECT * FROM provider_webhooks WHERE id = ?", row.id)!;
    if (missingSigningSecret) {
      return {
        webhook: toView(slackRow),
        warning: {
          code: "SLACK_SIGNING_SECRET_MISSING",
          message: "Slack deliveries are refused until KLYZ can verify their signature.",
          hint: "Copy the Signing Secret from your Slack app's Basic Information page, set SLACK_SIGNING_SECRET in KLYZ's environment, then publish again.",
        },
      };
    }
    const channelWarning = await checkSlackChannel(actor, credentialId, target);
    if (channelWarning) {
      return { webhook: toView(slackRow), warning: channelWarning };
    }
  } else {
    sqlRun(
      "UPDATE provider_webhooks SET status = 'ready', updated_at = ? WHERE id = ?",
      now(),
      row.id,
    );
  }

  const fresh = queryOne<Row>("SELECT * FROM provider_webhooks WHERE id = ?", row.id)!;
  return {
    webhook: { ...toView(fresh), ...(provider === "github" ? { secret } : {}) },
  };
}

/**
 * Publish-time check that the trigger's channel is real and the app can
 * see it — a `#name` that resolves to nothing is a workflow that never
 * fires, which is far cheaper to report now than after the first
 * message. Nothing is written: the receiver resolves again (through the
 * 60s lookup cache) so an invite granted later keeps working.
 */
async function checkSlackChannel(
  actor: Actor,
  credentialId: string,
  channel: string,
): Promise<RegistrationResult["warning"]> {
  if (!channel) return undefined;
  try {
    const connection = await loadConnection(actor.workspaceId, credentialId, "slack");
    const found = await findChannel(connection, channel);
    if (found) return undefined;
    return {
      code: "SLACK_CHANNEL_UNRESOLVED",
      message: `Slack has no channel "${channel}" that this app can see.`,
      hint: "Invite the Slack app to the channel (or paste the channel id), then publish again. Until then messages in that channel will not start this workflow.",
    };
  } catch {
    return {
      code: "SLACK_CHANNEL_UNRESOLVED",
      message: `The channel "${channel}" could not be checked against Slack.`,
      hint: "Check the connection on the trigger, then publish again.",
    };
  }
}

interface RegistrationResult {
  warning?: { code: string; message: string; hint: string };
}

async function registerGitHubHook(
  actor: Actor,
  row: Row,
  url: string,
  secret: string,
  events: string[],
): Promise<RegistrationResult> {
  if (events.length === 0) {
    return {
      warning: {
        code: "GITHUB_EVENT_INVALID",
        message: "The trigger's event could not be turned into a GitHub subscription.",
        hint: "Pick an event on the GitHub event node and publish again.",
      },
    };
  }

  const repository = parseRepository(row.target);
  const connection = await loadConnection(actor.workspaceId, row.credential_id ?? "", "github");

  try {
    const { githubRequest } = await import("@/lib/integrations/github/api");
    const payload = {
      name: "web",
      active: true,
      events,
      config: { url, content_type: "json", secret },
    };
    if (row.remote_hook_id) {
      await githubRequest(
        connection,
        "hooks.update",
        `/repos/${repository.owner}/${repository.name}/hooks/${row.remote_hook_id}`,
        { method: "PATCH", body: payload },
      );
    } else {
      const created = await githubRequest<{ id?: number }>(
        connection,
        "hooks.create",
        `/repos/${repository.owner}/${repository.name}/hooks`,
        { method: "POST", body: payload },
      );
      sqlRun(
        "UPDATE provider_webhooks SET remote_hook_id = ? WHERE id = ?",
        String(created.id ?? ""),
        row.id,
      );
    }
    sqlRun(
      `UPDATE provider_webhooks
          SET status = 'active', last_error = NULL, updated_at = ?
        WHERE id = ?`,
      now(),
      row.id,
    );
    return {};
  } catch (error) {
    const message = redactMessage(error instanceof Error ? error.message : String(error));
    const scopeProblem = /admin:repo_hook|resource not accessible|bad credentials|403/i.test(
      message,
    );
    sqlRun(
      `UPDATE provider_webhooks
          SET status = 'error', last_error = ?, updated_at = ?
        WHERE id = ?`,
      message,
      now(),
      row.id,
    );
    return {
      warning: {
        code: "GITHUB_HOOK_REGISTRATION_FAILED",
        message: scopeProblem
          ? "GitHub refused to create the repository webhook."
          : "The repository webhook could not be created.",
        hint: scopeProblem
          ? `The connection needs the admin:repo_hook scope (${message}). Reconnect GitHub with KLYZ_GITHUB_SCOPES=public_repo,admin:repo_hook (add repo for private repositories), then publish again — or add the webhook by hand using the URL and secret shown here.`
          : `GitHub responded with an error: ${message}. Check the repository name and the connection, then publish again — or add the webhook by hand using the URL and secret shown here.`,
      },
    };
  }
}

export async function unpublishProviderWebhook(
  actor: Actor,
  workflowId: string,
): Promise<void> {
  const row = queryOne<Row>(
    "SELECT * FROM provider_webhooks WHERE workflow_id = ? AND workspace_id = ?",
    workflowId,
    actor.workspaceId,
  );
  if (!row) {
    throw new HttpError(404, "NOT_FOUND", "This workflow has no provider endpoint.");
  }

  if (row.provider === "github" && row.remote_hook_id && row.credential_id) {
    try {
      const repository = parseRepository(row.target);
      const connection = await loadConnection(actor.workspaceId, row.credential_id, "github");
      await githubRequest(
        connection,
        "hooks.delete",
        `/repos/${repository.owner}/${repository.name}/hooks/${row.remote_hook_id}`,
        { method: "DELETE" },
      );
    } catch {
      /* A hook already deleted remotely is the outcome we wanted. */
    }
  }

  sqlRun("DELETE FROM provider_webhooks WHERE id = ?", row.id);
}

function generateSecret(): string {
  return `klyz_${randomBytes(24).toString("base64url")}`;
}

function endpointUrl(provider: ProviderId, key: string): string {
  const base = process.env.KLYZ_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  return `${base}/api/providers/${provider}/hooks/${key}`;
}

function toView(row: Row): ProviderWebhookView {
  return {
    id: row.id,
    provider: row.provider as ProviderId,
    workflowId: row.workflow_id,
    url: endpointUrl(row.provider as ProviderId, row.url_key),
    target: row.target,
    events: row.events ? row.events.split(",").filter(Boolean) : [],
    mode: row.mode === "manual" ? "manual" : "managed",
    status: row.status as ProviderWebhookView["status"],
    remoteHookId: row.remote_hook_id,
    lastError: row.last_error,
    secretSet: !!row.secret_enc,
    deliveryCount: row.delivery_count,
    lastDeliveryAt: row.last_delivery_at ? new Date(row.last_delivery_at).toISOString() : null,
    lastDeliveryStatus: row.last_delivery_status,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Receiver                                                            */
/* ------------------------------------------------------------------ */

export interface DeliveryResult {
  status: number;
  body: Record<string, unknown>;
}

export async function receiveProviderDelivery(
  request: Request,
  provider: ProviderId,
  key: string,
): Promise<DeliveryResult> {
  const row = lookupRow(provider, key);
  if (!row) {
    throw new HttpError(404, "PROVIDER_HOOK_NOT_FOUND", "No endpoint matches this URL.");
  }

  const raw = await readRawBody(request);
  if (provider === "github") return receiveGitHub(request, row, raw);
  if (provider === "slack") return receiveSlack(request, row, raw);
  return receiveGmail(request, row, raw);
}

function lookupRow(provider: ProviderId, key: string): Row | undefined {
  const candidate = key.trim().replace(/^\/+|\/+$/g, "");
  if (!candidate) return undefined;
  return queryOne<Row>(
    "SELECT * FROM provider_webhooks WHERE url_key = ? AND provider = ?",
    candidate,
    provider,
  );
}

async function receiveGitHub(
  request: Request,
  row: Row,
  raw: Buffer,
): Promise<DeliveryResult> {
  const delivery = parseGitHubDelivery(Object.fromEntries([...request.headers.entries()]));
  const secret = decryptSecret(row.secret_enc);

  if (!verifyGitHubSignature(raw, delivery.signature, secret)) {
    record(row, "rejected");
    throw new HttpError(
      401,
      GITHUB_ERRORS.deliveryRejected,
      "The GitHub signature does not match this endpoint's secret.",
    );
  }

  if (delivery.event === "ping") {
    record(row, "accepted");
    return { status: 200, body: { ok: true, event: "ping" } };
  }

  const payload = parseJson(raw);
  const action = typeof payload.action === "string" ? payload.action : undefined;
  if (!matchesSubscribed(row, delivery.event, action)) {
    record(row, "ignored");
    return {
      status: 200,
      body: {
        ok: true,
        ignored: true,
        reason: "event not subscribed by this workflow",
        event: delivery.event,
        action: action ?? null,
      },
    };
  }

  if (delivery.event === "push" && !matchesBranch(row, payload)) {
    record(row, "ignored");
    return {
      status: 200,
      body: { ok: true, ignored: true, reason: "branch filter did not match" },
    };
  }

  const deliveryId = delivery.deliveryId || hashOf(raw);
  const executionId = await startRun(row, {
    provider: "github",
    hookEvent: delivery.event,
    deliveryId,
    payload,
    receivedAt: new Date().toISOString(),
  }, deliveryId);

  record(row, "accepted");
  return {
    status: 202,
    body: { ok: true, event: delivery.event, executionId, deliveryId },
  };
}

async function receiveGmail(
  request: Request,
  row: Row,
  raw: Buffer,
): Promise<DeliveryResult> {
  const url = endpointUrl("gmail", row.url_key);
  await verifyGooglePushToken(request.headers.get("authorization"), url);

  const envelope = parseJson(raw) as {
    message?: { data?: string; messageId?: string; publishTime?: string };
    subscription?: string;
  };
  const inner = envelope.message?.data
    ? parseJson(Buffer.from(envelope.message.data, "base64url").toString("utf8"))
    : {};
  const deliveryId =
    envelope.message?.messageId || hashOf(raw);
  const historyId =
    typeof inner.historyId === "string" || typeof inner.historyId === "number"
      ? String(inner.historyId)
      : "";

  const executionId = await startRun(
    row,
    {
      provider: "gmail",
      hookEvent: "mail",
      deliveryId,
      payload: { historyId, subscription: envelope.subscription ?? "" },
      receivedAt: new Date().toISOString(),
    },
    deliveryId,
  );

  record(row, "accepted");
  return { status: 202, body: { ok: true, executionId, deliveryId, historyId } };
}

/**
 * Slack Events API receiver.
 *
 * Verification runs over the exact bytes Slack signed — the timestamp is
 * part of the HMAC, so a captured delivery cannot be replayed — and
 * everything that must not start a run is answered `200` anyway, because
 * Slack retries any other status forever.
 *
 * Three filters decide whether a message becomes a run, in this order:
 * the signature, the workspace the connection belongs to (one Events URL
 * serves every workspace the app is installed in) and the channel the
 * node subscribed to. `event_id` is the idempotency key, so Slack's own
 * redeliveries land on the run that already exists.
 */
async function receiveSlack(request: Request, row: Row, raw: Buffer): Promise<DeliveryResult> {
  const delivery = parseSlackDelivery(Object.fromEntries([...request.headers.entries()]));
  const verified = verifySlackSignature({
    rawBody: raw,
    signature: delivery.signature ?? null,
    timestamp: delivery.timestamp ?? null,
    secret: decryptSecret(row.secret_enc),
  });
  if (!verified.ok) {
    record(row, "rejected");
    throw new HttpError(
      401,
      SLACK_ERRORS.signatureRejected,
      verified.reason === "missing"
        ? "This Slack delivery carried no signature."
        : verified.reason === "stale"
          ? "This Slack delivery is outside the replay window."
          : "The Slack signature does not match this endpoint's secret.",
      { hint: "Set SLACK_SIGNING_SECRET to the Slack app's signing secret, then publish again." },
    );
  }

  const payload = parseJson(raw);
  const challenge = parseSlackChallenge(payload);
  if (challenge) {
    record(row, "accepted");
    return { status: 200, body: { challenge } };
  }

  const config = publishedTriggerConfig(row.workflow_id, "trigger.slack");
  const kind = slackMessageKind(payload);
  if (!kind || (kind === "bot" && !flagOn(config?.includeBots))) {
    record(row, "ignored");
    return {
      status: 200,
      body: {
        ok: true,
        ignored: true,
        reason: kind ? "bot messages are excluded by this trigger" : "not a message event",
      },
    };
  }

  const event = asRecord(payload.event);
  let connection: ProviderConnection | null = null;
  if (row.credential_id) {
    try {
      connection = await loadConnection(row.workspace_id, row.credential_id, "slack");
    } catch {
      /* Without the connection the workspace cannot be checked; the
         signature still proved the delivery came from Slack. */
      connection = null;
    }
  }

  const expectedTeam = text(connection?.extra.teamId);
  const deliveredTeam = text(event.team) || text(payload.team_id);
  if (expectedTeam && deliveredTeam && expectedTeam !== deliveredTeam) {
    record(row, "rejected");
    throw new HttpError(
      403,
      "SLACK_TENANT_MISMATCH",
      "This delivery belongs to a different Slack workspace than the trigger's connection.",
    );
  }

  const channel = text(event.channel);
  const subscribed = text(config?.channel);
  if (subscribed && !(await slackChannelMatches(connection, subscribed, channel))) {
    record(row, "ignored");
    return {
      status: 200,
      body: { ok: true, ignored: true, reason: "channel filter did not match" },
    };
  }

  const deliveryId = text(payload.event_id) || hashOf(raw);
  const executionId = await startRun(
    row,
    {
      provider: "slack",
      hookEvent: "message",
      deliveryId,
      payload,
      receivedAt: new Date().toISOString(),
    },
    deliveryId,
  );

  record(row, "accepted");
  return { status: 202, body: { ok: true, event: "message", executionId, deliveryId } };
}

/**
 * Does this message arrive in the channel the node subscribed to?
 *
 * An id is compared directly; a `#name` is resolved through the lookup
 * cache, so a workflow that subscribes to `#support` keeps working after
 * the first resolution. A channel that cannot be resolved is *not* a
 * match — a filter that silently accepts everything is not a filter.
 */
async function slackChannelMatches(
  connection: ProviderConnection | null,
  subscribed: string,
  channel: string,
): Promise<boolean> {
  if (!channel) return false;
  const ref = normaliseChannelRef(subscribed);
  if (!ref) return true;
  if (looksLikeChannelId(ref)) return ref === channel;
  if (!connection) return false;
  try {
    const found = await findChannel(connection, ref);
    return found ? found.id === channel : false;
  } catch {
    return false;
  }
}

/**
 * Does this delivery match what the node subscribes to?
 *
 * `row.events` holds the raw hook names (`issues`, `push`) registered
 * with GitHub, but `matchesEvent` wants the node's configured value
 * (`issues.opened`) so that the action is checked too — hence the node
 * config is the source of truth, with the published list as a fallback
 * when the trigger node has since been removed.
 */
function matchesSubscribed(row: Row, hookEvent: string, action?: string): boolean {
  const configured = text(publishedTriggerConfig(row.workflow_id, "trigger.github")?.event);
  if (configured) return matchesEvent(configured, hookEvent, action);
  const subscribed = row.events ? row.events.split(",").filter(Boolean) : [];
  return subscribed.includes(hookEvent);
}

/** Push events for `push` carry the branch in `ref`; the node may filter. */
function matchesBranch(row: Row, payload: Record<string, unknown>): boolean {
  const config = publishedTriggerConfig(row.workflow_id, "trigger.github");
  const branch = text(config?.branch);
  if (!branch) return true;
  const ref = text(payload.ref);
  const actual = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  return actual === branch;
}

function publishedTriggerConfig(workflowId: string, type: string): Record<string, unknown> | null {
  const version = queryOne<{ definition: string }>(
    "SELECT definition FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1",
    workflowId,
  );
  if (!version) return null;
  try {
    return triggerConfig(JSON.parse(version.definition) as Workflow, type);
  } catch {
    return null;
  }
}

async function startRun(
  row: Row,
  input: Record<string, unknown>,
  deliveryId: string,
): Promise<string> {
  const deduped = exec(
    `INSERT INTO provider_deliveries
       (provider, workflow_id, delivery_id, received_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    row.provider,
    row.workflow_id,
    deliveryId,
    now(),
  );
  if (deduped === 0) {
    const seen = queryOne<{ execution_id: string | null }>(
      `SELECT execution_id FROM provider_deliveries
        WHERE provider = ? AND workflow_id = ? AND delivery_id = ?`,
      row.provider,
      row.workflow_id,
      deliveryId,
    );
    throw new DuplicateDelivery(seen?.execution_id ?? "");
  }

  const definition = publishedDefinition(row.workflow_id, row.workspace_id);
  const execution = await startWorkflowRun(
    { userId: "u_webhook", workspaceId: row.workspace_id },
    {
      definition,
      input,
      source: "webhook",
      trigger: { type: triggerTypeFor(row.provider as ProviderId) },
    },
  );

  sqlRun(
    "UPDATE provider_deliveries SET execution_id = ? WHERE provider = ? AND workflow_id = ? AND delivery_id = ?",
    execution.id,
    row.provider,
    row.workflow_id,
    deliveryId,
  );
  return execution.id;
}

/** A redelivery we have already handled — answer 200, start nothing. */
export class DuplicateDelivery extends Error {
  readonly executionId: string;
  constructor(executionId: string) {
    super("This delivery was already processed.");
    this.name = "DuplicateDelivery";
    this.executionId = executionId;
  }
}

function publishedDefinition(workflowId: string, workspaceId: string): Workflow {
  /* The workflow's own pointer is what a delivery runs; the "latest
     version" fallback only covers rows written before it existed. */
  const pinned = queryOne<{ definition: string }>(
    `SELECT v.definition
       FROM workflows w
       JOIN workflow_versions v ON v.id = w.published_version_id
      WHERE w.id = ? AND w.workspace_id = ?`,
    workflowId,
    workspaceId,
  );
  const version =
    pinned ??
    queryOne<{ definition: string }>(
      `SELECT definition FROM workflow_versions
        WHERE workflow_id = ? AND workspace_id = ?
        ORDER BY version DESC LIMIT 1`,
      workflowId,
      workspaceId,
    );
  if (!version) {
    throw new HttpError(
      404,
      "PROVIDER_WORKFLOW_INACTIVE",
      "This endpoint has no published workflow yet.",
    );
  }
  try {
    return JSON.parse(version.definition) as Workflow;
  } catch {
    throw new HttpError(
      404,
      "PROVIDER_WORKFLOW_INACTIVE",
      "The published workflow version could not be read.",
    );
  }
}

function record(row: Row, status: string): void {
  sqlRun(
    `UPDATE provider_webhooks
        SET delivery_count = delivery_count + 1,
            last_delivery_at = ?,
            last_delivery_status = ?,
            updated_at = ?
      WHERE id = ?`,
    now(),
    status,
    now(),
    row.id,
  );
}

/** Provider deliveries are capped so a public hook cannot buffer without bound. */
const MAX_DELIVERY_BYTES = 1_048_576;

async function readRawBody(request: Request): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_DELIVERY_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The delivery is too large.");
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    throw new HttpError(400, "BAD_BODY", "The request body could not be read.");
  }
  if (bytes.byteLength > MAX_DELIVERY_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The delivery is too large.");
  }
  return Buffer.from(bytes);
}

function parseJson(raw: Buffer | string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function hashOf(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Every endpoint in a workspace — used by the endpoint list. */
export function listProviderWebhooks(actor: Actor): ProviderWebhookView[] {
  return queryAll<Row>(
    "SELECT * FROM provider_webhooks WHERE workspace_id = ? ORDER BY updated_at DESC",
    actor.workspaceId,
  ).map(toView);
}
