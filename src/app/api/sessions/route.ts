import { auditAs } from "@/lib/server/audit";
import { revokeSession, sessionsForUser } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";

export const dynamic = "force-dynamic";

function view(
  row: { id: string; created_at: number; last_seen_at: number; expires_at: number; ip: string | null; user_agent: string | null },
  currentId: string,
): Record<string, unknown> {
  return {
    id: row.id,
    current: row.id === currentId,
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

/** Active sessions for the signed-in account only. */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    const sessions = sessionsForUser(actor.userId).map((row) => view(row, actor.sessionId));
    return Response.json({ sessions });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Revoke every *other* session for this account. */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    const sessions = sessionsForUser(actor.userId);
    let revoked = 0;
    for (const session of sessions) {
      if (session.id === actor.sessionId) continue;
      revokeSession(session.id);
      revoked += 1;
    }
    if (revoked > 0) {
      auditAs(actor, "auth.session_revoked", {
        resourceType: "session",
        resourceId: null,
        metadata: { revoked, scope: "others" },
      });
    }
    return Response.json({ ok: true, revoked });
  } catch (error) {
    return errorResponse(error);
  }
}
