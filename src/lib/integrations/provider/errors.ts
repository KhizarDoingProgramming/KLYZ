import { EngineError } from "@/lib/engine/types";
import type { ExecutionError } from "@/lib/workflow/types";
import { REMEDIATION, integrationError } from "../errors";
import { providerLabel, type ProviderId } from "./types";

/**
 * Normalised provider failures.
 *
 * GitHub and Gmail report errors in completely different shapes
 * (GitHub: `{message, documentation_url, errors[]}` with 401/403/422;
 * Gmail: `{error:{code, message, status, errors[]}}`). Everything that
 * leaves a provider module goes through here so the execution debugger
 * shows one understandable contract:
 *
 *   provider · operation · category · statusCode · retryable · userMessage
 *
 * `retryable` is the only thing the engine's attempt loop cares about,
 * and it is deliberately narrow: rate limits and transient upstream
 * failures retry; bad credentials, bad parameters and missing resources
 * never do.
 */

export type ProviderErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "not_found"
  | "rate_limit"
  | "timeout"
  | "provider_unavailable"
  | "network"
  | "unknown";

export interface ProviderErrorOptions {
  operation: string;
  category: ProviderErrorCategory;
  status?: number;
  /** Message from the provider, already redacted — kept for debugging. */
  providerMessage?: string;
  /** Provider request id (GitHub `x-github-request-id`, Google `x-goog-request-id`). */
  requestId?: string;
  /** Rate-limit reset (epoch ms) when the provider supplied one. */
  retryAfterMs?: number;
  retryable?: boolean;
  detail?: string;
  cause?: unknown;
}

const CATEGORY_REMEDIATION: Record<ProviderErrorCategory, keyof typeof REMEDIATION> = {
  authentication: "reconnect",
  authorization: "reconnect",
  validation: "inspect",
  not_found: "inspect",
  rate_limit: "retry",
  timeout: "retry",
  provider_unavailable: "retry",
  network: "retry",
  unknown: "inspect",
};

/** Categories where re-running the same step can plausibly succeed. */
const RETRYABLE_CATEGORIES = new Set<ProviderErrorCategory>([
  "rate_limit",
  "timeout",
  "provider_unavailable",
  "network",
]);

export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly operation: string;
  readonly category: ProviderErrorCategory;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly providerMessage?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly detail?: string;

  constructor(provider: ProviderId, message: string, options: ProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.operation = options.operation;
    this.category = options.category;
    this.statusCode = options.status;
    this.providerMessage = options.providerMessage;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
    this.detail = options.detail;
    this.retryable = options.retryable ?? RETRYABLE_CATEGORIES.has(options.category);
  }

  /** Stable machine code, e.g. `GITHUB_RATE_LIMIT`. */
  get code(): string {
    return `${this.provider.toUpperCase()}_${this.category.toUpperCase()}`;
  }

  toExecutionError(): ExecutionError {
    return this.toEngineError().toExecutionError();
  }

  toEngineError(): EngineError {
    return integrationError(this.code, this.message, {
      detail: this.buildDetail(),
      hint: this.hint(),
      remediation: REMEDIATION[CATEGORY_REMEDIATION[this.category]],
      httpStatus: this.statusCode,
      retryable: this.retryable,
      cause: this,
    });
  }

  private buildDetail(): string {
    const parts: string[] = [];
    if (this.operation) parts.push(`operation=${this.operation}`);
    if (this.statusCode !== undefined) parts.push(`status=${this.statusCode}`);
    if (this.requestId) parts.push(`requestId=${this.requestId}`);
    if (this.category === "rate_limit" && this.retryAfterMs) {
      parts.push(`retryAfterMs=${this.retryAfterMs}`);
    }
    const providerText = this.providerMessage || this.detail;
    if (providerText) parts.push(providerText);
    return parts.join(" · ");
  }

  private hint(): string {
    switch (this.category) {
      case "authentication":
        return "Reconnect the account on the Integrations page, then run again.";
      case "authorization":
        return "The granted permissions do not cover this action — reconnect with the required scopes.";
      case "rate_limit":
        return this.retryAfterMs
          ? `The engine waited and retried; the provider resets its window in ${Math.ceil(this.retryAfterMs / 1000)}s.`
          : "The engine retried this step with backoff; reduce how often the workflow calls the provider.";
      case "not_found":
        return "Check the spreadsheet, page, channel or identifier in the step configuration.";
      case "validation":
        return "Check the required fields on this step.";
      default:
        return "Inspect the step configuration and run again.";
    }
  }
}

