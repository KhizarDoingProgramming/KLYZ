import { auditAs } from "@/lib/server/audit";
import { assertCredentialAccess } from "@/lib/server/authz";
import { errorResponse } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { testCredential } from "@/lib/server/credential-test";

export const dynamic = "force-dynamic";

/**
 * One real call against the stored credential; secrets never round-trip.
 *
 * Requires `credential:use` (member and up) *and* that the credential
 * belongs to the acting workspace — the decryption happens server-side
 * for the duration of this probe and the plaintext is never returned.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const { id } = await params;
    assertCredentialAccess(actor, id, "credential:use");
    limitByKey("credential:test", actor.workspaceId, 20, 60_000);

    const result = await testCredential(actor, id);
    auditAs(actor, "credential.tested", {
      resourceType: "credential",
      resourceId: id,
      metadata: { ok: result.ok === true },
    });
    return Response.json({ result });
  } catch (error) {
    return errorResponse(error);
  }
}
