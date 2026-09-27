import type { Workflow } from "@/lib/workflow/types";

/**
 * Built-in workflow templates.
 *
 * These are ordinary workflows written down — no special format, no
 * hidden runtime, no fake results. Each one uses only node types that
 * exist in this build, is validated by `validateWorkflow` in the tests,
 * and is converted to the canonical portable form by the same exporter
 * every user export goes through. If a template cannot be exported and
 * re-imported cleanly it is a bug in the exporter, not a licence to
 * special-case the template.
 *
 * Nothing here is a secret: credential fields are empty by design and
 * become *requirements* when somebody uses the template.
 */

export interface SystemTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  definition: Workflow;
}

function definition(input: {
  id: string;
  name: string;
  description: string;
  tags: string[];
  triggerType: string;
  nodes: Workflow["nodes"];
  edges: Workflow["edges"];
}): Workflow {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    status: "draft",
    tags: input.tags,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastExecutedAt: null,
    executionCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    triggerType: input.triggerType,
    nodeCount: input.nodes.length,
    nodes: input.nodes,
    edges: input.edges,
  };
}

function node(
  id: string,
  type: string,
  ref: string,
  config: Record<string, unknown>,
  position: { x: number; y: number },
): Workflow["nodes"][number] {
  return { id, type, position, data: { ref, config } };
}

