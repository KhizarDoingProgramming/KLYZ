import { HttpError } from "@/lib/server/http";

/**
 * AI error vocabulary.
 *
 * Same `HttpError` convention as every other KLYZ route — only the
 * codes are new, and each one is a state the builder UI renders
 * distinctly (unconfigured, throttled, too slow, unusable reply…).
 */

export const AI_CODES = {
  /** No API key/base URL configured — the builder shows setup guidance. */
  CONFIGURATION_MISSING: "AI_CONFIGURATION_MISSING",
  /** Per-workspace request budget exhausted. */
  RATE_LIMITED: "AI_RATE_LIMITED",
  /** The provider did not answer inside the timeout. */
  TIMEOUT: "AI_TIMEOUT",
  /** Provider rejected the request, was unreachable, or answered 5xx. */
  PROVIDER_ERROR: "AI_PROVIDER_ERROR",
  /** Reply was not the structured JSON we asked for (after one repair). */
  INVALID_OUTPUT: "AI_INVALID_OUTPUT",
  /** The request asked for something KLYZ cannot build. */
  UNSUPPORTED_REQUEST: "AI_UNSUPPORTED_REQUEST",
  /** A generated plan failed real workflow validation. */
  VALIDATION_FAILED: "AI_VALIDATION_FAILED",
} as const;

export type AiCode = (typeof AI_CODES)[keyof typeof AI_CODES];

export function aiError(
  status: number,
  code: AiCode,
  message: string,
  details?: unknown,
): HttpError {
  return new HttpError(status, code, message, details);
}
