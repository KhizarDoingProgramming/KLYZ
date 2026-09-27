import { errorResponse, readJson } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { refineAiPlan } from "@/lib/server/ai/service";

export const dynamic = "force-dynamic";

/** Revise a plan in place. Same contract as generate — still no writes. */
export async function POST(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "ai:use");

    const body = await readJson(request);
    const result = await refineAiPlan(actor, body, request.signal);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
