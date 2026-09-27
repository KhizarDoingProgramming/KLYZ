import { queueDriver, workerConcurrency } from "@/lib/config/env";
import { queueStats } from "@/lib/queue";
import { readHeartbeat } from "@/lib/queue/worker";
import { errorResponse, json } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";

export const dynamic = "force-dynamic";

/**
 * Queue observability — the real transport state, not a dashboard's
 * idea of it: job counts straight from BullMQ (or the in-process
 * driver) plus the worker's own heartbeat row.
 */
export async function GET(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "queue:read");

    const [stats] = await Promise.all([queueStats()]);
    const heartbeat = readHeartbeat();

    return json({
      queue: stats,
      worker: heartbeat,
      configured: {
        driver: safeDriver(),
        expectedConcurrency: workerConcurrency(),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function safeDriver(): string {
  try {
    return queueDriver();
  } catch {
    return "invalid";
  }
}
