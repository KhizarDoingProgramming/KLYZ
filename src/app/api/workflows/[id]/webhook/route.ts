import { auditAs } from "@/lib/server/audit";
import { assertResourceId, assertWorkflowUsable, requirePermission } from "@/lib/server/authz";
import { errorResponse, isRecord, readJson } from "@/lib/server/http";
import { requireAuthenticatedActor } from "@/lib/server/identity";
import { limitByKey } from "@/lib/server/rate-limit";
import {
  getWebhookFor,
  publishWebhook,
  unpublishWebhook,
  type WebhookAuth,
  type WebhookPublishInput,
} from "@/lib/server/webhooks";
import { getDraftDefinitionFor } from "@/lib/server/workflow-service";

export const dynamic = "force-dynamic";

/**
 * Endpoint publishing for one workflow.
 *
 * GET is a read (`webhook:read`); PUT and DELETE are administrative
 * (`webhook:manage`) because a published endpoint is reachable from the
 * public internet. Every call also proves the workflow id belongs to
 * this workspace before the `webhooks` row is touched, and the stored
 * secret is never echoed back — only `secretSet`.
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
    return Response.json({ webhook: getWebhookFor(actor, id) });
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

    /* The graph comes from the workspace's own draft — the request
       carries endpoint settings (path, method, auth, secret), never a
       definition to publish. */
    const definition = getDraftDefinitionFor(actor, id);
    const body = await readJson(request);
    const config = isRecord(body) && isRecord(body.config) ? body.config : {};
    const webhook = publishWebhook(actor, {
      definition,
      ...toPublishConfig(config),
    } satisfies WebhookPublishInput);
    auditAs(actor, "workflow.published", {
      resourceType: "webhook",
      resourceId: webhook.id,
      metadata: { workflowId: id, path: webhook.path, auth: webhook.auth },
    });
    return Response.json({ webhook }, { status: 200 });
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
    unpublishWebhook(actor, id);
    auditAs(actor, "workflow.unpublished", {
      resourceType: "webhook",
      resourceId: id,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

function toPublishConfig(config: Record<string, unknown>): Partial<WebhookPublishInput> {
  const out: Partial<WebhookPublishInput> = {};
  if (typeof config.path === "string") out.path = config.path;
  if (typeof config.method === "string") out.method = config.method;
  if (typeof config.auth === "string") out.auth = config.auth as WebhookAuth;
  if (typeof config.secret === "string") out.secret = config.secret;
  if (typeof config.enabled === "boolean") out.enabled = config.enabled;
  return out;
}