/** Raised when a connection is missing, expired or revoked before a call. */
export function connectionError(
  provider: ProviderId,
  operation: string,
  message: string,
  category: ProviderErrorCategory = "authentication",
): ProviderError {
  return new ProviderError(provider, message, { operation, category });
}

/* ------------------------------------------------------------------ */
/* HTTP status → category                                             */
/* ------------------------------------------------------------------ */

export function categoryForStatus(status: number): ProviderErrorCategory {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (status === 422 || status === 400 || status === 405 || status === 415) {
    return "validation";
  }
  if (status >= 500) return "provider_unavailable";
  return "unknown";
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/* ------------------------------------------------------------------ */
/* Provider-specific payload extraction                                */
/* ------------------------------------------------------------------ */

/** Pulls the human-readable message out of a provider error body. */
export function providerMessageFrom(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }
  const error = record.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const inner = error as Record<string, unknown>;
    if (typeof inner.message === "string" && inner.message.trim()) {
      return inner.message.trim();
    }
    const list = inner.errors;
    if (Array.isArray(list) && list.length > 0) {
      const first = list[0];
      if (typeof first === "string") return first;
      if (first && typeof first === "object") {
        const item = first as Record<string, unknown>;
        const reason = item.reason ?? item.message ?? item.field;
        if (typeof reason === "string") return reason;
      }
    }
  }
  if (typeof record.reason === "string") return record.reason;
  return undefined;
}

/** Provider request id, when the response carried one. */
export function requestIdFrom(headers: Headers): string | undefined {
  return (
    headers.get("x-github-request-id") ??
    headers.get("x-goog-request-id") ??
    headers.get("x-request-id") ??
    undefined
  );
}

/**
 * Retry-after in ms, from either header. GitHub also reports the exact
 * window reset in `x-ratelimit-reset` (epoch seconds).
 */
export function retryAfterMsFrom(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(at - now, 0);
  }
  const remaining = headers.get("x-ratelimit-remaining");
  if (remaining === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(reset * 1000 - now, 0);
    }
  }
  return undefined;
}

/** Builds a normalised error from a non-2xx provider response. */
export function errorFromResponse(params: {
  provider: ProviderId;
  operation: string;
  status: number;
  headers: Headers;
  body: unknown;
  rawText?: string;
}): ProviderError {
  const { provider, operation, status, headers, body } = params;
  const category =
    status === 429 || (status === 403 && isRateLimited(body, headers))
      ? "rate_limit"
      : categoryForStatus(status);
  const providerMessage = providerMessageFrom(body);
  const label = providerLabel(provider);
  return new ProviderError(
    provider,
    providerMessage
      ? `${label}: ${providerMessage}`
      : `${label} responded with HTTP ${status}.`,
    {
      operation,
      category,
      status,
      providerMessage,
      requestId: requestIdFrom(headers),
      retryAfterMs: retryAfterMsFrom(headers),
      retryable: isRetryableStatus(status) || category === "rate_limit",
    },
  );
}

function isRateLimited(body: unknown, headers: Headers): boolean {
  if (headers.get("x-ratelimit-remaining") === "0") return true;
  if (headers.get("ratelimit-remaining") === "0") return true;
  const message = providerMessageFrom(body) ?? "";
  return /rate limit|quota exceeded|too many requests/i.test(message);
}
