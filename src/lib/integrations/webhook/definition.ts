import type { NodeDefinition } from "@/lib/workflow/types";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Webhook trigger definition.
 *
 * `path`, `method` and `auth` are edited here like any other config and
 * are published to the `webhooks` row; `secret` is submitted from the
 * editor but stripped before storage (see workflow/sanitize.ts) and kept
 * only in the encrypted column.
 */
export const webhookDefinition: NodeDefinition = {
  type: "trigger.webhook",
  category: "trigger",
  title: "Webhook",
  description: "Starts the workflow when an external system calls your endpoint.",
  icon: "webhook",
  summary: "Receives an HTTP request",
  trigger: true,
  cost: 40,
  fields: [
    {
      key: "path",
      label: "Endpoint path",
      kind: "text",
      required: true,
      placeholder: "/hooks/github",
      help: "Must be unique across your endpoints. The copyable URL is on the workflow's endpoint card.",
    },
    {
      key: "method",
      label: "Method",
      kind: "select",
      options: HTTP_METHODS.map((method) => ({ value: method, label: method })),
      required: true,
    },
    {
      key: "auth",
      label: "Authentication",
      kind: "select",
      options: [
        { value: "none", label: "None" },
        { value: "header", label: "Shared secret header" },
        { value: "hmac", label: "HMAC signature" },
      ],
    },
    {
      key: "secret",
      label: "Secret",
      kind: "text",
      placeholder: "whsec_••••••••",
      showWhen: { key: "auth", equals: ["header", "hmac"] },
      help: "Sent as X-Klyz-Webhook-Secret (header mode) or as the HMAC key (hmac mode). Stored encrypted at publish time and never saved in the workflow definition.",
    },
  ],
  outputs: [
    { key: "body", label: "Body", type: "object" },
    { key: "headers", label: "Headers", type: "object" },
    { key: "query", label: "Query", type: "object" },
    { key: "receivedAt", label: "Received at", type: "string" },
  ],
};
