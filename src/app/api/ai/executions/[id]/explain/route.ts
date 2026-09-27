import { errorResponse, readJson } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { explainExecutionAi } from "@/lib/server/ai/service";

export const dynamic = "force-dynamic";

/**
 * Explain a failed run from redacted, workspace-scoped execution data.
 * The execution is loaded server-side by id (ownership checked), so the
 * browser never assembles — or sees — raw step payloads for this call.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "ai:use");
    requirePermission(actor, "execution:read");

    await readJson(request).catch(() => ({}));
    const { id } = await params;
    const result = await explainExecutionAi(actor, id, request.signal);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
