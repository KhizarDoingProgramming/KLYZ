import { loginRateLimit } from "@/lib/config/env";
import { recordAudit } from "@/lib/server/audit";
import {
  clientIp,
  clientUserAgent,
  createSession,
  readSession,
  revokeSession,
  sessionCookie,
  sessionTokenFrom,
  verifyLogin,
} from "@/lib/server/auth";
import { actorFromToken } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { HttpError, errorResponse, isRecord, readJson } from "@/lib/server/http";
import { ensureWorkspaceFor, sessionPayload } from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";

/**
 * Sign in.
 *
 * Two locks before anything else: a rate limit per IP *and* per email
 * (so one address cannot be sprayed from many hosts), then a single
 * password check whose result is identical for "no such user" and
 * "wrong password". A brand-new session is always issued and any
 * session the caller already presented is destroyed, so a fixed
 * pre-authentication cookie cannot survive the login.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const ip = clientIp(request);
    const userAgent = clientUserAgent(request);
    const body = await readJson(request);

    if (!isRecord(body)) {
      throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
    }
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!email || !password) {
      throw new HttpError(400, "BAD_REQUEST", "Enter your email and password.");
    }

    limitByKey("login:ip", ip ?? "unknown", loginRateLimit() * 3);
    limitByKey("login:email", email, loginRateLimit());

    const user = verifyLogin(email, password);
    if (!user) {
      recordAudit({
        action: "auth.login_failed",
        actorId: null,
        ip,
        userAgent,
        metadata: { email: email.slice(0, 254) },
      });
      throw new HttpError(
        401,
        "INVALID_CREDENTIALS",
        "That email and password do not match an account.",
      );
    }

    /* Session fixation: drop whatever cookie arrived with the login. */
    const presented = readSession(sessionTokenFrom(request));
    if (presented) revokeSession(presented.id);

    const workspaceId = ensureWorkspaceFor(user.id);
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
      action: "auth.login",
      actorId: user.id,
      workspaceId: actor.workspaceId,
      ip,
      userAgent,
      metadata: { email: user.email },
    });

    return Response.json(sessionPayload(actor), {
      headers: { "Set-Cookie": sessionCookie(token) },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
