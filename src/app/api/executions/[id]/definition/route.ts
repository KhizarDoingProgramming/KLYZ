import { errorResponse } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { getExecutionDefinitionFor } from "@/lib/server/execution-service";

export const dynamic = "force-dynamic";

/**
 * The graph behind a run — the canvas the debugger draws.
 *
 * Ownership is proven before the version row is read, so a version id
 * from another workspace is unreachable even if it is known.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "execution:read");
    const { id } = await params;
    return Response.json({ definition: getExecutionDefinitionFor(actor, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
