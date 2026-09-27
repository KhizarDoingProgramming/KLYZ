import type { NodeHandler } from "@/lib/engine/types";

/**
 * Webhook trigger handler.
 *
 * The receiver (`/api/webhooks/...`) does the auth and starts the run;
 * this handler only shapes what the rest of the workflow sees. Manual
 * test runs pass an arbitrary input — anything that is not already a
 * delivery payload is wrapped as the request body so downstream nodes
 * always have a predictable `{{trigger.body}}`.
 */
export const webhookTriggerHandler: NodeHandler = (context) => {
  const input = context.triggerInput;
  const fallbackTime = new Date().toISOString();

  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if ("body" in record || "headers" in record || "query" in record) {
      return {
        output: {
          body: record.body ?? null,
          headers: isRecord(record.headers) ? record.headers : {},
          query: isRecord(record.query) ? record.query : {},
          receivedAt:
            typeof record.receivedAt === "string" ? record.receivedAt : fallbackTime,
        },
      };
    }
  }

  return {
    output: {
      body: input ?? null,
      headers: {},
      query: {},
      receivedAt: fallbackTime,
    },
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
