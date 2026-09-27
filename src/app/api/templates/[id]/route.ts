import { assertResourceId } from "@/lib/server/authz";
import { HttpError, errorResponse, isRecord, json } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { deleteTemplateFor, getTemplateFor, updateTemplateFor } from "@/lib/server/templates";

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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(_request);
    const id = assertResourceId((await params).id, "template id");
    const result = getTemplateFor(actor, id);
    return json(result);
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
    const id = assertResourceId((await params).id, "template id");
    limitByKey("template:write", actor.workspaceId, 30, 60_000);
    const body = await readOptionalJson(request);
    if (!isRecord(body)) {
      throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
    }
    return json({ template: updateTemplateFor(actor, id, body) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(_request);
    const id = assertResourceId((await params).id, "template id");
    limitByKey("template:write", actor.workspaceId, 30, 60_000);
    deleteTemplateFor(actor, id);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
