/**
 * Secret redaction.
 *
 * Anything that might carry a credential — headers, config values,
 * query strings — passes through here before it reaches an execution
 * event, a log line or an error message. Redaction is deliberately
 * conservative: whole keys that look like secrets are dropped, and
 * known auth header values are masked, so a bug elsewhere cannot leak
 * a token into run history.
 */

const SENSITIVE_VALUE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-klyz-webhook-secret",
  "x-signature",
  "x-hub-signature",
  "x-hub-signature-256",
]);

/* Substrings are checked against the whole (lower-cased) key, so
   `accessToken`, `client_secret` and `api-key` all match. */
const SENSITIVE_SUBSTRINGS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "credential",
  "cookie",
  "signature",
  "bearer",
  "apikey",
  "accesskey",
  "privatekey",
  "session",
];

/* `auth` is matched as a *word*, never as a substring — otherwise
   `author` (an author id in a CMS payload) would be redacted too. */
const AUTH_WORDS = new Set([
  "auth",
  "authorization",
  "authorisation",
  "oauth",
  "authentication",
  "authenticate",
]);

export const REDACTED = "••••";

/** Split a key into lowercase words (`clientAccessToken` → client access token). */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_VALUE_KEYS.has(lower)) return true;
  /* Punctuation-free form so `api_key`, `api-key` and `apiKey` behave alike. */
  const flat = lower.replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_SUBSTRINGS.some((part) => flat.includes(part))) return true;
  return keyWords(key).some((word) => AUTH_WORDS.has(word));
}

/** Mask a single string that is known to be a secret. */
export function maskSecret(value: string): string {
  if (!value) return value;
  if (value.length <= 8) return REDACTED;
  return `${value.slice(0, 4)}${REDACTED}`;
}

/**
 * Deep-copy `value` with every sensitive-looking field replaced.
 * Never mutates the input; cycles are cut after one level of nesting.
 *
 * This is the function every payload passes through on its way out of
 * the engine — run input, step input/output, telemetry — so a redacted
 * event is safe to persist *and* safe to publish over SSE.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** HTTP headers with credential-bearing values masked. */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const flat = Array.isArray(value) ? value.join(", ") : value;
    out[key.toLowerCase()] = isSensitiveKey(key) ? REDACTED : flat;
  }
  return out;
}

/**
 * Strip `user:password@` from a URL and mask secret-looking query
 * parameters before it is logged, returned or stored as telemetry.
 */
export function redactUrl(raw: string | URL): string {
  try {
    const url = raw instanceof URL ? new URL(raw.toString()) : new URL(raw);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    for (const key of [...new Set(url.searchParams.keys())]) {
      if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return raw.toString();
  }
}

/** Error message scrub — drop obvious secrets from driver/HTTP errors. */
export function redactMessage(message: string): string {
  return message
    .replace(/postgres:\/\/[^\s]+/gi, "postgres://[redacted]")
    .replace(/redis:\/\/[^\s]+/gi, "redis://[redacted]")
    /* Credentials embedded in a URL (`https://user:pass@host/…`) — a
       common shape in library and driver error messages. */
    .replace(/(\w+:\/\/[^/\s:@]+:)[^@\s]+(@)/gi, `$1${REDACTED}$2`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/\bwhsec_[A-Za-z0-9]+/g, `whsec_${REDACTED}`);
}
