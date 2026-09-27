import type { CredentialKind } from "@/lib/workflow/types";

/**
 * Typed client for the integrations API (credentials + endpoints).
 *
 * Credential values never round-trip: the API only returns ids, names,
 * kinds and timestamps, and "test connection" happens server-side.
 */

export interface CredentialSummary {
  id: string;
  name: string;
  kind: CredentialKind;
  createdAt: string;
  updatedAt: string;
  /** Connection lifecycle; `connected` for manually stored secrets. */
  status: string;
  /** Account label for OAuth connections — never a token. */
  account: string | null;
  scopes: string[];
  expiresAt: string | null;
  lastError: string | null;
}

export interface CredentialTestResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export interface WebhookEndpointView {
  id: string;
  workflowId: string;
  slug: string;
  url: string;
  path: string;
  method: string;
  auth: "none" | "header" | "hmac";
  secretSet: boolean;
  enabled: boolean;
  deliveryCount: number;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
  sample: string | null;
  updatedAt: string;
}

export class ClientApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ClientApiError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch {
    throw new ClientApiError(0, "NETWORK", "Could not reach the server.");
  }
  const payload = (await response.json().catch(() => null)) as (ErrorPayload & T) | null;
  if (!response.ok) {
    throw new ClientApiError(
      response.status,
      payload?.error?.code ?? "REQUEST_FAILED",
      payload?.error?.message ?? `Request failed (${response.status}).`,
    );
  }
  return payload as T;
}

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

export interface CredentialInput {
  name: string;
  kind: CredentialKind;
  fields: Record<string, string>;
}

export async function listCredentials(): Promise<CredentialSummary[]> {
  const payload = await request<{ credentials: CredentialSummary[] }>("/api/credentials");
  return payload.credentials;
}

export async function createCredential(input: CredentialInput): Promise<CredentialSummary> {
  const payload = await request<{ credential: CredentialSummary }>("/api/credentials", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.credential;
}

export async function deleteCredential(id: string): Promise<void> {
  await request(`/api/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function testCredential(id: string): Promise<CredentialTestResult> {
  const payload = await request<{ result: CredentialTestResult }>(
    `/api/credentials/${encodeURIComponent(id)}/test`,
    { method: "POST" },
  );
  return payload.result;
}

/* ------------------------------------------------------------------ */
/* Webhook endpoints                                                   */
/* ------------------------------------------------------------------ */

export async function getWorkflowWebhook(
  workflowId: string,
): Promise<WebhookEndpointView | null> {
  const payload = await request<{ webhook: WebhookEndpointView | null }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/webhook`,
  );
  return payload.webhook;
}

export async function publishWorkflowWebhook(
  workflowId: string,
  config: Record<string, unknown>,
): Promise<WebhookEndpointView> {
  const payload = await request<{ webhook: WebhookEndpointView }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/webhook`,
    { method: "PUT", body: JSON.stringify({ config }) },
  );
  return payload.webhook;
}

export async function deleteWorkflowWebhook(workflowId: string): Promise<void> {
  await request(`/api/workflows/${encodeURIComponent(workflowId)}/webhook`, {
    method: "DELETE",
  });
}

/* ------------------------------------------------------------------ */
/* Trigger (enable switch + schedule)                                  */
/* ------------------------------------------------------------------ */

export type TriggerType = "manual" | "webhook" | "schedule";

export interface TriggerFireView {
  at: string;
  status: string;
  executionId: string | null;
  error: string | null;
}

export interface TriggerScheduleView {
  cron: string;
  every: string;
  timezone: string;
  nextRunAt: string | null;
  preview: string[];
}

export interface TriggerView {
  managed: boolean;
  type: TriggerType | null;
  enabled: boolean;
  armed: boolean;
  blockedBy: string | null;
  schedule: TriggerScheduleView | null;
  webhook: { enabled: boolean } | null;
  last: TriggerFireView | null;
  recent: TriggerFireView[];
  updatedAt: string | null;
}

/**
 * Read a workflow's trigger state.
 *
 * `nextRunAt` and `preview` come from the server, computed with the
 * same cron parser the scheduler uses — the editor never predicts a
 * fire time of its own.
 */
export async function getWorkflowTrigger(workflowId: string): Promise<TriggerView> {
  const payload = await request<{ trigger: TriggerView }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/trigger`,
  );
  return payload.trigger;
}

export interface TriggerInput {
  enabled?: boolean;
  schedule?: { every?: string; cron?: string; timezone?: string };
}

