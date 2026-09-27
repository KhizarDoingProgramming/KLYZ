import { errorResponse, isRecord, readJson } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { startConnect } from "@/lib/server/oauth";
import { parseProvider } from "@/lib/server/providers";

export const dynamic = "force-dynamic";

/**
 * Starts an OAuth handshake.
 *
 * Returns the provider's authorisation URL; the browser navigates to
 * it and comes back on `/api/providers/<provider>/callback`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    const { provider } = await params;
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "integration:manage");
    limitByKey("oauth:start", actor.workspaceId, 20, 60_000);
    const body = await readJson(request).catch(() => ({}));
    const redirectPath = isRecord(body) && typeof body.redirect === "string"
      ? body.redirect
      : "/integrations";
    const connect = startConnect(actor, parseProvider(provider), redirectPath);
    return Response.json(connect);
  } catch (error) {
    return errorResponse(error);
  }
}
