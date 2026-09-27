import { auditAs } from "@/lib/server/audit";
import { findSessionById, revokeSession, sessionsForUser } from "@/lib/server/auth";
import { HttpError, errorResponse } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";

export const dynamic = "force-dynamic";

/**
 * Revoke one session of the signed-in account.
 *
 * The id is matched against *this user's* sessions first, so a session
 * id belonging to anyone else answers 404 — session ids are not a
 * cross-account handle.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    const { id } = await params;
    const owned = sessionsForUser(actor.userId).some((session) => session.id === id);
    if (!owned || !findSessionById(id)) {
      throw new HttpError(404, "NOT_FOUND", "That session does not exist.");
    }
    revokeSession(id);
    auditAs(actor, "auth.session_revoked", {
      resourceType: "session",
      resourceId: id,
      metadata: { scope: id === actor.sessionId ? "current" : "single" },
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