export async function setWorkflowTrigger(
  workflowId: string,
  input: TriggerInput,
): Promise<TriggerView> {
  const payload = await request<{ trigger: TriggerView }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/trigger`,
    { method: "PUT", body: JSON.stringify(input) },
  );
  return payload.trigger;
}

/* ------------------------------------------------------------------ */
/* Providers (OAuth connections, Gmail push watch)                     */
/* ------------------------------------------------------------------ */

export type ProviderId = "github" | "gmail" | "google_sheets" | "notion" | "slack";

export interface ProviderScopeView {
  scope: string;
  label: string;
  granted: boolean;
}

export interface WatchView {
  credentialId: string;
  status: string;
  topic: string | null;
  historyId: string | null;
  expiresAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface ProviderSummary {
  id: ProviderId;
  label: string;
  configured: boolean;
  issues: string[];
  scopes: ProviderScopeView[];
  callbackUrl: string;
  connections: CredentialSummary[];
  watch?: WatchView | null;
  nodes: string[];
}

export interface ConnectResult {
  url: string;
  provider: ProviderId;
  scopes: string[];
  callbackUrl: string;
}

export async function listProviders(): Promise<ProviderSummary[]> {
  const payload = await request<{ providers: ProviderSummary[] }>("/api/providers");
  return payload.providers;
}

export async function startProviderConnect(provider: ProviderId): Promise<ConnectResult> {
  return request<ConnectResult>(`/api/providers/${provider}/connect`, { method: "POST" });
}

export async function disconnectProvider(
  provider: ProviderId,
  credentialId: string,
): Promise<CredentialSummary> {
  const payload = await request<{ credential: CredentialSummary }>(
    `/api/providers/${provider}/connections/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" },
  );
  return payload.credential;
}

export interface WatchResult {
  watch: WatchView | null;
  topic: string | null;
}

export async function setProviderWatch(provider: ProviderId): Promise<WatchResult> {
  return request<WatchResult>(`/api/providers/${provider}/watch`, { method: "POST" });
}

export async function stopProviderWatch(provider: ProviderId): Promise<WatchResult> {
  return request<WatchResult>(`/api/providers/${provider}/watch`, { method: "DELETE" });
}

/* ------------------------------------------------------------------ */
/* Provider endpoints (GitHub hook / Gmail push subscription)          */
/* ------------------------------------------------------------------ */

export interface ProviderWarning {
  code: string;
  message: string;
  hint: string;
}

export interface ProviderWebhookView {
  id: string;
  provider: ProviderId;
  workflowId: string;
  url: string;
  target: string;
  events: string[];
  mode: "managed" | "manual";
  status: "pending" | "active" | "ready" | "error" | "disabled";
  remoteHookId: string | null;
  lastError: string | null;
  secretSet: boolean;
  /** Plaintext — only present on the response that created it. */
  secret?: string;
  deliveryCount: number;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
  updatedAt: string;
}

export async function getProviderWebhook(
  workflowId: string,
): Promise<ProviderWebhookView | null> {
  const payload = await request<{ webhook: ProviderWebhookView | null }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/provider-webhook`,
  );
  return payload.webhook;
}

export async function publishProviderWebhook(
  workflowId: string,
): Promise<{ webhook: ProviderWebhookView; warning: ProviderWarning | null }> {
  return request(
    `/api/workflows/${encodeURIComponent(workflowId)}/provider-webhook`,
    { method: "PUT", body: JSON.stringify({}) },
  );
}

export async function deleteProviderWebhook(workflowId: string): Promise<void> {
  await request(`/api/workflows/${encodeURIComponent(workflowId)}/provider-webhook`, {
    method: "DELETE",
  });
}

/* ------------------------------------------------------------------ */
/* Shared labels                                                       */
/* ------------------------------------------------------------------ */

export const CREDENTIAL_KIND_LABEL: Record<CredentialKind, string> = {
  gmail: "Gmail",
  github: "GitHub",
  slack: "Slack",
  notion: "Notion",
  google_sheets: "Google Sheets",
  postgres: "PostgreSQL",
  http_basic: "HTTP basic auth",
  http_bearer: "HTTP bearer token",
  http_header: "HTTP custom header",
};

/** Kinds the create form offers — the integrations actually shipping today. */
export const CREATEABLE_CREDENTIAL_KINDS: CredentialKind[] = [
  "postgres",
  "http_basic",
  "http_bearer",
  "http_header",
];
