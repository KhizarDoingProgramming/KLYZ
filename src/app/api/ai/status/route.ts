import { errorResponse } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { aiStatus } from "@/lib/server/ai/provider";
import { capabilityDigest } from "@/lib/ai/catalog";

export const dynamic = "force-dynamic";

/**
 * Capability + configuration state for the builder shell.
 *
 * Lets the UI render "not configured" guidance (and the catalog digest
 * as a version stamp) without firing a request that is bound to fail.
 * Never includes the API key.
 */
export async function GET(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "ai:use");

    return Response.json({ ai: aiStatus(), catalog: capabilityDigest() });
  } catch (error) {
    return errorResponse(error);
  }
}
