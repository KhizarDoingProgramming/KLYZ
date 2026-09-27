import { ProviderError } from "@/lib/integrations/provider/errors";
import { providerFetch } from "@/lib/integrations/provider/http";
import type { ProviderConnection } from "@/lib/integrations/provider/types";

/**
 * Notion REST client.
 *
 * One entry point stands between a node and `api.notion.com`: it pins
 * the host, attaches the connection's bearer token, pins Notion's
 * version header and maps failures onto {@link ProviderError}. Notion
 * reports failures as `{object:"error", status, code, message}` —
 * `providerMessageFrom` already lifts `message` out of that shape, so
 * the decorator only has to keep it while adding which credential
 * failed and what it may do. The token itself never appears.
 */

export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_API_VERSION = "2022-06-28";

export type NotionPayload = Record<string, unknown>;

export interface NotionRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function notionRequest<T = unknown>(
  connection: ProviderConnection,
  operation: string,
  path: string,
  options: NotionRequestOptions = {},
): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${NOTION_API}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  try {
    const result = await providerFetch<T>({
      provider: "notion",
      operation,
      url: url.toString(),
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${connection.accessToken}`,
        "notion-version": NOTION_API_VERSION,
        ...(options.headers ?? {}),
      },
      json: options.body,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    return result.data;
  } catch (error) {
    if (error instanceof ProviderError) throw decorate(connection, operation, error);
    throw error;
  }
}

/**
 * Adds connection context a generic provider error cannot know: which
 * credential failed and what it was granted. `providerMessage` is
 * carried over unchanged so Notion's own explanation survives.
 */
function decorate(
  connection: ProviderConnection,
  operation: string,
  error: ProviderError,
): ProviderError {
  if (error.category === "authentication") {
    return new ProviderError("notion", "Notion rejected the connection's access token.", {
      operation,
      category: "authentication",
      status: error.statusCode,
      requestId: error.requestId,
      providerMessage: error.providerMessage,
      detail: `credential=${connection.credentialId}${connection.account ? ` account=${connection.account}` : ""}`,
      cause: error,
    });
  }
  if (error.category === "authorization") {
    return new ProviderError(
      "notion",
      "Notion refused this action — the integration was not shared with that page or database.",
      {
        operation,
        category: "authorization",
        status: error.statusCode,
        requestId: error.requestId,
        providerMessage: error.providerMessage,
        detail: `granted=${connection.scopes.join(" ") || "none"}`,
        cause: error,
      },
    );
  }
  return error;
}

/* ------------------------------------------------------------------ */
/* Typed helpers                                                       */
/* ------------------------------------------------------------------ */

export async function createPage(
  connection: ProviderConnection,
  body: NotionPayload,
  signal?: AbortSignal,
): Promise<NotionPayload> {
  return notionRequest<NotionPayload>(connection, "pages.create", "/pages", {
    method: "POST",
    body,
    signal,
  });
}

export async function retrievePage(
  connection: ProviderConnection,
  pageId: string,
  signal?: AbortSignal,
): Promise<NotionPayload> {
  return notionRequest<NotionPayload>(connection, "pages.get", `/pages/${pageId}`, { signal });
}

export async function updatePage(
  connection: ProviderConnection,
  pageId: string,
  body: NotionPayload,
  signal?: AbortSignal,
): Promise<NotionPayload> {
  return notionRequest<NotionPayload>(connection, "pages.update", `/pages/${pageId}`, {
    method: "PATCH",
    body,
    signal,
  });
}

export interface NotionSearchResponse extends NotionPayload {
  results?: unknown[];
}

export async function searchPages(
  connection: ProviderConnection,
  body: NotionPayload,
  signal?: AbortSignal,
): Promise<NotionSearchResponse> {
  return notionRequest<NotionSearchResponse>(connection, "search", "/search", {
    method: "POST",
    body,
    signal,
  });
}

/** Reads a database so its properties can be typed and validated. */
export async function retrieveDatabase(
  connection: ProviderConnection,
  databaseId: string,
  signal?: AbortSignal,
): Promise<NotionPayload> {
  return notionRequest<NotionPayload>(connection, "databases.get", `/databases/${databaseId}`, {
    signal,
  });
}
