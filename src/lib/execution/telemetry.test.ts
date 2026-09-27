import { describe, expect, it } from "vitest";
import {
  MAX_STEP_CALLS,
  currentStepTelemetry,
  recordProviderCall,
  startStepTelemetry,
} from "./telemetry";

const call = (overrides: Partial<Parameters<typeof recordProviderCall>[0]> = {}) => ({
  provider: "slack",
  operation: "post_message",
  method: "POST",
  url: "https://hooks.slack.com/services/T0/B0/xxx",
  status: 200,
  ok: true,
  durationMs: 48,
  ...overrides,
});

describe("step telemetry", () => {
  it("is a no-op outside a step", () => {
    expect(currentStepTelemetry()).toBeUndefined();
    expect(() => recordProviderCall(call())).not.toThrow();
    expect(currentStepTelemetry()).toBeUndefined();
  });

  it("collects calls inside the step's async context only", async () => {
    const handle = startStepTelemetry();
    expect(currentStepTelemetry()).toBeUndefined();

    await handle.run(async () => {
      recordProviderCall(call());
      expect(currentStepTelemetry()).toBe(handle.telemetry);
      /* Nested work inherits the same store. */
      await Promise.resolve();
      recordProviderCall(call({ status: 429, ok: false }));
    });

    expect(handle.telemetry.calls).toHaveLength(2);
    expect(handle.telemetry.calls[1]).toMatchObject({ status: 429, ok: false });
    expect(handle.snapshot()).toEqual({
      providerCalls: handle.telemetry.calls,
      providerCallCount: 2,
    });
    expect(currentStepTelemetry()).toBeUndefined();
  });

  it("keeps calls across attempts — the retry trail shares one store", async () => {
    const handle = startStepTelemetry();
    await handle.run(async () => recordProviderCall(call()));
    await handle.run(async () => recordProviderCall(call({ status: 500, ok: false })));
    expect(handle.telemetry.calls).toHaveLength(2);
  });

  it("stops at the call budget and flags the truncation", async () => {
    const handle = startStepTelemetry();
    await handle.run(async () => {
      for (let index = 0; index < MAX_STEP_CALLS + 5; index += 1) recordProviderCall(call());
    });
    expect(handle.telemetry.calls).toHaveLength(MAX_STEP_CALLS);
    expect(handle.telemetry.truncated).toBe(true);
    expect(handle.snapshot()).toMatchObject({
      providerCallCount: MAX_STEP_CALLS,
      providerCallsTruncated: true,
    });
  });

  it("snapshots nothing when the step made no calls", () => {
    expect(startStepTelemetry().snapshot()).toEqual({});
  });
});
