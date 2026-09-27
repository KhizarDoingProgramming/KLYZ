import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook delivery parsing and verification.
 *
 * Verification runs against the **raw** request body — never a
 * re-serialised object — because HMAC is computed over the exact bytes
 * GitHub sent. The receiver passes `Buffer` straight through.
 */

export interface GitHubDelivery {
  /** `X-GitHub-Event` — `issues`, `push`, `pull_request`, … */
  event: string;
  /** `X-GitHub-Delivery` — stable id used for idempotency. */
  deliveryId: string;
  /** `X-Hub-Signature-256` — `sha256=<hex>`. */
  signature: string | null;
  /** `X-GitHub-Hook-ID` — the hook registered on the repository. */
  hookId: string | null;
  /** `X-GitHub-Hook-Installation-Target-ID`. */
  hookTargetId: string | null;
  /** `X-GitHub-Repository` when GitHub includes it. */
  repository: string | null;
  /** Content type GitHub used — we only accept `application/json`. */
  contentType: string | null;
  requestId: string | null;
}

export function parseGitHubDelivery(
  headers: Record<string, string | string[] | undefined>,
): GitHubDelivery {
  const header = (name: string): string | null => {
    const lower = name.toLowerCase();
    const direct = headers[lower];
    const value =
      direct !== undefined
        ? direct
        : Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
    if (value === undefined) return null;
    if (Array.isArray(value)) return value[0] ?? null;
    return value;
  };

  return {
    event: (header("x-github-event") ?? "").toLowerCase(),
    deliveryId: header("x-github-delivery") ?? "",
    signature: header("x-hub-signature-256"),
    hookId: header("x-github-hook-id"),
    hookTargetId: header("x-github-hook-installation-target-id"),
    repository: header("x-github-repository"),
    contentType: header("content-type"),
    requestId: header("x-request-id"),
  };
}

/**
 * Constant-time `sha256=<hex>` verification.
 *
 * Returns `false` (never throws) for a missing/malformed signature so
 * the caller can answer `401` without leaking *why* — the log records
 * the actual reason separately.
 */
export function verifyGitHubSignature(
  rawBody: Buffer | string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const [algorithm, provided] = signature.split("=");
  if (algorithm !== "sha256" || !provided) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(provided.trim(), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Sign a payload — used by tests and the local delivery simulator. */
export function signGitHubPayload(rawBody: Buffer | string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** `owner/name` sanity check for a delivery that declares a repository. */
export function deliveryRepository(repo: string | null): string | null {
  if (!repo) return null;
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) return null;
  return `${owner}/${name}`;
}
