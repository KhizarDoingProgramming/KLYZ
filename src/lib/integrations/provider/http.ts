import { performHttpRequest } from "@/lib/integrations/http/request";
import { assertTarget, type UrlPolicy } from "@/lib/integrations/http/ssrf";
import { recordProviderCall } from "@/lib/execution/telemetry";
import { redactUrl } from "@/lib/server/redact";
import {
  ProviderError,
  errorFromResponse,
  providerMessageFrom,
  type ProviderErrorCategory,
} from "./errors";
import { providerLabel, type ProviderId } from "./types";

/**
 * The one way a provider module talks to its API.
 *
 * Three guarantees on top of the shared HTTP transport:
 *
 *  1. **Host pinning** — a provider client can only reach the documented
 *     endpoints for that provider (allowlist built from the URL), so a
 *     misconfigured redirect or an attacker-controlled repository name
 *     can never turn a node into a generic SSRF proxy.
 *  2. **Normalised failures** — non-2xx responses become
 *     {@link ProviderError} with a category, retryability and request id,
 *     never a raw stack trace in the execution debugger.
 *  3. **Rate-limit awareness** — `429` (and GitHub's `403` with
 *     `x-ratelimit-remaining: 0`) carry the provider's own reset timing
 *     into the error so retries are informed instead of blind.
 */

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** Epoch ms when the window resets, when the provider said so. */
  resetAt: number | null;
  retryAfterMs: number | null;
}

