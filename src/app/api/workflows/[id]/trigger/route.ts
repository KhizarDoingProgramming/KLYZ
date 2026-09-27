import { assertResourceId } from "@/lib/server/authz";
import { errorResponse, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { readTriggerFor, setTriggerFor } from "@/lib/server/triggers";

export const dynamic = "force-dynamic";

/**
 * One workflow's trigger: its enable switch, and for a schedule its
 * cron/timezone plus the next few occurrences.
 *
 * The response is computed on the server — including `nextRunAt` and
 * `preview`, which are derived from the stored expression with the same
 * function the scheduler uses. The editor renders the numbers it is
 * given; it never predicts a fire time of its own, so what the card
 * says and what the worker does cannot drift.
 *
 * There is no separate preview endpoint: previewing is reading.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const id = assertResourceId((await params).id, "workflow id");
    return Response.json({ trigger: readTriggerFor(actor, id) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Arm, disarm or reschedule a trigger.
 *
 * The body carries only trigger state — `enabled` and, for a schedule,
 * the timing. No definition, no endpoint secret, no execution input:
 * this endpoint cannot publish a workflow or start a run.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const id = assertResourceId((await params).id, "workflow id");
    limitByKey("trigger:mutate", actor.workspaceId, 60, 60_000);
    const trigger = setTriggerFor(actor, id, await readJson(request));
    return Response.json({ trigger });
  } catch (error) {
    return errorResponse(error);
  }
}
