import { allowRegistration, registerRateLimit } from "@/lib/config/env";
import { recordAudit } from "@/lib/server/audit";
import {
  clientIp,
  clientUserAgent,
  createSession,
  createUser,
  readSession,
  revokeSession,
  sessionCookie,
  sessionTokenFrom,
} from "@/lib/server/auth";
import { actorFromToken } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { HttpError, errorResponse, isRecord, readJson } from "@/lib/server/http";
import { ensureWorkspaceFor, sessionPayload } from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";

/**
 * Create an account.
 *
 * The new user is placed by `ensureWorkspaceFor`: the first account
 * adopts the seeded demo workspace, everyone after that gets their own
 * — so registering can never grant access to someone else's tenant.
 * Rate limited per IP; disable with `KLYZ_ALLOW_REGISTRATION=false` on
 * deployments where accounts are provisioned by an operator.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!allowRegistration()) {
      throw new HttpError(
        403,
        "REGISTRATION_DISABLED",
        "Account creation is disabled on this deployment.",
      );
    }
    const ip = clientIp(request);
    const userAgent = clientUserAgent(request);
    limitByKey("register:ip", ip ?? "unknown", registerRateLimit(), 60 * 60_000);

    const body = await readJson(request);
    if (!isRecord(body)) {
      throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
    }
    const email = String(body.email ?? "");
    const name = String(body.name ?? "");
    const password = String(body.password ?? "");

    const user = createUser({ email, name, password });
    const workspaceId = ensureWorkspaceFor(user.id);

    const presented = readSession(sessionTokenFrom(request));
    if (presented) revokeSession(presented.id);

    const { token } = createSession(user.id, {
      ip,
      userAgent,
      activeWorkspaceId: workspaceId,
    });
    const actor = actorFromToken(token);
    if (!actor) {
      throw new HttpError(500, "SESSION_FAILED", "The session could not be created.");
    }

    recordAudit({
      action: "auth.registered",
      actorId: user.id,
      workspaceId: actor.workspaceId,
      ip,
      userAgent,
      metadata: { email: user.email },
    });

    return Response.json(sessionPayload(actor), {
      status: 201,
      headers: { "Set-Cookie": sessionCookie(token) },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
