import { httpAllowHosts, httpAllowPrivate, httpMaxResponseBytes } from "@/lib/config/env";
import { decryptCredentialFields } from "@/lib/server/credentials";
import { redactHeaders, redactMessage, redactUrl } from "@/lib/server/redact";
import { parseJsonLike, resolveValue } from "@/lib/engine/resolve";
import type { NodeHandler, NodeRunContext } from "@/lib/engine/types";
import { recordProviderCall } from "@/lib/execution/telemetry";
import { HTTP_ERRORS, REMEDIATION, integrationError } from "../errors";
import { performHttpRequest, type RequestResult } from "./request";
import { assertTarget, type UrlPolicy } from "./ssrf";

/**
 * HTTP request handler.
 *
 * Transient failures (timeouts, DNS, refused connections, 408/429/5xx)
 * are marked `retryable` so the engine's attempt loop re-runs the step
 * with backoff; permanent failures (bad URL, blocked target, other 4xx)
 * stop the run immediately. Redirects are followed manually and every
 * hop goes through the same SSRF checks as the first request.
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export const httpHandler: NodeHandler = async (context: NodeRunContext) => {
  const startedAt = Date.now();
  const { config, workspaceId, signal } = context;
  const policy: UrlPolicy = { allowHosts: httpAllowHosts(), allowPrivate: httpAllowPrivate() };

  const method = String(config.method ?? "GET").toUpperCase();
  const rawUrl = typeof config.url === "string" ? config.url.trim() : "";
  if (!rawUrl) {
    throw integrationError(HTTP_ERRORS.urlInvalid, "This HTTP step has no URL.");
  }
  const url = assertTarget(rawUrl, policy);

  const headers = buildHeaders(config);
  applyAuth(config, headers, workspaceId);
  appendQuery(url, config.query);

  const allowFailure = config.allowFailure === true;
  const timeoutMs = clampNumber(config.timeout, 1, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxBytes = httpMaxResponseBytes();
  const followRedirects = config.followRedirects !== false;

  const request = {
    method,
    headers,
    body: buildBody(resolveBodyValue(context), config, headers),
    timeoutMs,
    maxBytes,
    policy,
    signal,
  };

  let target = url;
  let currentMethod = method;
  let currentBody = request.body;
  let redirects = 0;

  /* One telemetry record per step (not per redirect hop): what went out,
     what came back, how long it took — scrubbed of query-string secrets. */
  const record = (status: number | null, ok: boolean, error?: string): void => {
    recordProviderCall({
      provider: "http",
      operation: "http.request",
      method: currentMethod,
      url: redactUrl(target.toString()),
      status,
      ok,
      durationMs: Date.now() - startedAt,
      error,
    });
  };

  let result: RequestResult;
  try {
    for (;;) {
      result = await performHttpRequest({ ...request, method: currentMethod, url: target, body: currentBody });
      if (!followRedirects || !REDIRECT_STATUSES.has(result.status)) break;

      const location = result.headers.location;
      if (!location) break;
      if (redirects >= MAX_REDIRECTS) {
        throw integrationError(HTTP_ERRORS.status, "The server redirected more than 5 times.", {
          detail: `Last hop: ${target.toString()}`,
          hint: "The API may be bouncing between hosts — check the URL.",
          remediation: REMEDIATION.inspect,
        });
      }
      redirects += 1;
      target = assertTarget(new URL(location, target).toString(), policy);
      if (
        result.status === 303 ||
        ((result.status === 301 || result.status === 302) && currentMethod !== "GET" && currentMethod !== "HEAD")
      ) {
        currentMethod = "GET";
        currentBody = undefined;
        delete headers["content-type"];
        delete headers["content-length"];
      }
    }
  } catch (error) {
    const withCode = error as { code?: unknown };
    record(null, false, typeof withCode.code === "string" ? withCode.code : "HTTP_TRANSPORT");
    throw error;
  }

  const durationMs = Date.now() - startedAt;
  const ok = result.status >= 200 && result.status < 300;
  record(result.status, ok, ok ? undefined : `HTTP_${result.status}`);
  if (!ok && !allowFailure) throw statusError(result, target, method);

  return {
    output: {
      status: result.status,
      ok,
      body: parseResponseBody(result.body, result.headers["content-type"] ?? ""),
      headers: redactHeaders(result.headers),
      url: target.toString(),
      method: currentMethod,
      durationMs,
      redirects,
    },
  };
};

/* ------------------------------------------------------------------ */
/* Request assembly                                                    */
/* ------------------------------------------------------------------ */

type Row = { key: string; value: unknown };

function rows(value: unknown): Row[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({ key: String(item.key ?? ""), value: item.value }))
      .filter((row) => row.key.trim() !== "");
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => ({ key, value: item }));
  }
  return [];
}

