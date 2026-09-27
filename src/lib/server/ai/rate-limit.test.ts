import { beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "@/lib/server/http";
import { AI_CODES } from "./errors";
import { assertAiRateLimit, resetAiRateLimit } from "./rate-limit";

/**
 * The only budget control between the builder and the provider bill.
 * Per-process by design (documented) — the point is to stop a runaway
 * regeneration loop, not to coordinate a fleet.
 */

const T0 = 1_700_000_000_000;

beforeEach(() => {
  resetAiRateLimit();
});

describe("assertAiRateLimit", () => {
  it("allows requests up to the limit inside one window", () => {
    for (let index = 0; index < 3; index += 1) {
      expect(() => assertAiRateLimit("ws_1", 3, T0 + index)).not.toThrow();
    }
  });

  it("throws AI_RATE_LIMITED once the window is exhausted", () => {
    assertAiRateLimit("ws_1", 2, T0);
    assertAiRateLimit("ws_1", 2, T0 + 1);
    try {
      assertAiRateLimit("ws_1", 2, T0 + 2);
      throw new Error("expected the third request to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const httpError = error as HttpError;
      expect(httpError.status).toBe(429);
      expect(httpError.code).toBe(AI_CODES.RATE_LIMITED);
      expect(httpError.message).toContain("2/minute");
      expect((httpError.details as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
    }
  });

  it("keys windows per workspace", () => {
    assertAiRateLimit("ws_1", 1, T0);
    expect(() => assertAiRateLimit("ws_2", 1, T0)).not.toThrow();
    expect(() => assertAiRateLimit("ws_1", 1, T0 + 10)).toThrow(/limit reached/);
  });

  it("starts a fresh window after a minute", () => {
    assertAiRateLimit("ws_1", 1, T0);
    expect(() => assertAiRateLimit("ws_1", 1, T0 + 59_000)).toThrow(/limit reached/);
    expect(() => assertAiRateLimit("ws_1", 1, T0 + 60_001)).not.toThrow();
  });

  it("reports time left inside the window, not zero", () => {
    assertAiRateLimit("ws_1", 1, T0);
    try {
      assertAiRateLimit("ws_1", 1, T0 + 10_000);
      throw new Error("expected rejection");
    } catch (error) {
      const details = (error as HttpError).details as { retryAfter: number };
      expect(details.retryAfter).toBe(50);
    }
  });
});