function edge(
  source: string,
  target: string,
  branch?: string,
): Workflow["edges"][number] {
  return {
    id: `${source}-${target}`,
    source,
    target,
    ...(branch ? { data: { branch } } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* The library                                                         */
/* ------------------------------------------------------------------ */

export const SYSTEM_TEMPLATES: SystemTemplate[] = [
  {
    id: "tpl_sys_webhook_http_slack",
    name: "Webhook → HTTP → Slack",
    description:
      "Accept a signed webhook, call a REST API, and post the result to Slack only when the call succeeded.",
    category: "notifications",
    icon: "webhook",
    definition: definition({
      id: "tpl_sys_webhook_http_slack",
      name: "Webhook → HTTP → Slack",
      description:
        "Accept a signed webhook, call a REST API, and post the result to Slack only when the call succeeded.",
      tags: ["webhook", "http", "slack"],
      triggerType: "trigger.webhook",
      nodes: [
        node(
          "trigger_1",
          "trigger.webhook",
          "webhook",
          { path: "/hooks/inbound", method: "POST", auth: "none" },
          { x: 60, y: 160 },
        ),
        node(
          "http_1",
          "action.http",
          "http",
          {
            method: "POST",
            url: "https://api.example.com/events",
            auth: "none",
            body: '{\n  "title": "{{webhook.body.title}}",\n  "payload": "{{webhook.body}}"\n}',
          },
          { x: 300, y: 160 },
        ),
        node(
          "condition_1",
          "logic.condition",
          "condition",
          { left: "{{http.status}}", operator: "gte", right: "200" },
          { x: 560, y: 160 },
        ),
        node(
          "slack_1",
          "action.slack_message",
          "slack",
          {
            operation: "send",
            channel: "#alerts",
            message: "New event received — upstream returned {{http.status}}.",
          },
          { x: 820, y: 80 },
        ),
      ],
      edges: [edge("trigger_1", "http_1"), edge("http_1", "condition_1"), edge("condition_1", "slack_1", "true")],
    }),
  },
  {
    id: "tpl_sys_github_triage_ai",
    name: "GitHub issue → AI triage → Slack",
    description:
      "Classify every new issue with the AI builder's classifier and route the bugs straight to your team channel.",
    category: "ai",
    icon: "github",
    definition: definition({
      id: "tpl_sys_github_triage_ai",
      name: "GitHub issue → AI triage → Slack",
      description:
        "Classify every new issue with the AI builder's classifier and route the bugs straight to your team channel.",
      tags: ["github", "ai", "slack"],
      triggerType: "trigger.github",
      nodes: [
        node(
          "trigger_1",
          "trigger.github",
          "github",
          { repository: "acme/platform", event: "issues.opened" },
          { x: 60, y: 160 },
        ),
        node(
          "classify_1",
          "ai.classify",
          "classify",
          {
            input: "{{github.title}} — {{github.body}}",
            labels: "bug, feature, question",
            model: "fast",
          },
          { x: 320, y: 160 },
        ),
        node(
          "condition_1",
          "logic.condition",
          "condition",
          { left: "{{classify.label}}", operator: "eq", right: "bug" },
          { x: 580, y: 160 },
        ),
        node(
          "slack_1",
          "action.slack_message",
          "slack",
          {
            operation: "send",
            channel: "#bugs",
            message: "Bug reported in {{github.repository}} #{{github.issueNumber}}: {{github.title}}",
          },
          { x: 840, y: 80 },
        ),
      ],
      edges: [
        edge("trigger_1", "classify_1"),
        edge("classify_1", "condition_1"),
        edge("condition_1", "slack_1", "true"),
      ],
    }),
  },
  {
    id: "tpl_sys_webhook_postgres",
    name: "Webhook → PostgreSQL",
    description:
      "Land an incoming payload in a table with a parameterised insert — the connection string never leaves the credential store.",
    category: "data",
    icon: "postgres",
    definition: definition({
      id: "tpl_sys_webhook_postgres",
      name: "Webhook → PostgreSQL",
      description:
        "Land an incoming payload in a table with a parameterised insert — the connection string never leaves the credential store.",
      tags: ["webhook", "postgres"],
      triggerType: "trigger.webhook",
      nodes: [
        node(
          "trigger_1",
          "trigger.webhook",
          "webhook",
          { path: "/hooks/ingest", method: "POST", auth: "header" },
          { x: 60, y: 160 },
        ),
        node(
          "postgres_1",
          "action.postgres",
          "postgres",
          {
            operation: "insert",
            table: "events",
            values: [
              { id: "kv_payload", key: "payload", value: "{{webhook.body}}" },
              { id: "kv_received", key: "received_at", value: "{{webhook.receivedAt}}" },
            ],
          },
          { x: 340, y: 160 },
        ),
        node(
          "log_1",
          "action.log",
          "log",
          { message: "Stored {{postgres.rowCount}} row(s).", level: "info" },
          { x: 620, y: 160 },
        ),
      ],
      edges: [edge("trigger_1", "postgres_1"), edge("postgres_1", "log_1")],
    }),
  },
  {
    id: "tpl_sys_gmail_sheets_extract",
    name: "Gmail → AI extraction → Google Sheets",
    description:
      "Read the important parts out of a new message and append them as a row — no parsing rules to maintain.",
    category: "ai",
    icon: "mail",
    definition: definition({
      id: "tpl_sys_gmail_sheets_extract",
      name: "Gmail → AI extraction → Google Sheets",
      description:
        "Read the important parts out of a new message and append them as a row — no parsing rules to maintain.",
      tags: ["gmail", "ai", "sheets"],
      triggerType: "trigger.gmail",
      nodes: [
        node(
          "trigger_1",
          "trigger.gmail",
          "gmail",
          { label: "INBOX", since: "cursor" },
          { x: 60, y: 160 },
        ),
        node(
          "extract_1",
          "ai.extract",
          "extract",
          {
            input: "{{gmail.subject}}\n\n{{gmail.body}}",
            schema: [
              { id: "kv_subject", key: "subject", value: "string" },
              { id: "kv_owner", key: "owner", value: "string" },
              { id: "kv_due", key: "dueDate", value: "string" },
            ],
            model: "fast",
          },
          { x: 340, y: 160 },
        ),
        node(
          "sheets_1",
          "action.sheets_append",
          "sheets",
          {
            spreadsheetId: "spreadsheet-id",
            sheet: "Sheet1",
            values: [
              { id: "kv_row_subject", key: "Subject", value: "{{extract.fields.subject}}" },
              { id: "kv_row_owner", key: "Owner", value: "{{extract.fields.owner}}" },
              { id: "kv_row_due", key: "Due", value: "{{extract.fields.dueDate}}" },
            ],
          },
          { x: 640, y: 160 },
        ),
      ],
      edges: [edge("trigger_1", "extract_1"), edge("extract_1", "sheets_1")],
    }),
  },
  {
    id: "tpl_sys_github_notion",
    name: "GitHub issue → Notion task",
    description:
      "Summarise a new issue in one paragraph and file it as a page in your Notion backlog.",
    category: "integrations",
    icon: "github",
    definition: definition({
      id: "tpl_sys_github_notion",
      name: "GitHub issue → Notion task",
      description:
        "Summarise a new issue in one paragraph and file it as a page in your Notion backlog.",
      tags: ["github", "notion", "ai"],
      triggerType: "trigger.github",
      nodes: [
        node(
          "trigger_1",
          "trigger.github",
          "github",
          { repository: "acme/platform", event: "issues.opened" },
          { x: 60, y: 160 },
        ),
        node(
          "summary_1",
          "ai.summarize",
          "summary",
          { input: "{{github.title}}\n\n{{github.body}}", length: "short", model: "fast" },
          { x: 340, y: 160 },
        ),
        node(
          "notion_1",
          "action.notion_page",
          "notion",
          {
            operation: "create",
            parentType: "database",
            parentId: "database-id",
            title: "{{github.title}}",
            content: "{{summary.summary}}",
          },
          { x: 640, y: 160 },
        ),
      ],
      edges: [edge("trigger_1", "summary_1"), edge("summary_1", "notion_1")],
    }),
  },
];
