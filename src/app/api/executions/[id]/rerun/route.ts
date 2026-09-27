import { auditAs } from "@/lib/server/audit";
import { HttpError, errorResponse } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { rerunExecutionFor, type RerunBody } from "@/lib/server/execution-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "execution:run");
    const { id } = await params;
    const body = await readBody(request);
    /* 201, not 202: this is a *new* execution record, already written. */
    const execution = await rerunExecutionFor(actor, id, body);
    auditAs(actor, "execution.retried", {
      resourceType: "execution",
      resourceId: execution.id,
      metadata: { from: id, workflowId: execution.workflowId },
    });
    return Response.json({ execution }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Rerun bodies are optional — an empty POST means "same again". */
async function readBody(request: Request): Promise<RerunBody> {
  const text = await request.text().catch(() => "");
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RerunBody;
    }
    return {};
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
  }
}
