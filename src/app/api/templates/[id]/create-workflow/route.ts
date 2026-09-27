import { assertResourceId } from "@/lib/server/authz";
import { HttpError, errorResponse, isRecord, json } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { createWorkflowFromTemplateFor } from "@/lib/server/templates";

export const dynamic = "force-dynamic";

/**
 * Create a draft workflow from a template.
 *
 * Same rules as an import: the document is re-validated, credentials
 * are mapped only where a matching connection exists, anything left
 * over comes back as a requirement for the editor to fill, and the
 * result is an unpublished draft with its schedule still paused.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const id = assertResourceId((await params).id, "template id");

    const text = await request.text();
    let body: unknown = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
      }
    }
    if (!isRecord(body)) {
      throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
    }

    const result = createWorkflowFromTemplateFor(actor, id, body);
    return json(
      {
        workflow: result.workflow,
        summary: result.summary,
        requirements: result.requirements,
        warnings: result.warnings,
      },
      201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
