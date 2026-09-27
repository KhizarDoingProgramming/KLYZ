import { assertResourceId } from "@/lib/server/authz";
import { errorResponse } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { duplicateWorkflowFor } from "@/lib/server/workflow-service";

export const dynamic = "force-dynamic";

/** Copy a workflow's draft into a new, unpublished workflow. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("workflow:create", actor.workspaceId, 30, 60_000);
    const id = assertResourceId((await params).id, "workflow id");
    return Response.json({ workflow: duplicateWorkflowFor(actor, id) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
