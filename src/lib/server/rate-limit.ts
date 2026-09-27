import { HttpError } from "./http";

/**
 * In-process rate limiting.
 *
 * Fixed windows keyed by (scope, subject) — an IP, a workspace, an
 * account or an endpoint, whichever a caller chooses. It is deliberately
 * per-process (documented): KLYZ runs one API process and one worker,
 * and a shared Redis limiter would add a hard dependency to every auth
 * request. The keys and call sites are already scoped so swapping the
 * storage later touches only this file.
 */

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

export interface RateLimitOptions {
  /** Namespace + subject, e.g. `login:1.2.3.4`. */
  key: string;
  limit: number;
  windowMs?: number;
  now?: number;
  /** Action name used in the 429 payload. */
  scope?: string;
}

export function assertRateLimit(options: RateLimitOptions): void {
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now();
  const bucket = buckets.get(options.key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    setBucket(options.key, { windowStart: now, count: 1 });
    return;
  }
  if (bucket.count >= options.limit) {
    const retryAfter = Math.max(
      1,
      Math.ceil((bucket.windowStart + windowMs - now) / 1000),
    );
    throw new HttpError(
      429,
      "RATE_LIMITED",
      `Too many requests — try again in ${retryAfter}s.`,
      { retryAfter, limit: options.limit, scope: options.scope ?? "request" },
    );
  }
  bucket.count += 1;
}

function setBucket(key: string, bucket: Bucket): void {
  if (buckets.size >= MAX_BUCKETS) {
    /* Drop the oldest half so a flood of unique keys cannot grow the
       map without bound; the timestamps are insertion-ordered enough
       for this purpose. */
    let removed = 0;
    for (const existing of buckets.keys()) {
      buckets.delete(existing);
      removed += 1;
      if (removed >= MAX_BUCKETS / 2) break;
    }
  }
  buckets.set(key, bucket);
}

/** Test hook — clears every window. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** Convenience builders so call sites stay readable. */
export function limitByKey(
  scope: string,
  subject: string,
  limit: number,
  windowMs = 60_000,
): void {
  assertRateLimit({ key: `${scope}:${subject}`, limit, windowMs, scope });
}
