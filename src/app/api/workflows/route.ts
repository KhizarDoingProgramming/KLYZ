import {
  createWorkflowFor,
  listWorkflowsFor,
} from "@/lib/server/workflow-service";
import { errorResponse, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

/** Every workflow in the active workspace, drafts included. */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    return Response.json({ workflows: listWorkflowsFor(actor) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("workflow:create", actor.workspaceId, 30, 60_000);
    const workflow = createWorkflowFor(actor, await readJson(request));
    return Response.json({ workflow }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
