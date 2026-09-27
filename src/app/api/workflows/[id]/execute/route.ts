import { auditAs } from "@/lib/server/audit";
import { assertResourceId } from "@/lib/server/authz";
import { errorResponse, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { runWorkflowFor } from "@/lib/server/workflow-service";

export const dynamic = "force-dynamic";

/**
 * Start a run of one workflow.
 *
 * The request names a workflow and, optionally, a run input. It does
 * **not** carry a definition: the graph that runs is the one the server
 * already holds for this id, pinned to an immutable version row. A
 * client that posts a graph here gets its graph ignored — which means
 * there is nothing to spoof, and no path from "I can guess an id" to
 * "I can execute arbitrary code in this workspace".
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const id = assertResourceId((await params).id, "workflow id");
    limitByKey("execution:start", actor.workspaceId, 60, 60_000);

    const execution = await runWorkflowFor(actor, id, await readJson(request));
    auditAs(actor, "execution.started", {
      resourceType: "execution",
      resourceId: execution.id,
      metadata: {
        workflowId: id,
        workflowVersion: execution.workflowVersion,
        workflowVersionId: execution.workflowVersionId,
      },
    });
    return Response.json({ execution }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