export interface ProviderCall {
  provider: ProviderId;
  operation: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Raw body (already serialised). */
  body?: string;
  /** Convenience: JSON-encode and set the content type. */
  json?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface ProviderResult<T> {
  status: number;
  headers: Record<string, string>;
  data: T;
  text: string;
  durationMs: number;
  rateLimit: RateLimitInfo | null;
}

const PROVIDER_HOSTS: Record<ProviderId, string[]> = {
  github: ["api.github.com", "github.com", "uploads.github.com"],
  gmail: [
    "gmail.googleapis.com",
    "www.googleapis.com",
    "oauth2.googleapis.com",
    "accounts.google.com",
    "people.googleapis.com",
  ],
  /* Sheets talks to its own API host; the OAuth hosts are shared with
     Gmail because the deployment uses one Google client. No Drive host —
     KLYZ never lists or creates files. */
  google_sheets: [
    "sheets.googleapis.com",
    "www.googleapis.com",
    "oauth2.googleapis.com",
    "accounts.google.com",
  ],
  notion: ["api.notion.com"],
  slack: ["slack.com", "slack-api.slack.com", "accounts.slack.com"],
};

export function providerPolicy(provider: ProviderId, url: URL): UrlPolicy {
  const host = url.hostname.toLowerCase();
  const allowed = PROVIDER_HOSTS[provider];
  return { allowHosts: allowed.includes(host) ? allowed : [host], allowPrivate: false };
}

export async function providerFetch<T = unknown>(
  call: ProviderCall,
): Promise<ProviderResult<T>> {
  const method = (call.method ?? "GET").toUpperCase();
  const url = assertTarget(call.url, providerPolicy(call.provider, new URL(call.url)));

  const headers: Record<string, string> = {
    accept: "application/json, */*",
    "user-agent": "KLYZ-Integration/1.0",
    ...(call.headers ?? {}),
  };
  let body = call.body;
  if (call.json !== undefined) {
    body = JSON.stringify(call.json);
    if (!hasHeader(headers, "content-type")) headers["content-type"] = "application/json";
  }

  const startedAt = Date.now();
  const safeUrl = redactUrl(url);
  let result;
  try {
    result = await performHttpRequest({
      method,
      url,
      headers,
      body,
      timeoutMs: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: call.maxBytes ?? DEFAULT_MAX_BYTES,
      policy: providerPolicy(call.provider, url),
      signal: call.signal,
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    recordProviderCall({
      provider: call.provider,
      operation: call.operation,
      method,
      url: safeUrl,
      status: null,
      ok: false,
      durationMs,
      error: errorCodeOf(error),
    });
    throw transportError(call, error, durationMs);
  }

  const durationMs = Date.now() - startedAt;
  const responseHeaders = lowerHeaders(result.headers);
  const rateLimit = readRateLimit(responseHeaders);
  const parsed = parseBody(result.body, responseHeaders["content-type"] ?? "");
  logProviderEvent({
    provider: call.provider,
    operation: call.operation,
    status: result.status,
    durationMs,
    rateLimited: rateLimit?.remaining === 0 && result.status >= 400,
  });

  const failed = result.status < 200 || result.status >= 300;
  const providerError = failed
    ? errorFromResponse({
        provider: call.provider,
        operation: call.operation,
        status: result.status,
        headers: new Headers(responseHeaders),
        body: parsed,
      })
    : null;
  recordProviderCall({
    provider: call.provider,
    operation: call.operation,
    method,
    url: safeUrl,
    status: result.status,
    ok: !failed,
    durationMs,
    requestId:
      responseHeaders["x-request-id"] ?? responseHeaders["x-github-request-id"],
    rateLimit: rateLimit
      ? {
          limit: rateLimit.limit,
          remaining: rateLimit.remaining,
          resetAt: rateLimit.resetAt,
          retryAfterMs: rateLimit.retryAfterMs,
        }
      : undefined,
    error: providerError ? providerError.code : undefined,
  });

  if (providerError) throw providerError;

  return {
    status: result.status,
    headers: responseHeaders,
    data: parsed as T,
    text: result.body,
    durationMs,
    rateLimit,
  };
}

/** Same guarantees, but the raw text is what the caller wants (MIME, …). */
export async function providerFetchText(
  call: ProviderCall,
): Promise<ProviderResult<string>> {
  const result = await providerFetch<unknown>(call);
  return { ...result, data: result.text };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function lowerHeaders(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) out[key.toLowerCase()] = value;
  return out;
}

function readRateLimit(headers: Record<string, string>): RateLimitInfo | null {
  const limit = num(headers["x-ratelimit-limit"] ?? headers["ratelimit-limit"]);
  const remaining = num(headers["x-ratelimit-remaining"] ?? headers["ratelimit-remaining"]);
  const resetRaw = headers["x-ratelimit-reset"] ?? headers["ratelimit-reset"];
  const reset = num(resetRaw);
  const retryAfter = num(headers["retry-after"]);
  const retryAfterMs = retryAfter !== null ? retryAfter * 1000 : null;
  if (limit === null && remaining === null && retryAfterMs === null) return null;
  return {
    limit,
    remaining,
    resetAt: reset !== null ? (reset > 1e12 ? reset : reset * 1000) : null,
    retryAfterMs,
  };
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBody(text: string, contentType: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (contentType.includes("x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(trimmed).entries());
  }
  return trimmed;
}

function transportError(call: ProviderCall, error: unknown, durationMs: number): ProviderError {
  if (error instanceof ProviderError) return error;  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const engineCode =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";

  let category: ProviderErrorCategory = "network";
  if (
    engineCode === "HTTP_TIMEOUT" ||
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    /timed out/i.test(message)
  ) {
    category = "timeout";
  } else if (engineCode === "HTTP_BLOCKED_TARGET") {
    category = "validation";
  } else if (/cancelled/i.test(message)) {
    category = "network";
  }

  logProviderEvent({
    provider: call.provider,
    operation: call.operation,
    status: 0,
    durationMs,
    error: category,
  });

  const label = providerLabel(call.provider);
  return new ProviderError(
    call.provider,
    category === "timeout"
      ? `${label} did not respond in time.`
      : `Could not reach ${label}.`,
    {
      operation: call.operation,
      category,
      providerMessage: providerMessageFrom({ message }) ?? message.slice(0, 200),
      cause: error,
    },
  );
}

/** Stable code for a transport failure — `HTTP_TIMEOUT`, `ETIMEDOUT`, … */
function errorCodeOf(error: unknown): string {
  if (error instanceof ProviderError) return error.code;
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown };
    if (typeof withCode.code === "string" && withCode.code) return withCode.code;
    if (/timed out/i.test(error.message)) return "HTTP_TIMEOUT";
    if (/cancelled/i.test(error.message)) return "HTTP_CANCELLED";
    return "HTTP_TRANSPORT";
  }
  return "HTTP_TRANSPORT";
}

/* ------------------------------------------------------------------ */
/* Structured logging — never contains tokens                          */
/* ------------------------------------------------------------------ */

export interface ProviderLogFields {
  provider: ProviderId | string;
  operation: string;
  workflowId?: string;
  executionId?: string;
  stepId?: string;
  status?: number;
  durationMs?: number;
  rateLimited?: boolean;
  error?: string;
}

export function logProviderEvent(fields: ProviderLogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    scope: "provider",
    ...fields,
    status: fields.status ?? 200,
  });
  if (fields.error) console.error(line);
  else console.log(line);
}
