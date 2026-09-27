import { getDefinition } from "@/lib/workflow/registry";

/**
 * What KLYZ ships, stated factually.
 *
 * Two very different things live here and the page keeps them apart on
 * purpose: **providers** need an OAuth handshake and carry real, queryable
 * connection state (see `/api/providers`), while **built-ins** are node
 * families that run with no account at all — a webhook you publish, a
 * database you store a credential for, a parser that never leaves the
 * worker. Nothing in this file claims a connection, a latency or a usage
 * number: those come from the database, never from a constant.
 */

export interface BuiltInIntegration {
  id: string;
  name: string;
  blurb: string;
  icon: string;
  /** Node types this family contributes to the palette. */
  nodeTypes: string[];
}

export const BUILT_IN_INTEGRATIONS: BuiltInIntegration[] = [
  {
    id: "webhook",
    name: "Webhooks",
    blurb:
      "Receive signed HTTP payloads from any service. Publish an endpoint, copy the URL, choose header or HMAC verification.",
    icon: "webhook",
    nodeTypes: ["trigger.webhook"],
  },
  {
    id: "http",
    name: "HTTP",
    blurb:
      "Call any REST API with bearer, basic or custom-header auth, a redacted log line and the existing retry budget.",
    icon: "globe",
    nodeTypes: ["action.http"],
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    blurb:
      "Run parameterised queries and read rows back as step output. The connection string never round-trips to the browser.",
    icon: "postgres",
    nodeTypes: ["action.postgres", "data.postgres"],
  },
  {
    id: "transform",
    name: "Transform",
    blurb:
      "Map, pick and reshape step output before it reaches the next node — no code, no expressions beyond a field path.",
    icon: "braces",
    nodeTypes: ["logic.transform", "logic.operations"],
  },
];

/** Node types that exist because of an OAuth provider. */
export const PROVIDER_NODE_TYPES = new Set([
  "trigger.github",
  "action.github_issue",
  "action.github_comment",
  "trigger.gmail",
  "action.gmail_send",
  "action.gmail_reply",
  "action.gmail_label",
  "action.gmail_get",
  "action.sheets_append",
  "action.sheets_read",
  "action.sheets_write",
  "action.notion_page",
  "action.notion_search",
  "trigger.slack",
  "action.slack_message",
  "action.slack_channel",
]);

/** How many registered nodes a family actually contributes. */
export function builtInNodeCount(entry: BuiltInIntegration): number {
  return entry.nodeTypes.filter((type) => Boolean(getDefinition(type))).length;
}
