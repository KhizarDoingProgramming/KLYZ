import { assertResourceId } from "@/lib/server/authz";
import { errorResponse, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { saveDraftFor } from "@/lib/server/workflow-service";

export const dynamic = "force-dynamic";

/**
 * Save the editable draft.
 *
 * The body carries the definition *and* the revision it was based on.
 * A stale revision answers 409 with the server's copy rather than
 * overwriting newer work.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("workflow:draft", actor.workspaceId, 240, 60_000);
    const id = assertResourceId((await params).id, "workflow id");
    const workflow = saveDraftFor(actor, id, await readJson(request));
    return Response.json({ workflow });
  } catch (error) {
    return errorResponse(error);
  }
}
