import { clientIp } from "@/lib/server/auth";
import { webhookRateLimit } from "@/lib/config/env";
import { errorResponse } from "@/lib/server/http";
import { limitByKey } from "@/lib/server/rate-limit";
import { receiveWebhook } from "@/lib/server/webhooks";

export const dynamic = "force-dynamic";

/**
 * Inbound webhook receiver: `/api/webhooks/<slug>` (or the endpoint's
 * published path). Authentication, method and enabled state are checked
 * before anything is queued — an invalid delivery never creates a run.
 */
async function handle(
  request: Request,
  { params }: { params: Promise<{ key: string[] | string }> },
): Promise<Response> {
  try {
    const resolved = await params;
    const segments = Array.isArray(resolved.key) ? resolved.key : [resolved.key];
    /* Public surface: bounded per caller before any lookup or parse. */
    limitByKey("webhook:inbound", clientIp(request) ?? "unknown", webhookRateLimit(), 60_000);
    const delivery = await receiveWebhook(request, segments.join("/"));
    return Response.json(delivery, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
