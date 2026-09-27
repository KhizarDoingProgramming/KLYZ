import { assertResourceId } from "@/lib/server/authz";
import { errorResponse } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { exportWorkflowFor } from "@/lib/server/portability";

export const dynamic = "force-dynamic";

/**
 * Download a workflow as a portable document.
 *
 * Optional `?version=<id>` exports one immutable published version
 * instead of the working draft. The bytes are already sanitised — no
 * workspace ids, no credential values, no webhook secrets — so this is
 * safe to hand to anybody.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const id = assertResourceId((await params).id, "workflow id");
    const versionId = new URL(request.url).searchParams.get("version") ?? undefined;

    const result = exportWorkflowFor(actor, id, versionId ? { versionId } : {});
    return new Response(JSON.stringify({ export: result }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${result.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
