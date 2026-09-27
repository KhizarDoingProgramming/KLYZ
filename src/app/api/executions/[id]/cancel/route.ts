import { auditAs } from "@/lib/server/audit";
import { errorResponse } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { cancelExecutionFor } from "@/lib/server/execution-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    /* Viewers may watch runs but never stop them. */
    requirePermission(actor, "execution:cancel");
    const { id } = await params;
    /* Awaited on purpose: `cancelExecution` resolves *after* the abort is
       requested (and settles a queued run synchronously), and an async
       rejection must land in this catch instead of becoming an unhandled
       promise. */
    const result = await cancelExecutionFor(actor, id);
    auditAs(actor, "execution.cancelled", {
      resourceType: "execution",
      resourceId: id,
      metadata: { status: result?.status ?? "cancelled" },
    });
    return Response.json(result, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
