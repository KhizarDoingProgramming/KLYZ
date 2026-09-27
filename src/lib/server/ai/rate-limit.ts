import { aiRateLimitPerMinute } from "@/lib/config/env";
import { AI_CODES, aiError } from "./errors";

/**
 * AI request throttling.
 *
 * KLYZ has no shared rate-limit infrastructure yet, so this is the
 * smallest thing that stops an accidental regeneration loop from burning
 * a provider budget: a fixed per-minute window per workspace, held
 * in-process (documented as per-process; swap for Redis when a shared
 * limiter exists).
 */

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

export function assertAiRateLimit(
  key: string,
  limitPerMinute: number = aiRateLimitPerMinute(),
  now = Date.now(),
): void {
  const windowMs = 60_000;
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { windowStart: now, count: 1 });
    return;
  }
  if (bucket.count >= limitPerMinute) {
    const retryAfter = Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000));
    throw aiError(
      429,
      AI_CODES.RATE_LIMITED,
      `AI request limit reached (${limitPerMinute}/minute). Try again in ${retryAfter}s.`,
      { retryAfter, limitPerMinute },
    );
  }
  bucket.count += 1;
}

/** Test hook — clears the in-process windows. */
export function resetAiRateLimit(): void {
  buckets.clear();
}
