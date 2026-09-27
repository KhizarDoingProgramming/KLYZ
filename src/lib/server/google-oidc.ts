import { createPublicKey, verify as verifySignature } from "node:crypto";
import { HttpError } from "./http";
import { providerFetch } from "@/lib/integrations/provider/http";

/**
 * Google push-notification token verification.
 *
 * When a Pub/Sub subscription pushes to KLYZ it attaches an OIDC
 * bearer token issued by Google for exactly that endpoint. Verifying it
 * — signature, issuer, audience and expiry — is what makes the Gmail
 * receiver trustworthy: without it anyone who learns the URL could
 * start runs in a workspace.
 *
 * The only outbound call is to Google's published JWKS, on a host the
 * provider policy already allows, and the result is cached for the
 * window Google publishes in `max-age`.
 */

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const DEFAULT_TTL_MS = 60 * 60_000;
const CLOCK_SKEW_MS = 60_000;

interface CachedKey {
  byKid: Map<string, string>;
  expiresAt: number;
}

let cache: CachedKey | null = null;

async function signingKeys(): Promise<Map<string, string>> {
  if (cache && cache.expiresAt > Date.now()) return cache.byKid;

  const response = await providerFetch<Record<string, unknown>>({
    provider: "gmail",
    operation: "jwks_fetch",
    url: CERTS_URL,
    method: "GET",
    timeoutMs: 10_000,
  });

  const keys = new Map<string, string>();
  const raw = response.data as { keys?: Array<{ kid?: string; n?: string; e?: string; kty?: string }> };
  for (const entry of raw.keys ?? []) {
    if (entry.kty !== "RSA" || !entry.kid || !entry.n || !entry.e) continue;
    keys.set(entry.kid, toPem(entry.n, entry.e));
  }
  if (keys.size === 0) {
    throw new HttpError(502, "GOOGLE_JWKS_EMPTY", "Google published no signing keys.");
  }

  const maxAge = maxAgeSeconds(response.headers["cache-control"]);
  cache = { byKid: keys, expiresAt: Date.now() + (maxAge ?? DEFAULT_TTL_MS / 1000) * 1000 };
  return keys;
}

function maxAgeSeconds(header: string | undefined): number | null {
  if (!header) return null;
  const match = header.match(/max-age=(\d+)/i);
  if (!match?.[1]) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** JWK (n, e) → SPKI PEM, via the WebCrypto-compatible node helper. */
function toPem(n: string, e: string): string {
  const key = createPublicKey({
    key: { kty: "RSA", n, e },
    format: "jwk",
  });
  return key.export({ type: "spki", format: "pem" }).toString();
}

interface PushClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  email?: string;
  email_verified?: boolean;
  sub?: string;
}

export interface VerifiedPush {
  claims: PushClaims;
}

/**
 * Verifies a Google push bearer token for `audience` (the endpoint URL)
 * and returns its claims. Throws `401` with a stable code on failure —
 * never reveals *which* check failed to the caller.
 */
export async function verifyGooglePushToken(
  authorization: string | null,
  audience: string,
): Promise<VerifiedPush> {
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : (authorization ?? "").trim();
  if (!token) reject("missing bearer token");

  const parts = token.split(".");
  if (parts.length !== 3) reject("malformed token");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: PushClaims;
  try {
    header = JSON.parse(base64UrlDecode(headerPart)) as { alg?: string; kid?: string };
    claims = JSON.parse(base64UrlDecode(payloadPart)) as PushClaims;
  } catch {
    reject("malformed token");
  }

  if (header.alg !== "RS256" || !header.kid) reject("unsupported signing algorithm");

  const keys = await signingKeys();
  const pem = keys.get(header.kid);
  if (!pem) reject("unknown signing key");

  const ok = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    createPublicKey(pem),
    base64UrlToBuffer(signaturePart),
  );
  if (!ok) reject("signature mismatch");

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_MS / 1000 < nowSeconds) {
    reject("token expired");
  }
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_MS / 1000 > nowSeconds) {
    reject("token issued in the future");
  }

  const issuers = ["https://accounts.google.com", "accounts.google.com"];
  if (!claims.iss || !issuers.includes(claims.iss)) reject("unexpected issuer");

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) reject("unexpected audience");

  /* When Google identifies the push service account, it must be one. */
  if (claims.email && !/^\d+@gserviceaccount\.com$/.test(claims.email)) {
    reject("unexpected caller");
  }

  return { claims };
}

function reject(reason: string): never {
  throw new HttpError(
    401,
    "PUSH_AUTH_FAILED",
    "This notification could not be authenticated.",
    { reason },
  );
}

function base64UrlDecode(value: string): string {
  return base64UrlToBuffer(value).toString("utf8");
}

function base64UrlToBuffer(value: string): Buffer {
  const body = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(body + "=".repeat((4 - (body.length % 4)) % 4), "base64");
}

/** Test seam — clears the JWKS cache between cases. */
export function resetJwksCache(): void {
  cache = null;
}
