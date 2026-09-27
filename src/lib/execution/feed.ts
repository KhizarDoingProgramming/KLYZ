import type { ExecutionDetail } from "./types";
import { isEngineEvent, type EngineEvent } from "./events";

/**
 * SSE payload router with snapshot buffering.
 *
 * The server subscribes us *before* reading the database snapshot, so a
 * live event can land first. Folding it immediately would let the
 * (stale) snapshot overwrite newer state when it arrives a moment later.
 * Events are therefore held until the snapshot is applied, then replayed
 * in order — every buffered event either equals a snapshot row or is
 * newer than it, so the fold stays correct either way.
 */
export interface FeedHandlers {
  onSnapshot: (execution: ExecutionDetail) => void;
  onEvent: (event: EngineEvent) => void;
}

export interface ExecutionFeed {
  push: (payload: unknown) => void;
}

export function createFeed(handlers: FeedHandlers): ExecutionFeed {
  let snapshotApplied = false;
  const buffered: EngineEvent[] = [];

  return {
    push(payload: unknown): void {
      if (!payload || typeof payload !== "object") return;
      const type = (payload as { type?: unknown }).type;

      if (type === "snapshot") {
        const execution = (payload as { execution?: ExecutionDetail }).execution;
        if (!execution) return;
        snapshotApplied = true;
        handlers.onSnapshot(execution);
        for (const event of buffered.splice(0)) handlers.onEvent(event);
        return;
      }

      if (!isEngineEvent(payload)) return;
      if (snapshotApplied) {
        handlers.onEvent(payload);
      } else {
        buffered.push(payload);
      }
    },
  };
}
