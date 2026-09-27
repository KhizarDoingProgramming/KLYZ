import { ProviderError } from "@/lib/integrations/provider/errors";
import { logProviderEvent, providerFetch } from "@/lib/integrations/provider/http";
import type { ProviderConnection } from "@/lib/integrations/provider/types";
import { redactMessage } from "@/lib/server/redact";

/**
 * GitHub REST client.
 *
 * One function (`githubRequest`) stands between a node and
 * `api.github.com`. It attaches the connection's bearer token, pins the
 * host, maps failures onto {@link ProviderError} and returns parsed
 * JSON. Pagination helpers live here too, because Search and List
 * operations otherwise grow bespoke `page` loops in every handler.
 */

export const GITHUB_API = "https://api.github.com";

export interface GitHubRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Query string pairs; empty/undefined values are dropped. */
  query?: Record<string, string | number | undefined | null>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function githubRequest<T = unknown>(
  connection: ProviderConnection,
  operation: string,
  path: string,
  options: GitHubRequestOptions = {},
): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${GITHUB_API}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const startedAt = Date.now();
  try {
    const result = await providerFetch<T>({
      provider: "github",
      operation,
      url: url.toString(),
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${connection.accessToken}`,
        "x-github-api-version": "2022-11-28",
        ...(options.headers ?? {}),
      },
      json: options.body,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    logProviderEvent({
      provider: "github",
      operation,
      durationMs: Date.now() - startedAt,
      status: result.status,
      rateLimited: result.rateLimit?.remaining === 0,
    });
    return result.data as T;
  } catch (error) {
    if (error instanceof ProviderError) {
      logProviderEvent({
        provider: "github",
        operation,
        durationMs: Date.now() - startedAt,
        status: error.statusCode ?? 0,
        error: error.category,
      });
      throw decorate(connection, operation, error);
    }
    throw error;
  }
}

/**
 * Adds connection context a generic provider error cannot know:
 * *which* account failed and what to do about it. The token itself is
 * never included — only the credential id.
 */
function decorate(
  connection: ProviderConnection,
  operation: string,
  error: ProviderError,
): ProviderError {
  if (error.category === "authentication") {
    return new ProviderError(
      "github",
      "GitHub rejected the connection's access token.",
      {
        operation,
        category: "authentication",
        status: error.statusCode,
        requestId: error.requestId,
        providerMessage: redactMessage(error.providerMessage ?? ""),
        detail: `credential=${connection.credentialId}${connection.account ? ` account=${connection.account}` : ""}`,
        cause: error,
      },
    );
  }
  if (error.category === "authorization") {
    return new ProviderError(
      "github",
      "GitHub refused this action — the connection's scopes do not cover it.",
      {
        operation,
        category: "authorization",
        status: error.statusCode,
        requestId: error.requestId,
        providerMessage: redactMessage(error.providerMessage ?? ""),
        detail: `granted=${connection.scopes.join(" ") || "none"}`,
        cause: error,
      },
    );
  }
  return error;
}

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

export interface Page<T> {
  items: T[];
  status: number;
  headers: Record<string, string>;
}

/**
 * GET a collection endpoint and follow `Link: rel="next"` up to
 * `maxPages`. Rate-limit headers are surfaced on the final page so a
 * caller can record them in step metadata.
 */
export async function githubGetPage<T>(
  connection: ProviderConnection,
  operation: string,
  path: string,
  options: GitHubRequestOptions & { maxPages?: number } = {},
): Promise<Page<T>> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 1, 10));
  const items: T[] = [];
  let next: string | null = path.startsWith("http") ? path : `${GITHUB_API}${path}`;
  let status = 200;
  let headers: Record<string, string> = {};
  let pages = 0;

  while (next && pages < maxPages) {
    pages += 1;
    const url = new URL(next);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      if (!url.searchParams.has(key)) url.searchParams.set(key, String(value));
    }
    const result = await providerFetch<T[] | { items?: T[] }>({
      provider: "github",
      operation,
      url: url.toString(),
      method: "GET",
      headers: {
        authorization: `Bearer ${connection.accessToken}`,
        "x-github-api-version": "2022-11-28",
        ...(options.headers ?? {}),
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    status = result.status;
    headers = result.headers;
    const body = result.data;
    if (Array.isArray(body)) items.push(...(body as T[]));
    else if (body && Array.isArray((body as { items?: T[] }).items)) {
      items.push(...((body as { items: T[] }).items));
    }
    next = nextLink(result.headers.link);
  }

  logProviderEvent({ provider: "github", operation, status, durationMs: 0 });
  return { items, status, headers };
}

function nextLink(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Small typed helpers used by several nodes                           */
/* ------------------------------------------------------------------ */

export interface GitHubUser {
  id?: number;
  login?: string;
  html_url?: string;
  avatar_url?: string;
  type?: string;
}

export interface GitHubLabel {
  id?: number;
  name?: string;
  color?: string;
  description?: string | null;
}

export interface GitHubIssue {
  id?: number;
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  html_url?: string;
  url?: string;
  user?: GitHubUser | null;
  labels?: Array<string | GitHubLabel>;
  assignees?: GitHubUser[];
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  comments?: number;
  pull_request?: unknown;
  repository_url?: string;
}
