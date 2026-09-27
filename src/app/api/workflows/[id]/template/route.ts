import { assertResourceId } from "@/lib/server/authz";
import { HttpError, errorResponse, isRecord, json } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { createTemplateFor } from "@/lib/server/templates";

export const dynamic = "force-dynamic";

async function readOptionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
  }
}

/**
 * Save a workflow's draft as a template in this workspace's library.
 *
 * The definition is exported through the normal portable path, so the
 * stored template never contains credential values — only the
 * `{provider, name}` references an importer can resolve.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const id = assertResourceId((await params).id, "workflow id");
    limitByKey("template:write", actor.workspaceId, 30, 60_000);

    const body = await readOptionalJson(request);
    if (!isRecord(body)) {
      throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
    }
    const template = createTemplateFor(actor, { ...body, workflowId: id });
    return json({ template }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
