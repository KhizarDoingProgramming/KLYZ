import { auditAs } from "@/lib/server/audit";
import { requirePermission } from "@/lib/server/authz";
import { errorResponse, isRecord, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { createCredential, listCredentials } from "@/lib/server/credentials";

export const dynamic = "force-dynamic";

/**
 * Stored credentials — list and create.
 *
 * Values are write-only: every response is a `CredentialView` (id,
 * name, kind, timestamps, status), never a secret. Members can read the
 * metadata their workflows need; only admins and owners can create.
 */
export async function GET(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "credential:read");
    return Response.json({ credentials: listCredentials(actor) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "credential:manage");
    limitByKey("credential:write", actor.workspaceId, 30, 60_000);

    const body = await readJson(request);
    if (!isRecord(body)) {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "A JSON body is required." } },
        { status: 400 },
      );
    }
    const credential = createCredential(actor, {
      name: String(body.name ?? ""),
      kind: String(body.kind ?? ""),
      fields: isRecord(body.fields)
        ? Object.fromEntries(
            Object.entries(body.fields).map(([key, value]) => [key, String(value ?? "")]),
          )
        : {},
    });
    /* Metadata only — the fields are never part of the audit payload. */
    auditAs(actor, "credential.created", {
      resourceType: "credential",
      resourceId: credential.id,
      metadata: { name: credential.name, kind: credential.kind },
    });
    return Response.json({ credential }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
