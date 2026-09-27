import { auditAs } from "@/lib/server/audit";
import { HttpError, errorResponse, isRecord, readJson } from "@/lib/server/http";
import { requirePermission } from "@/lib/server/authz";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { latestConnectionId, parseProvider } from "@/lib/server/providers";
import { loadConnection } from "@/lib/integrations/provider/connection";
import { ensureWatch, getWatch, stopWatch } from "@/lib/integrations/gmail/watch";
import { googlePubSubTopic } from "@/lib/integrations/provider/config";

export const dynamic = "force-dynamic";

/**
 * Gmail push subscription control.
 *
 * POST re-subscribes the mailbox through `users.watch`; DELETE stops
 * it. Both answer with the row Google actually left behind, so the page
 * shows `watching` only when a live subscription exists.
 */
async function handle(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  try {
    const { provider } = await params;
    const id = parseProvider(provider);
    if (id !== "gmail") {
      throw new HttpError(404, "UNKNOWN_PROVIDER", "Push subscriptions are Gmail-only.");
    }

    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "integration:manage");
    const body = request.method === "POST" ? await readJson(request).catch(() => ({})) : {};
    const credentialId =
      isRecord(body) && typeof body.credentialId === "string" && body.credentialId
        ? body.credentialId
        : latestConnectionId(actor, "gmail");

    if (!credentialId) {
      throw new HttpError(
        422,
        "NO_CONNECTION",
        "Connect a Google account before starting push notifications.",
      );
    }

    const connection = await loadConnection(actor.workspaceId, credentialId, "gmail");
    if (request.method === "DELETE") {
      await stopWatch(connection);
      auditAs(actor, "integration.watch_stopped", {
        resourceType: "credential",
        resourceId: connection.credentialId,
        metadata: { provider: id },
      });
    } else {
      await ensureWatch(connection);
      auditAs(actor, "integration.watch_started", {
        resourceType: "credential",
        resourceId: connection.credentialId,
        metadata: { provider: id },
      });
    }

    return Response.json({
      watch: getWatch(actor.workspaceId, connection.credentialId),
      topic: googlePubSubTopic() || null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = handle;
export const DELETE = handle;
