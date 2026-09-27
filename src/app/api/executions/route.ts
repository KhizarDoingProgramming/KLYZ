import { errorResponse } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import {
  requireAuthenticatedActor,
} from "@/lib/server/identity";
import { listExecutionsFor } from "@/lib/server/execution-service";

export const dynamic = "force-dynamic";

/** Run history — workspace-scoped, readable by every role. */
export async function GET(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "execution:read");
    const url = new URL(request.url);
    return Response.json(listExecutionsFor(actor, url.searchParams));
  } catch (error) {
    return errorResponse(error);
  }
}
