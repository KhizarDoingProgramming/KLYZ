import { HttpError, errorResponse, isRecord, json } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { createTemplateFor, listTemplatesFor } from "@/lib/server/templates";

export const dynamic = "force-dynamic";

/** List this workspace's templates plus the built-ins. */
export async function GET(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    const url = new URL(request.url);
    const category = url.searchParams.get("category") ?? undefined;
    const query = url.searchParams.get("q") ?? undefined;
    return json({
      templates: listTemplatesFor(actor, {
        ...(category ? { category } : {}),
        ...(query ? { query } : {}),
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Save a blueprint — either `{workflowId}` to capture an existing
 * workflow's draft, or `{definition}` with a portable document.
 */
export async function POST(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("template:write", actor.workspaceId, 30, 60_000);
    const text = await request.text();
    let body: unknown;
    if (!text.trim()) {
      throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
    }
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
    }
    if (!isRecord(body)) {
      throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
    }
    return json({ template: createTemplateFor(actor, body) }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
