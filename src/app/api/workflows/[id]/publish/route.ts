import { assertResourceId } from "@/lib/server/authz";
import { errorResponse } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { publishWorkflowFor } from "@/lib/server/workflow-service";

export const dynamic = "force-dynamic";

/**
 * Turn the current draft into an immutable version.
 *
 * Nothing in the body is trusted: the definition is read from the row,
 * validated here, and written once. `workflow_versions` has no UPDATE
 * path, so a published version cannot change afterwards.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("workflow:publish", actor.workspaceId, 30, 60_000);
    const id = assertResourceId((await params).id, "workflow id");
    const result = publishWorkflowFor(actor, id);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
