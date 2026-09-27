import { auditAs } from "@/lib/server/audit";
import { assertResourceId, assertWorkflowUsable, requirePermission } from "@/lib/server/authz";
import { errorResponse } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import { getDraftDefinitionFor } from "@/lib/server/workflow-service";
import {
  getProviderWebhook,
  publishProviderWebhook,
  unpublishProviderWebhook,
} from "@/lib/server/provider-webhooks";

export const dynamic = "force-dynamic";

/**
 * Provider endpoint publishing for one workflow — the GitHub/Gmail
 * counterpart of `/api/workflows/[id]/webhook`.
 *
 * PUT versions the definition and registers the provider hook; GET
 * returns the copyable endpoint; DELETE removes it (and the remote
 * GitHub hook).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "webhook:read");
    const id = assertResourceId((await params).id, "workflow id");
    assertWorkflowUsable(actor, id);
    return Response.json({ webhook: getProviderWebhook(actor, id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = requireAuthenticatedActor(request);
    requirePermission(actor, "webhook:manage");
    limitByKey("webhook:publish", actor.workspaceId, 30, 60_000);
    const id = assertResourceId((await params).id, "workflow id");
    assertWorkflowUsable(actor, id);
    /* Same rule as the generic endpoint: the graph comes from the
       workspace's own draft, not from the request body. */
    const definition = getDraftDefinitionFor(actor, id);
    const result = await publishProviderWebhook(actor, definition);
    auditAs(actor, "integration.webhook_published", {
      resourceType: "provider_webhook",
      resourceId: result.webhook.id,
      metadata: { workflowId: id },
    });
    return Response.json(
      { webhook: result.webhook, warning: result.warning ?? null },
      { status: 200 },
    );
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
    requirePermission(actor, "webhook:manage");
    const id = assertResourceId((await params).id, "workflow id");
    await unpublishProviderWebhook(actor, id);
    auditAs(actor, "integration.webhook_removed", {
      resourceType: "provider_webhook",
      resourceId: id,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
