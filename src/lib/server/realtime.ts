import { isEngineEvent, type EngineEvent } from "@/lib/execution/events";
import { publish, subscribe } from "./bus";
import { tryRedis, trySubscriber } from "./redis";

/**
 * Realtime fan-out across processes.
 *
 * With executions running in a separate worker, an event persisted in
 * the worker has to reach SSE streams held open by the API process.
 * Publishing to Redis does that; the in-process bus remains the
 * transport for memory-queue runs and for the degraded case where
 * Redis is unavailable. Exactly one of the two paths runs per event,
 * so a subscriber never sees a duplicate.
 */

export const EVENTS_CHANNEL = "klyz:events";

interface RelayState {
  subscriberReady: boolean;
  subscribed: boolean;
  connecting: Promise<boolean> | null;
  lastError?: string;
}

function relayState(): RelayState {
  const global = globalThis as typeof globalThis & { __klyzRelay?: RelayState };
  if (!global.__klyzRelay) {
    global.__klyzRelay = { subscriberReady: false, subscribed: false, connecting: null };
  }
  return global.__klyzRelay;
}

/** True when the cross-process relay is connected and subscribed. */
export function relayReady(): boolean {
  return relayState().subscriberReady;
}

/** Persist-then-publish entry point (see execution-store.emitPersisted). */
export function publishEvent(executionId: string, event: EngineEvent): void {
  const client = tryRedis();
  if (client && client.status === "ready") {
    void client
      .publish(EVENTS_CHANNEL, JSON.stringify(event))
      .catch(() => {
        /* Redis dropped mid-publish: fall back to local listeners */
        publish(executionId, event);
      });
    return;
  }
  publish(executionId, event);
}

/**
 * Ensure this process is subscribed to the cross-process event channel.
 * Resolves `true` when live events will be delivered by the relay.
 */
export async function ensureEventRelay(): Promise<boolean> {
  const state = relayState();
  if (state.subscriberReady) return true;
  if (state.connecting) return state.connecting;

  const subscriber = trySubscriber();
  if (!subscriber) return false;

  state.connecting = (async () => {
    try {
      attachListener(subscriber);
      await subscriber.subscribe(EVENTS_CHANNEL);
      state.subscriberReady = true;
      state.lastError = undefined;
      return true;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : "relay unavailable";
      return false;
    } finally {
      state.connecting = null;
    }
  })();
  return state.connecting;
}

const listening: WeakSet<object> = new WeakSet();

function attachListener(subscriber: object): void {
  if (listening.has(subscriber)) return;
  listening.add(subscriber);
  const client = subscriber as {
    on: (event: string, handler: (...args: never[]) => void) => void;
  };
  client.on("message", ((channel: string, payload: string) => {
    if (channel !== EVENTS_CHANNEL) return;
    const state = relayState();
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!isEngineEvent(parsed)) return;
      publish(parsed.executionId, parsed);
      state.lastError = undefined;
    } catch {
      /* a malformed frame must not kill the subscription */
    }
  }) as never);
  client.on("close", (() => {
    relayState().subscriberReady = false;
  }) as never);
  client.on("end", (() => {
    relayState().subscriberReady = false;
  }) as never);
}

/** Local subscribe — used by SSE in addition to the relay. */
export function subscribeLocal(executionId: string, listener: (event: EngineEvent) => void): () => void {
  return subscribe(executionId, listener);
}