function buildHeaders(config: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json, */*" };
  for (const row of rows(config.headers)) {
    headers[row.key.trim().toLowerCase()] = stringify(row.value);
  }
  return headers;
}

function appendQuery(url: URL, value: unknown): void {
  for (const row of rows(value)) {
    url.searchParams.set(row.key, stringify(row.value));
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function applyAuth(
  config: Record<string, unknown>,
  headers: Record<string, string>,
  workspaceId: string,
): void {
  const credentialId = typeof config.credential === "string" ? config.credential.trim() : "";
  if (credentialId) {
    const fields = decryptCredentialFields(workspaceId, credentialId);
    if (fields.username !== undefined) {
      headers.authorization = `Basic ${Buffer.from(
        `${fields.username}:${fields.password ?? ""}`,
        "utf8",
      ).toString("base64")}`;
      return;
    }
    if (fields.token) {
      headers.authorization = `Bearer ${fields.token}`;
      return;
    }
    if (fields.headerName) {
      headers[fields.headerName.toLowerCase()] = fields.value ?? fields.token ?? "";
      return;
    }
    throw integrationError(
      HTTP_ERRORS.credentialInvalid,
      "That credential does not contain usable HTTP auth fields.",
      { remediation: REMEDIATION.reconnect },
    );
  }

  const auth = String(config.auth ?? "none");
  if (auth === "none") return;
  if (auth === "bearer" || auth === "header") {
    const token = typeof config.token === "string" ? config.token.trim() : "";
    if (!token) {
      throw integrationError(
        HTTP_ERRORS.credentialInvalid,
        "Authentication is on but no token was provided.",
        { hint: "Fill in the token, or pick a stored credential." },
      );
    }
    if (auth === "bearer") headers.authorization = `Bearer ${token}`;
    else {
      const headerName =
        (typeof config.headerName === "string" && config.headerName.trim()) || "x-api-key";
      headers[headerName.toLowerCase()] = token;
    }
    return;
  }
  if (auth === "basic") {
    const username = typeof config.username === "string" ? config.username : "";
    const password = typeof config.password === "string" ? config.password : "";
    if (!username) {
      throw integrationError(HTTP_ERRORS.credentialInvalid, "Basic auth needs a username.");
    }
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  }
}

/**
 * The authored body still carries `{{…}}` — the outer config pass turns
 * them into text, which breaks JSON with bare expression values. When
 * the authored body looks like JSON-with-expressions, parse it relaxed
 * and resolve typed values (objects stay objects); otherwise fall back
 * to the outer-resolved text.
 */
function resolveBodyValue(context: NodeRunContext): unknown {
  const authored = context.rawConfig?.body;
  if (typeof authored === "string" && authored.includes("{{")) {
    try {
      return resolveValue(parseJsonLike(authored), context.scope);
    } catch {
      /* not JSON — use the interpolated text from the outer pass */
    }
  }
  return context.config.body;
}

function buildBody(
  raw: unknown,
  config: Record<string, unknown>,
  headers: Record<string, string>,
): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const method = String(config.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
    if (looksLikeJson) {
      try {
        JSON.parse(trimmed);
        if (!headers["content-type"]) headers["content-type"] = "application/json";
      } catch {
        /* literal body text the user typed — send it untouched */
      }
    }
    if (!headers["content-type"] && !looksLikeJson) headers["content-type"] = "text/plain; charset=utf-8";
    return raw;
  }
  const serialised = JSON.stringify(raw);
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  return serialised;
}

/* ------------------------------------------------------------------ */
/* Response                                                            */
/* ------------------------------------------------------------------ */

function parseResponseBody(body: string, contentType: string): unknown {
  const text = body.trim();
  if (!text) return null;
  const looksLikeJson =
    contentType.includes("json") || text.startsWith("{") || text.startsWith("[");
  if (looksLikeJson) {
    try {
      return JSON.parse(text);
    } catch {
      return body;
    }
  }
  return body;
}

function statusError(result: RequestResult, url: URL, method: string) {
  const retryable = result.status === 408 || result.status === 429 || result.status >= 500;
  const snippet = redactMessage(result.body.slice(0, 300));
  return integrationError(
    HTTP_ERRORS.status,
    `${method} ${url.host} responded with ${result.status}.`,
    {
      detail: snippet || `The server returned HTTP ${result.status} with an empty body.`,
      hint: retryable
        ? "The engine retried this step automatically; if it keeps failing the API is unhealthy."
        : "Check the URL, method and credentials — a 4xx usually means the request itself is wrong.",
      remediation: retryable ? REMEDIATION.retry : REMEDIATION.inspect,
      retryable,
      httpStatus: result.status,
    },
  );
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}
