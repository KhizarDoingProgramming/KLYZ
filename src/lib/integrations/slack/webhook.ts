import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack Events API verification and event normalisation.
 *
 * Verification runs against the **raw** request body — never a
 * re-serialised object — because the HMAC covers the exact bytes Slack
 * sent, and the timestamp is part of the signature so a captured
 * delivery cannot be replayed after the tolerance window.
 *
 * `node:crypto` is only touched inside functions: the pure definition
 * bundle never imports this module, so the browser never sees it.
 */

export interface SlackDeliveryHeaders {
  signature?: string | null;
  timestamp?: string | null;
}

/** Reads `x-slack-signature` / `x-slack-request-timestamp`, case-insensitively. */
export function parseSlackDelivery(headers: Record<string, string> | Headers): SlackDeliveryHeaders {
  return {
    signature: readHeader(headers, "x-slack-signature"),
    timestamp: readHeader(headers, "x-slack-request-timestamp"),
  };
}

function readHeader(headers: Record<string, string> | Headers, name: string): string | null {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === lower) return value ?? null;
  }
  return null;
}

export interface SlackSignatureParams {
  rawBody: string | Buffer;
  signature: string | null;
  timestamp: string | null;
  secret: string;
  /** Epoch ms; defaults to `Date.now()`. */
  now?: number;
  /** Replay window; defaults to five minutes, as Slack documents. */
  toleranceMs?: number;
}

export type SlackSignatureReason = "missing" | "malformed" | "stale" | "mismatch";

export interface SlackSignatureResult {
  ok: boolean;
  reason?: SlackSignatureReason;
}

/**
 * Constant-time `v0=<hex>` verification.
 *
 * Never throws: a missing or malformed header, a timestamp outside the
 * window and a wrong signature each report their own reason so the
 * receiver can log why it answered `401` without leaking it.
 */
export function verifySlackSignature(params: SlackSignatureParams): SlackSignatureResult {
  const { rawBody, signature, timestamp, secret } = params;
  const now = params.now ?? Date.now();
  const toleranceMs = params.toleranceMs ?? 5 * 60_000;

  if (!secret || !signature || !timestamp) return { ok: false, reason: "missing" };
  if (!/^v0=[0-9a-fA-F]+$/.test(signature)) return { ok: false, reason: "malformed" };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: "malformed" };
  if (Math.abs(now / 1000 - seconds) > toleranceMs / 1000) return { ok: false, reason: "stale" };

  const expected = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  const provided = Buffer.from(signature.toLowerCase(), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  /* Lengths first — timingSafeEqual throws on a size mismatch, and a
     length difference is already a mismatch. */
  if (provided.length !== wanted.length) return { ok: false, reason: "mismatch" };
  return timingSafeEqual(provided, wanted) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export interface NormalizedSlackEvent {
  /** The inner event type — always `message` for events that reach a run. */
  type: string;
  channel: string;
  channelType: string;
  userId: string;
  userName?: string;
  text: string;
  ts: string;
  threadTs: string;
  teamId: string;
  botId: string;
  files?: unknown[];
  receivedAt: string;
  raw: Record<string, unknown>;
}

/**
 * Turns an Events API envelope into the trigger's output, or returns
 * `null` for anything that must not start a run: other envelope types,
 * non-message events, edits and joins (every `subtype`), messages from
 * bots — which would let a workflow re-trigger on its own post — and
 * payloads with no channel or timestamp to act on.
 */
export function normalizeSlackEvent(
  payload: Record<string, unknown>,
  receivedAt = new Date().toISOString(),
): NormalizedSlackEvent | null {
  if (!isRecord(payload) || payload.type !== "event_callback") return null;
  const event = payload.event;
  if (!isRecord(event)) return null;
  if (event.type !== "message") return null;
  if (event.subtype) return null;
  if (event.bot_id) return null;

  const channel = str(event.channel);
  const ts = str(event.ts);
  if (!channel || !ts) return null;

  const files = Array.isArray(event.files) ? event.files : undefined;
  return {
    type: str(event.type) || "message",
    channel,
    channelType: str(event.channel_type) || str(payload.channel_type),
    userId: str(event.user),
    userName: str(event.username),
    text: str(event.text),
    ts,
    threadTs: str(event.thread_ts),
    teamId: str(event.team) || str(payload.team_id),
    botId: str(event.bot_id),
    ...(files && files.length > 0 ? { files } : {}),
    receivedAt,
    raw: payload,
  };
}

/** The `challenge` of a `url_verification` handshake, when present. */
export function parseSlackChallenge(payload: Record<string, unknown>): string | null {
  if (!isRecord(payload) || payload.type !== "url_verification") return null;
  return typeof payload.challenge === "string" ? payload.challenge : null;
}

/**
 * What an `event_callback` carries, or `null` when it must not start a
 * run.
 *
 * The receiver asks this **before** the trigger handler so a delivery it
 * will drop is answered `200` immediately (Slack retries anything else),
 * while `bot` still reaches the handler when the node opted into
 * `includeBots`. The rules are the normaliser's, stated up front:
 * `message` only, never a subtype (edits, joins, deletes), and a bot is
 * only distinguishable from a user by `bot_id`.
 */
export function slackMessageKind(payload: Record<string, unknown>): "message" | "bot" | null {
  if (!isRecord(payload) || payload.type !== "event_callback") return null;
  const event = payload.event;
  if (!isRecord(event) || event.type !== "message") return null;
  if (!str(event.channel) || !str(event.ts)) return null;
  if (event.subtype) return null;
  return event.bot_id ? "bot" : "message";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
