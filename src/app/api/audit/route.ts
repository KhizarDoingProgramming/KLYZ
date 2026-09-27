import { listAuditFor } from "@/lib/server/audit";
import { errorResponse } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { requirePermission } from "@/lib/server/authz";

export const dynamic = "force-dynamic";

/**
 * Security activity for the active workspace (admin or owner).
 *
 * Rows are workspace-scoped and metadata has been redacted at write
 * time, so this endpoint can never be used to read another tenant's
 * history or to recover a secret that an audit row once touched.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "audit:read");
    const url = new URL(request.url);
    const result = listAuditFor(actor, {
      limit: Number(url.searchParams.get("limit") ?? "") || undefined,
      action: url.searchParams.get("action"),
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
