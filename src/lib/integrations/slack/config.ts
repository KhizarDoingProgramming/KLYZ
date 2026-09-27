import { REMEDIATION, SLACK_ERRORS, integrationError } from "../errors";

/**
 * Slack input validation.
 *
 * A channel reference, a thread timestamp and a message body are the
 * only free-text values a node hands to `slack.com`. Each is normalised
 * here — before any network call — so a typo fails as a step error with
 * a hint instead of an opaque `channel_not_found` from the API.
 */

export type SlackNotify = "none" | "here" | "channel";

/** `C…` public, `G…` private/multi-party, `D…` direct message. */
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{8,}$/i;
/** A message timestamp: `1758888888.000100`. */
const THREAD_TS_RE = /^\d{10}\.\d{6,}$/;

/** `#engineering`, ` engineering ` and `engineering` name one channel. */
export function normaliseChannelRef(raw: string): string {
  return String(raw ?? "").trim().replace(/^#/, "");
}

/** True when the reference already is a Slack channel id. */
export function looksLikeChannelId(ref: string): boolean {
  return CHANNEL_ID_RE.test(ref);
}

/** Validates a parent message `ts` used as `thread_ts`. */
export function parseThreadTs(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!THREAD_TS_RE.test(value)) {
    throw integrationError(
      SLACK_ERRORS.threadInvalid,
      `"${value || "…"}" is not a Slack message timestamp.`,
      {
        detail: `threadTs=${value || "empty"}`,
        hint: "Pass the ts of the message to reply to — e.g. {{slack.ts}} from this trigger.",
        remediation: REMEDIATION.inspect,
      },
    );
  }
  return value;
}

/**
 * Applies the `@here` / `@channel` prefix and refuses an empty body.
 * Slack would otherwise answer `no_text`, which tells the user nothing.
 */
export function buildMessageText(raw: string, notify: unknown): string {
  const body = String(raw ?? "");
  if (!body.trim()) {
    throw integrationError(SLACK_ERRORS.messageEmpty, "This Slack step has no message to send.", {
      hint: "Write the message, or fill it from an earlier step with {{…}}.",
      remediation: REMEDIATION.inspect,
    });
  }
  const mention = notify === "here" ? "<!here>" : notify === "channel" ? "<!channel>" : "";
  return mention ? `${mention}\n${body}` : body;
}

/** Numeric config → a positive integer, falling back and capping. */
export function parseLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}
