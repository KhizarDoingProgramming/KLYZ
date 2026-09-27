import { auditAs } from "@/lib/server/audit";
import { HttpError, errorResponse, isRecord, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { addMember, listMembers } from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";

/** Members of the active workspace (any role can see who is here). */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    return Response.json({ members: listMembers(actor) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Add an existing account to the active workspace.
 *
 * Admin or owner only (enforced by `addMember`), and the granted role
 * can never exceed the granter's own role.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("members:mutate", actor.workspaceId, 30, 60_000);

    const body = await readJson(request);
    if (!isRecord(body)) {
      throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
    }
    const member = addMember(
      actor,
      String(body.email ?? ""),
      String(body.role ?? "member"),
    );
    auditAs(actor, "workspace.member_added", {
      resourceType: "user",
      resourceId: member.userId,
      metadata: { email: member.email, role: member.role },
    });
    return Response.json({ member }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
