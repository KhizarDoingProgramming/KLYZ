import { errorResponse } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { providerSummaries } from "@/lib/server/providers";

export const dynamic = "force-dynamic";

/**
 * Integration status.
 *
 * Reports which providers this deployment can actually connect, the
 * missing configuration for the ones it cannot, the scopes requested
 * and the connections that really exist — no synthesised "connected"
 * state for an account nobody authorized.
 */
export async function GET(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "integration:read");
    return Response.json({ providers: providerSummaries(actor) });
  } catch (error) {
    return errorResponse(error);
  }
}
