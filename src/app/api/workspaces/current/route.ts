import { auditAs } from "@/lib/server/audit";
import { HttpError, errorResponse, isRecord, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { renameWorkspace } from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";

/** Rename the workspace this session is acting in (admin or owner). */
export async function PATCH(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("workspace:update", actor.workspaceId, 30, 60_000);

    const body = await readJson(request);
    if (!isRecord(body)) {
      throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
    }
    const workspace = renameWorkspace(actor, String(body.name ?? ""));
    auditAs(actor, "workspace.updated", {
      resourceType: "workspace",
      resourceId: actor.workspaceId,
      metadata: { name: workspace.name },
    });
    return Response.json({ workspace });
  } catch (error) {
    return errorResponse(error);
  }
}
