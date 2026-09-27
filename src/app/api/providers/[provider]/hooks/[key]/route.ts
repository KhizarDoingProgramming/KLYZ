import { clientIp } from "@/lib/server/auth";
import { errorResponse, HttpError } from "@/lib/server/http";
import { limitByKey } from "@/lib/server/rate-limit";
import { DuplicateDelivery, receiveProviderDelivery } from "@/lib/server/provider-webhooks";
import { parseProvider } from "@/lib/server/providers";

export const dynamic = "force-dynamic";

/**
 * Provider delivery receiver: `/api/providers/<provider>/hooks/<key>`.
 *
 * Authentication happens before anything is queued — an unsigned or
 * mis-signed delivery never creates a run. Redeliveries of an already
 * handled `delivery id` answer `200` without starting a second run.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string; key: string }> },
): Promise<Response> {
  try {
    const { provider, key } = await params;
    /* Public surface: bounded per caller before signature verification. */
    limitByKey("webhook:inbound", clientIp(request) ?? "unknown", 300, 60_000);
    const id = parseProvider(provider);
    const result = await receiveProviderDelivery(request, id, Array.isArray(key) ? key.join("/") : key);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    if (error instanceof DuplicateDelivery) {
      return Response.json(
        {
          ok: true,
          duplicate: true,
          executionId: error.executionId || null,
        },
        { status: 200 },
      );
    }
    if (error instanceof HttpError && error.code === "PUSH_AUTH_FAILED") {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: 401 },
      );
    }
    return errorResponse(error);
  }
}
