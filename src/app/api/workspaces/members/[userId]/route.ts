import { auditAs } from "@/lib/server/audit";
import { HttpError, errorResponse, isRecord, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { changeMemberRole, removeMember } from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";

/**
 * Change a member's role.
 *
 * Every invariant lives server-side in `changeMemberRole`: no
 * privilege above the caller's own role, no touching an owner unless
 * you are one, and the last owner can never be demoted.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("members:mutate", actor.workspaceId, 30, 60_000);
    const { userId } = await params;
    if (!userId) throw new HttpError(400, "BAD_REQUEST", "A member id is required.");

    const body = await readJson(request);
    if (!isRecord(body)) {
      throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
    }
    const member = changeMemberRole(actor, userId, String(body.role ?? ""));
    auditAs(actor, "workspace.role_changed", {
      resourceType: "user",
      resourceId: userId,
      metadata: { role: member.role },
    });
    return Response.json({ member });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Remove a member — refused when the workspace would lose its owner. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("members:mutate", actor.workspaceId, 30, 60_000);
    const { userId } = await params;
    if (!userId) throw new HttpError(400, "BAD_REQUEST", "A member id is required.");

    removeMember(actor, userId);
    auditAs(actor, "workspace.member_removed", {
      resourceType: "user",
      resourceId: userId,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
