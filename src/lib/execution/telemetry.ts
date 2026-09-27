import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-step telemetry.
 *
 * The engine runs one step at a time inside an async context; HTTP
 * layers push what they did (host, method, status, duration, rate-limit
 * windows) into the store, and the engine attaches the snapshot to the
 * step when it settles. That is how the debugger can answer "what did
 * this step actually call?" without the engine importing a single
 * integration — the data flows through an ambient context instead.
 *
 * Outside a step there is no store: `recordProviderCall` is a no-op, so
 * background jobs, credential tests and OAuth refreshes are unaffected.
 *
 * The store never holds credentials: URLs arrive scrubbed of userinfo
 * and sensitive query parameters, and headers are never recorded.
 */

export interface ProviderCallRecord {
  provider: string;
  operation: string;
  method: string;
  /** Path/host only — query parameters that look like secrets are masked. */
  url: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  requestId?: string;
  rateLimit?: {
    limit: number | null;
    remaining: number | null;
    resetAt: number | null;
    retryAfterMs: number | null;
  };
  /** Stable error code (`SLACK_VALIDATION`, `HTTP_TIMEOUT`, …). */
  error?: string;
}

export interface StepTelemetry {
  calls: ProviderCallRecord[];
  /** True once the call budget was hit and later calls were dropped. */
  truncated: boolean;
}

export const MAX_STEP_CALLS = 20;

const storage = new AsyncLocalStorage<StepTelemetry>();

export interface StepTelemetryHandle {
  /** Read it after the step settles — later attempts append in place. */
  readonly telemetry: StepTelemetry;
  /** Run `fn` with this telemetry bound to its async context. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Shape to merge into `ExecutionStepView.metadata`. Empty if nothing happened. */
  snapshot(): Record<string, unknown>;
}

export function startStepTelemetry(): StepTelemetryHandle {
  const telemetry: StepTelemetry = { calls: [], truncated: false };
  return {
    telemetry,
    run: (fn) => storage.run(telemetry, fn),
    snapshot: () => {
      if (telemetry.calls.length === 0) return {};
      return {
        providerCalls: telemetry.calls,
        providerCallCount: telemetry.calls.length,
        ...(telemetry.truncated ? { providerCallsTruncated: true } : {}),
      };
    },
  };
}

/** Record one outbound call. Silently ignored when no step is running. */
export function recordProviderCall(record: ProviderCallRecord): void {
  const store = storage.getStore();
  if (!store) return;
  if (store.calls.length >= MAX_STEP_CALLS) {
    store.truncated = true;
    return;
  }
  store.calls.push(record);
}

/** The store of the step currently on the stack, if any. */
export function currentStepTelemetry(): StepTelemetry | undefined {
  return storage.getStore();
}
