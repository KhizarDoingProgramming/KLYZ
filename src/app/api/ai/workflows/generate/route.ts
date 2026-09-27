import { auditAs } from "@/lib/server/audit";
import { errorResponse, readJson } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { generateAiPlan } from "@/lib/server/ai/service";

export const dynamic = "force-dynamic";

/**
 * Describe an automation → get a structured, validated workflow plan.
 *
 * Nothing is published and nothing runs — applying the plan is a
 * separate, human-approved step through the editor. The request is
 * still audited (intent length and outcome only, never the prompt), so
 * model spend is attributable to an account.
 */
export async function POST(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "ai:use");

    const body = await readJson(request);
    const result = await generateAiPlan(actor, body, request.signal);
    auditAs(actor, "ai.generate", {
      resourceType: "workflow",
      resourceId: (result.workflow as { id?: string } | undefined)?.id ?? null,
      metadata: {
        intentChars: typeof (body as { intent?: unknown }).intent === "string"
          ? String((body as { intent: string }).intent).length
          : 0,
      },
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
