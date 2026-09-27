import { errorResponse } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { getExecutionDetailFor } from "@/lib/server/execution-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "execution:read");
    const { id } = await params;
    return Response.json({ execution: getExecutionDetailFor(actor, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
