import { ProviderError, type ProviderErrorCategory } from "@/lib/integrations/provider/errors";
import { providerFetch } from "@/lib/integrations/provider/http";
import type { ProviderConnection } from "@/lib/integrations/provider/types";

/**
 * Slack Web API client.
 *
 * Every method is a `POST https://slack.com/api/<method>` carrying the
 * connection's bot token, and — unlike GitHub and Gmail — Slack answers
 * most failures with **HTTP 200 and `{ok:false, error:"…"}`**, which
 * `providerFetch` treats as a success. This module is therefore the one
 * place that reads `ok`: a false body becomes a normalised
 * {@link ProviderError}, so handlers only ever see `T`.
 */

export const SLACK_API = "https://slack.com/api";

export interface SlackResponse {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export interface SlackRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Slack's `error` codes → the category the engine already understands. */
const ERROR_CATEGORY: Record<string, ProviderErrorCategory> = {
  invalid_auth: "authentication",
  invalid_auth_type: "authentication",
  not_authed: "authentication",
  token_revoked: "authentication",
  token_expired: "authentication",
  account_inactive: "authentication",
  missing_scope: "authorization",
  not_in_channel: "authorization",
  channel_is_archived: "authorization",
  is_archived: "authorization",
  restricted_action: "authorization",
  cant_invite_self: "authorization",
  not_allowed_in_type: "authorization",
  platform_token_revoked: "authorization",
  channel_not_found: "not_found",
  message_not_found: "not_found",
  user_not_found: "not_found",
  file_not_found: "not_found",
  ratelimited: "rate_limit",
  rate_limited: "rate_limit",
  fatal_error: "provider_unavailable",
  internal_error: "provider_unavailable",
  service_unavailable: "provider_unavailable",
  invalid_arguments: "validation",
  invalid_payload: "validation",
  invalid_cursor: "validation",
  name_taken: "validation",
  no_text: "validation",
  message_too_long: "validation",
  too_many_attachments: "validation",
};

/** Codes worth explaining in words instead of echoing the identifier. */
const FRIENDLY_MESSAGE: Record<string, string> = {
  invalid_auth: "Slack rejected the connection's access token.",
  not_authed: "Slack rejected the connection's access token.",
  token_revoked: "The Slack connection's token was revoked — reconnect the workspace.",
  token_expired: "The Slack connection's token expired — reconnect the workspace.",
  account_inactive: "The Slack workspace is no longer available to this app.",
  missing_scope:
    "The Slack connection is missing a permission for this action — reconnect it with the required scopes.",
  not_in_channel: "The app is not a member of that channel — invite it first.",
  channel_is_archived: "That channel is archived.",
  is_archived: "That channel is archived.",
  channel_not_found: "That channel does not exist, or the app cannot see it.",
  ratelimited: "Slack is rate limiting this connection — try again shortly.",
  rate_limited: "Slack is rate limiting this connection — try again shortly.",
  no_text: "Slack refused an empty message.",
  message_too_long: "The message is too long for Slack.",
};

/**
 * Calls one Web API method.
 *
 * Non-2xx responses (and HTTP 429 in particular) are already
 * {@link ProviderError}s and pass through `decorate` untouched; the
 * `{ok:false}` body Slack returns with HTTP 200 is mapped here.
 */
export async function slackRequest<T = unknown>(
  connection: ProviderConnection,
  method: string,
  params: Record<string, unknown>,
  options: SlackRequestOptions = {},
): Promise<T> {
  let data: unknown;
  try {
    const result = await providerFetch<SlackResponse>({
      provider: "slack",
      operation: method,
      url: `${SLACK_API}/${method}`,
      method: "POST",
      headers: { authorization: `Bearer ${connection.accessToken}` },
      json: params,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    data = result.data;
  } catch (error) {
    if (error instanceof ProviderError) throw decorate(connection, method, error);
    throw error;
  }

  if (!data || typeof data !== "object") {
    throw new ProviderError("slack", `Slack returned an unexpected response for ${method}.`, {
      operation: method,
      category: "unknown",
      providerMessage: typeof data === "string" ? data.slice(0, 200) : undefined,
    });
  }

  const body = data as SlackResponse;
  if (body.ok === false) throw apiError(method, body.error);

  const payload: Record<string, unknown> = { ...body };
  delete payload.ok;
  delete payload.error;
  return payload as T;
}

function apiError(method: string, code: string | undefined): ProviderError {
  const error = code || "unknown_error";
  const category = ERROR_CATEGORY[error] ?? "unknown";
  return new ProviderError("slack", FRIENDLY_MESSAGE[error] ?? `Slack refused ${method}: ${error}`, {
    operation: method,
    category,
    providerMessage: error,
    detail: `error=${error}`,
    retryable: category === "rate_limit" || category === "provider_unavailable",
  });
}

/**
 * Adds the connection context a generic provider error cannot know:
 * *which* workspace failed and what scopes it holds. The token itself
 * is never included — only the credential id.
 */
function decorate(
  connection: ProviderConnection,
  operation: string,
  error: ProviderError,
): ProviderError {
  if (error.category === "authentication") {
    return new ProviderError("slack", "Slack rejected the connection's access token.", {
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
    return new ProviderError("slack", "Slack refused this action — the connection's scopes do not cover it.", {
      operation,
      category: "authorization",
      status: error.statusCode,
      requestId: error.requestId,
      providerMessage: error.providerMessage,
      detail: `granted=${connection.scopes.join(" ") || "none"}`,
      cause: error,
    });
  }
  return error;
}

/* ------------------------------------------------------------------ */
/* Typed helpers                                                       */
/* ------------------------------------------------------------------ */

export interface SlackChannel {
  id: string;
  name: string;
  is_channel?: boolean;
  is_private?: boolean;
  /** Legacy private channels report `is_group` instead of `is_private`. */
  is_group?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  created?: number;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

export interface SlackPostMessageParams {
  channel: string;
  text: string;
  /** Parent message `ts` — turns the post into a threaded reply. */
  threadTs?: string;
}

export interface SlackPostMessageResult {
  ts: string;
  channel: string;
  thread_ts?: string;
}

export async function postMessage(
  connection: ProviderConnection,
  params: SlackPostMessageParams,
  options: SlackRequestOptions = {},
): Promise<SlackPostMessageResult> {
  return slackRequest<SlackPostMessageResult>(
    connection,
    "chat.postMessage",
    {
      channel: params.channel,
      text: params.text,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
    },
    options,
  );
}

export interface SlackListOptions {
  /** `conversations.list` types — public and private channels by default. */
  types?: string;
  limit?: number;
  /** Cursor pages to follow; Slack caps a page at 500, 200 is the norm. */
  maxPages?: number;
  excludeArchived?: boolean;
  signal?: AbortSignal;
}

interface SlackListResult {
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
}

/** Lists the channels the token can see, following cursors up to 5 pages. */
export async function conversationsList(
  connection: ProviderConnection,
  options: SlackListOptions = {},
): Promise<SlackChannel[]> {
  const types = options.types ?? "public_channel,private_channel";
  const limit = options.limit ?? 200;
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 5, 5));
  const channels: SlackChannel[] = [];
  let cursor = "";

  for (let page = 0; page < maxPages; page += 1) {
    const body = await slackRequest<SlackListResult>(
      connection,
      "conversations.list",
      {
        types,
        limit,
        ...(cursor ? { cursor } : {}),
        ...(options.excludeArchived === undefined
          ? {}
          : { exclude_archived: options.excludeArchived }),
      },
      { signal: options.signal },
    );
    channels.push(...(body.channels ?? []));
    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }

  return channels;
}

export async function conversationsInfo(
  connection: ProviderConnection,
  channel: string,
  options: SlackRequestOptions = {},
): Promise<SlackChannel> {
  const body = await slackRequest<{ channel?: SlackChannel }>(
    connection,
    "conversations.info",
    { channel },
    options,
  );
  if (!body.channel?.id) {
    throw new ProviderError("slack", `Slack did not return details for channel ${channel}.`, {
      operation: "conversations.info",
      category: "not_found",
      providerMessage: "channel_not_found",
    });
  }
  return body.channel;
}

/** Name lookup — `#` optional, case-insensitive, across the channel list. */
export async function findChannelByName(
  connection: ProviderConnection,
  name: string,
  options: SlackListOptions = {},
): Promise<SlackChannel | null> {
  const wanted = name.trim().replace(/^#/, "").toLowerCase();
  if (!wanted) return null;
  const channels = await conversationsList(connection, options);
  return channels.find((channel) => (channel.name ?? "").toLowerCase() === wanted) ?? null;
}

export interface SlackAuthTestResult {
  user_id?: string;
  user?: string;
  team?: string;
  team_id?: string;
  bot_id?: string;
  url?: string;
}

export async function authTest(
  connection: ProviderConnection,
  options: SlackRequestOptions = {},
): Promise<SlackAuthTestResult> {
  return slackRequest<SlackAuthTestResult>(connection, "auth.test", {}, options);
}
