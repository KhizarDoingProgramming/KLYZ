import { assertResourceId } from "@/lib/server/authz";
import { errorResponse, isRecord, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import {
  listVersionsFor,
  restoreVersionFor,
} from "@/lib/server/workflow-service";

export const dynamic = "force-dynamic";

/** Immutable version history for one workflow. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const id = assertResourceId((await params).id, "workflow id");
    return Response.json({ versions: listVersionsFor(actor, id) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Copy a version back into the draft.
 *
 * It does not move `published_version_id` — the restored graph still
 * has to be published before anything runs it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const id = assertResourceId((await params).id, "workflow id");
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.versionId !== "string" || !body.versionId) {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "A versionId is required." } },
        { status: 400 },
      );
    }
    const workflow = restoreVersionFor(actor, id, body.versionId);
    return Response.json({ workflow });
  } catch (error) {
    return errorResponse(error);
  }
}
