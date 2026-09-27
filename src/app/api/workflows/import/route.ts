import { PORTABLE_LIMITS } from "@/lib/workflow/portable";
import { HttpError, errorResponse, isRecord, json } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { importWorkflowFor } from "@/lib/server/portability";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = PORTABLE_LIMITS.maxRequestBytes;

/**
 * Read a body under a hard byte ceiling.
 *
 * `Content-Length` is checked first so an oversized request is refused
 * without allocating for it, and the actual read is checked too because
 * a chunked request can omit or lie about the header.
 */
async function readCappedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new HttpError(
      413,
      "REQUEST_TOO_LARGE",
      `The request body is larger than ${Math.round(MAX_REQUEST_BYTES / 1024)} KB.`,
    );
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
    throw new HttpError(
      413,
      "REQUEST_TOO_LARGE",
      `The request body is larger than ${Math.round(MAX_REQUEST_BYTES / 1024)} KB.`,
    );
  }
  if (!text.trim()) {
    throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
  }
}

/**
 * Import a portable workflow.
 *
 * `dryRun: true` validates and reports — credential requirements,
 * warnings and a summary — without writing a row. Nothing published is
 * created either way: the import lands as a paused draft.
 */
export async function POST(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("workflow:import", actor.workspaceId, 20, 60_000);
    const body = await readCappedJson(request);
    if (!isRecord(body)) {
      throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
    }
    const outcome = importWorkflowFor(actor, body);
    return json(
      {
        workflow: outcome.workflow,
        summary: outcome.summary,
        requirements: outcome.requirements,
        warnings: outcome.warnings,
        dryRun: body.dryRun === true,
      },
      201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
