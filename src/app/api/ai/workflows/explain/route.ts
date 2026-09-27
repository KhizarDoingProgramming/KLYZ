import { errorResponse, readJson } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { explainWorkflowAi } from "@/lib/server/ai/service";

export const dynamic = "force-dynamic";

/**
 * Explain a workflow — or a single node of it (`nodeId`) — grounded in
 * the graph that was sent. The workflow arrives as context (the editor
 * may hold unsaved changes); it is never persisted by this route.
 */
export async function POST(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "ai:use");

    const body = await readJson(request);
    const result = await explainWorkflowAi(actor, body, request.signal);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
