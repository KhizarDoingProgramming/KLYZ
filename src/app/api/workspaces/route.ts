import { auditAs } from "@/lib/server/audit";
import { setActiveWorkspace } from "@/lib/server/auth";
import { HttpError, errorResponse, isRecord, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import {
  createWorkspace,
  listWorkspacesFor,
} from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";

/**
 * The workspaces this account can act in.
 *
 * Every entry comes from `workspace_members`, so a user only ever sees
 * tenants they belong to — the list itself is an authorization result,
 * not a directory.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    return Response.json({
      workspaces: listWorkspacesFor(actor),
      activeWorkspaceId: actor.workspaceId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Create a workspace and switch this session into it. */
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("workspace:create", actor.userId, 10, 60 * 60_000);

    const body = await readJson(request);
    if (!isRecord(body)) {
      throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
    }
    const workspace = createWorkspace(actor, String(body.name ?? ""));
    setActiveWorkspace(actor.sessionId, workspace.id);

    auditAs(actor, "workspace.created", {
      resourceType: "workspace",
      resourceId: workspace.id,
      metadata: { name: workspace.name, slug: workspace.slug },
    });

    return Response.json({ workspace }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
