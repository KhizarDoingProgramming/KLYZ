import { auditAs } from "@/lib/server/audit";
import { HttpError, errorResponse, isRecord, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { transferOwnership } from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";

/**
 * Hand ownership to another member.
 *
 * Owner-only, target must already be a member, and the actor steps down
 * to admin in the same operation — so the workspace never has two
 * acting owners after an explicit transfer and can never have none.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("workspace:transfer", actor.workspaceId, 5, 60 * 60_000);

    const body = await readJson(request);
    if (!isRecord(body) || typeof body.userId !== "string" || !body.userId) {
      throw new HttpError(400, "BAD_REQUEST", "A userId is required.");
    }
    const member = transferOwnership(actor, body.userId);
    auditAs(actor, "workspace.ownership_transferred", {
      resourceType: "user",
      resourceId: member.userId,
      metadata: { role: member.role },
    });
    return Response.json({ member });
  } catch (error) {
    return errorResponse(error);
  }
}
