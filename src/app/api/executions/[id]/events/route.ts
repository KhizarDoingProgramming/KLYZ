import { queueDriver } from "@/lib/config/env";
import {
  isFinishedEvent,
  type EngineEvent,
} from "@/lib/execution/events";
import type { ExecutionDetail } from "@/lib/execution/types";
import { errorResponse } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { membershipOf, requireAuthenticatedActor, type AuthenticatedActor } from "@/lib/server/identity";
import { getExecutionDetailFor } from "@/lib/server/execution-service";
import { subscribe } from "@/lib/server/bus";
import { ensureEventRelay } from "@/lib/server/realtime";

export const dynamic = "force-dynamic";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_INTERVAL_MS = 2_000;
const MEMBERSHIP_CHECK_MS = 15_000;

function wantsRelay(): boolean {
  try {
    return queueDriver() === "redis";
  } catch {
    return false;
  }
}

/** Still allowed to watch? Membership can be revoked mid-stream. */
function stillAuthorized(actor: AuthenticatedActor): boolean {
  return (
    membershipOf({ userId: actor.userId, workspaceId: actor.workspaceId }) !== null
  );
}

/**
 * Live execution events over Server-Sent Events.
 *
 * Connect → snapshot (durable truth from the database) → live engine
 * events → close on the terminal event. Reconnecting replays a fresh
 * snapshot, so a page refresh or dropped connection never loses the run.
 *
 * Authorization: the session is resolved and the execution's workspace
 * membership is proven *before* the stream opens, so an unauthenticated
 * or foreign subscriber never receives a frame. Membership is re-checked
 * while the stream is open, so revocation ends the subscription.
 *
 * With executions running in the worker process, events arrive through
 * the Redis relay; when the relay cannot be established the stream
 * polls the database instead, so a Redis restart degrades to a
 * two-second refresh rather than a frozen canvas.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "execution:read");
    const { id } = await params;

    /* Access check first — 404/403 as JSON, not as a broken stream. */
    getExecutionDetailFor(actor, id);

    /* Establish the cross-process relay before the snapshot read: every
       event is then either in the snapshot or delivered live. */
    const relayAvailable = wantsRelay() ? await ensureEventRelay() : false;
    const pollFallback = wantsRelay() && !relayAvailable;

    const encoder = new TextEncoder();
    let closeStream: () => void = () => {};

    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let poller: ReturnType<typeof setInterval> | null = null;
        let unsubscribe: (() => void) | null = null;

        const finish = (): void => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          unsubscribe = null;
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
          if (poller) clearInterval(poller);
          poller = null;
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        };
        closeStream = finish;

        const write = (payload: unknown): void => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
            );
          } catch {
            finish();
          }
        };

        const buffer: EngineEvent[] = [];
        let live = false;

        /* Subscribe before reading the snapshot so no event is lost
           between the read and the subscription. */
        unsubscribe = subscribe(id, (event) => {
          if (!live) {
            buffer.push(event);
            return;
          }
          write(event);
          if (isFinishedEvent(event)) finish();
        });

        const snapshot: ExecutionDetail = getExecutionDetailFor(actor, id);
        write({ type: "snapshot", execution: snapshot });

        if (TERMINAL.has(snapshot.status)) {
          finish();
          return;
        }

        live = true;
        while (buffer.length > 0 && !closed) {
          const event = buffer.shift()!;
          write(event);
          if (isFinishedEvent(event)) {
            finish();
            return;
          }
        }
        if (closed) return;

        heartbeat = setInterval(() => {
          if (closed) return;
          if (!stillAuthorized(actor)) {
            finish();
            return;
          }
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            finish();
          }
        }, MEMBERSHIP_CHECK_MS);

        if (pollFallback) {
          let lastStatus = snapshot.status;
          let lastSteps = snapshot.steps.length;
          poller = setInterval(() => {
            if (closed) return;
            try {
              const detail = getExecutionDetailFor(actor, id);
              if (detail.status !== lastStatus || detail.steps.length !== lastSteps) {
                lastStatus = detail.status;
                lastSteps = detail.steps.length;
                write({ type: "snapshot", execution: detail });
              }
              if (TERMINAL.has(detail.status)) finish();
            } catch {
              finish();
            }
          }, POLL_INTERVAL_MS);
        }
      },
      cancel() {
        closeStream();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
