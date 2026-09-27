import { auditAs } from "@/lib/server/audit";
import { assertCredentialAccess } from "@/lib/server/authz";
import { errorResponse, isRecord, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import {
  deleteCredential,
  getCredential,
  updateCredential,
} from "@/lib/server/credentials";

export const dynamic = "force-dynamic";

/**
 * One credential.
 *
 * The row is fetched with `id AND workspace_id`, so an id from another
 * tenant answers 404 — and the response still carries metadata only.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const { id } = await params;
    assertCredentialAccess(actor, id, "credential:read");
    return Response.json({ credential: getCredential(actor, id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    limitByKey("credential:write", actor.workspaceId, 30, 60_000);
    const { id } = await params;
    /* Permission + workspace ownership in one call. */
    assertCredentialAccess(actor, id, "credential:manage");

    const body = await readJson(request);
    if (!isRecord(body)) {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "A JSON body is required." } },
        { status: 400 },
      );
    }
    const credential = updateCredential(actor, id, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
      ...(isRecord(body.fields)
        ? {
            fields: Object.fromEntries(
              Object.entries(body.fields).map(([key, value]) => [key, String(value ?? "")]),
            ),
          }
        : {}),
    });
    auditAs(actor, "credential.updated", {
      resourceType: "credential",
      resourceId: credential.id,
      metadata: { name: credential.name, kind: credential.kind, rotated: !!body.fields },
    });
    return Response.json({ credential });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    const { id } = await params;
    assertCredentialAccess(actor, id, "credential:manage");
    deleteCredential(actor, id);
    auditAs(actor, "credential.deleted", {
      resourceType: "credential",
      resourceId: id,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
