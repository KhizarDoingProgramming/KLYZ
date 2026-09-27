import { assertResourceId } from "@/lib/server/authz";
import { errorResponse, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import {
  archiveWorkflowFor,
  getWorkflowFor,
  updateWorkflowFor,
} from "@/lib/server/workflow-service";

export const dynamic = "force-dynamic";

/** One workflow: its editable draft plus its published-version pointer. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const id = assertResourceId((await params).id, "workflow id");
    return Response.json({ workflow: getWorkflowFor(actor, id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("workflow:write", actor.workspaceId, 120, 60_000);
    const id = assertResourceId((await params).id, "workflow id");
    return Response.json({ workflow: updateWorkflowFor(actor, id, await readJson(request)) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const id = assertResourceId((await params).id, "workflow id");
    archiveWorkflowFor(actor, id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
