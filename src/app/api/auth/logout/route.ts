import { recordAudit } from "@/lib/server/audit";
import {
  clearSessionCookie,
  assertSameOrigin,
  clientIp,
  clientUserAgent,
  readSession,
  revokeSession,
  sessionTokenFrom,
} from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Sign out.
 *
 * The server-side row is deleted, not just the cookie cleared, so the
 * token stops working everywhere — including another tab or a copied
 * cookie. Always answers 200: signing out twice is not an error, but a
 * sign-out posted from another origin is refused first.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const session = readSession(sessionTokenFrom(request));
    if (session) {
      revokeSession(session.id);
      recordAudit({
        action: "auth.logout",
        actorId: session.user_id,
        workspaceId: session.active_workspace_id,
        ip: clientIp(request),
        userAgent: clientUserAgent(request),
      });
    }
    return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
  } catch (error) {
    return errorResponse(error);
  }
}
