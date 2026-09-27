import type { EngineEvent } from "@/lib/execution/events";

/**
 * In-process event bus for live executions.
 *
 * Events are already durable (they are persisted by the execution
 * service); this bus only fans them out to open SSE streams. It lives
 * on `globalThis` so dev-server reloads and route module churn never
 * orphan a running execution — a queue (Redis, etc.) can replace the
 * publish side later without touching subscribers.
 */

type Listener = (event: EngineEvent) => void;

interface BusState {
  listeners: Map<string, Set<Listener>>;
}

function state(): BusState {
  const global = globalThis as typeof globalThis & { __klyzBus?: BusState };
  if (!global.__klyzBus) global.__klyzBus = { listeners: new Map() };
  return global.__klyzBus;
}

export function publish(executionId: string, event: EngineEvent): void {
  const set = state().listeners.get(executionId);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(event);
    } catch {
      /* a broken subscriber must not break the run */
    }
  }
}

export function subscribe(executionId: string, listener: Listener): () => void {
  const { listeners } = state();
  let set = listeners.get(executionId);
  if (!set) {
    set = new Set();
    listeners.set(executionId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(executionId);
  };
}
