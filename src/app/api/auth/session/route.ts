import { errorResponse } from "@/lib/server/http";
import { getAuthenticatedActor } from "@/lib/server/identity";
import { sessionPayload } from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";

/**
 * Who am I?
 *
 * Always 200 with `authenticated: false` when there is no live session,
 * so a client can probe without treating "signed out" as an error. The
 * response carries no token — the HttpOnly cookie is the credential.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = getAuthenticatedActor(request);
    if (!actor) {
      return Response.json({ authenticated: false });
    }
    return Response.json({ authenticated: true, ...sessionPayload(actor) });
  } catch (error) {
    return errorResponse(error);
  }
}
