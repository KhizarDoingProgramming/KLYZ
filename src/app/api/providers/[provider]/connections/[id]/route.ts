import { auditAs } from "@/lib/server/audit";
import { errorResponse } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { disconnectConnection, parseProvider } from "@/lib/server/providers";

export const dynamic = "force-dynamic";

/**
 * Disconnect an account.
 *
 * Marks the connection unusable locally and best-effort revokes the
 * token at the provider. The credential row stays so workflows that
 * reference it fail with an actionable "reconnect" instead of a silent
 * missing-reference error.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ provider: string; id: string }> },
) {
  try {
    const { provider, id } = await params;
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "integration:manage");
    const providerId = parseProvider(provider);
    const credential = await disconnectConnection(actor, providerId, id);
    auditAs(actor, "integration.disconnected", {
      resourceType: "credential",
      resourceId: credential.id,
      metadata: { provider: providerId },
    });
    return Response.json({ credential });
  } catch (error) {
    return errorResponse(error);
  }
}
