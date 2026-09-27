import { ProviderError } from "@/lib/integrations/provider/errors";
import { providerFetch } from "@/lib/integrations/provider/http";
import type { ProviderConnection } from "@/lib/integrations/provider/types";

/**
 * Gmail REST client.
 *
 * One entry point stands between a node and `gmail.googleapis.com`: it
 * pins the host, attaches the connection's bearer token, keeps Gmail's
 * `alt=json` contract, and maps failures onto {@link ProviderError}.
 */

export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function gmailRequest<T = unknown>(
  connection: ProviderConnection,
  operation: string,
  path: string,
  options: GmailRequestOptions = {},
): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${GMAIL_BASE}${path}`);
  url.searchParams.set("alt", "json");
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  try {
    const result = await providerFetch<T>({
      provider: "gmail",
      operation,
      url: url.toString(),
      method: options.method ?? "GET",
      headers: { authorization: `Bearer ${connection.accessToken}` },
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

function decorate(
  connection: ProviderConnection,
  operation: string,
  error: ProviderError,
): ProviderError {
  if (error.category === "authentication") {
    return new ProviderError("gmail", "Google rejected the connection's access token.", {
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
      "gmail",
      "Google refused this action — the connection's scopes do not cover it.",
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

export interface GmailListResponse {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailSendResponse {
  id?: string;
  threadId?: string;
  labelIds?: string[];
}

export interface GmailWatchResponse {
  historyId?: string;
  expiration?: string;
}

export interface GmailLabel {
  id?: string;
  name?: string;
  type?: string;
}

export async function listMessageIds(
  connection: ProviderConnection,
  params: { q?: string; labelIds?: string; pageToken?: string; maxResults: number },
  signal?: AbortSignal,
): Promise<GmailListResponse> {
  return gmailRequest<GmailListResponse>(connection, "messages.list", "/messages", {
    query: {
      q: params.q,
      labelIds: params.labelIds,
      pageToken: params.pageToken,
      maxResults: params.maxResults,
    },
    signal,
  });
}
