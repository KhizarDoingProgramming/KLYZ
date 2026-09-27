import { setActiveWorkspace } from "@/lib/server/auth";
import { HttpError, errorResponse, isRecord, readJson } from "@/lib/server/http";
import { membershipOf, requireAuthenticatedActor } from "@/lib/server/identity";

export const dynamic = "force-dynamic";

/**
 * Switch the session into another workspace.
 *
 * The id in the body is a *choice*, not a claim: it is accepted only
 * when `workspace_members` proves this account belongs there. A
 * foreign workspace id produces 403 and changes nothing.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.workspaceId !== "string" || !body.workspaceId) {
      throw new HttpError(400, "BAD_REQUEST", "A workspaceId is required.");
    }
    const membership = membershipOf({
      userId: actor.userId,
      workspaceId: body.workspaceId,
    });
    if (!membership) {
      throw new HttpError(
        403,
        "NOT_A_MEMBER",
        "You do not have access to this workspace.",
      );
    }
    setActiveWorkspace(actor.sessionId, membership.workspaceId);
    return Response.json({ activeWorkspaceId: membership.workspaceId, role: membership.role });
  } catch (error) {
    return errorResponse(error);
  }
}
