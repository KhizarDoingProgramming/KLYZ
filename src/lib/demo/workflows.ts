import type { KeyValueEntry } from "@/lib/workflow/types";
import type { Workflow } from "@/lib/workflow/types";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

let kvSeq = 0;
function kv(pairs: Record<string, string>): KeyValueEntry[] {
  kvSeq += 1;
  const base = kvSeq * 100;
  return Object.entries(pairs).map(([key, value], index) => ({
    id: `kv_${base + index}`,
    key,
    value,
  }));
}
function kvList(pairs: Array<[string, string]>): KeyValueEntry[] {
  kvSeq += 1;
  const base = kvSeq * 100;
  return pairs.map(([key, value], index) => ({
    id: `kv_${base + index}`,
    key,
    value,
  }));
}

function node(
  id: string,
  type: string,
  ref: string,
  x: number,
  y: number,
  config: Record<string, unknown>,
  label?: string,
) {
  return { id, type, position: { x, y }, data: { ref, config, label } };
}

function edge(
  id: string,
  source: string,
  target: string,
  branch?: string,
): Workflow["edges"][number] {
  return { id, source, target, data: branch ? { branch } : undefined };
}

/* ------------------------------------------------------------------ */
/* workflow definitions                                                */
/* ------------------------------------------------------------------ */

const githubTriage: Workflow = {
  id: "wf_github_triage",
  name: "GitHub Issue Triage",
  description:
    "Classifies every new issue, then alerts Slack only when the priority is high and files the rest in Notion.",
  status: "active",
  tags: ["engineering", "github"],
  createdAt: ago(60 * 24 * 34),
  updatedAt: ago(46),
  lastExecutedAt: ago(6),
  executionCount: 1284,
  successRate: 99.4,
  avgDurationMs: 2410,
  triggerType: "trigger.github",
  nodeCount: 6,
  nodes: [
    node("n_gh", "trigger.github", "github", 300, 0, {
      repository: "klyz/platform",
      event: "issues.opened",
    }),
    node("n_ai", "ai.extract", "ai", 300, 210, {
      input: "{{github.issue.body}}",
      schema: kvList([
        ["priority", "string"],
        ["category", "string"],
        ["summary", "string"],
      ]),
      model: "fast",
      instructions:
        "Judge severity from user impact, not from tone. Return null when unclear.",
    }),
    node("n_cond", "logic.condition", "check", 300, 450, {
      left: "{{ai.fields.priority}}",
      operator: "eq",
      right: "high",
      caseSensitive: false,
    }),
    node("n_slack", "action.slack_message", "slack", 40, 700, {
      channel: "#support",
      message:
        "*High priority issue* — {{ai.fields.summary}}\n{{github.issue.url}}",
      notify: "here",
    }),
    node("n_notion", "action.notion_page", "notion", 560, 700, {
      mode: "create",
      databaseId: "8f2a91c0d17b4c2ea1b0c4d5e6f7a8b9",
      title: "{{ai.fields.summary}}",
      properties: kv({ Priority: "{{ai.fields.priority}}", Status: "Triage" }),
    }),
    node("n_db", "action.postgres", "db", 300, 950, {
      credential: "",
      operation: "query",
      query:
        "insert into issue_triage (issue_number, priority, category)\nvalues ($1, $2, $3)",
      params: kv({
        "1": "{{github.issue.number}}",
        "2": "{{ai.fields.priority}}",
        "3": "{{ai.fields.category}}",
      }),
      readMode: "none",
    }),
  ],
  edges: [
    edge("e_1", "n_gh", "n_ai"),
    edge("e_2", "n_ai", "n_cond"),
    edge("e_3", "n_cond", "n_slack", "true"),
    edge("e_4", "n_cond", "n_notion", "false"),
    edge("e_5", "n_slack", "n_db"),
    edge("e_6", "n_notion", "n_db"),
  ],
};

const customerIntake: Workflow = {
  id: "wf_customer_intake",
  name: "Customer Intake",
  description:
    "Turns an inbound form submission into a structured lead, routes sales intent to Slack and everyone else to a reply.",
  status: "active",
  tags: ["growth", "webhook"],
  createdAt: ago(60 * 24 * 21),
  updatedAt: ago(3 * 60),
  lastExecutedAt: ago(2),
  executionCount: 4312,
  successRate: 99.8,
  avgDurationMs: 3120,
  triggerType: "trigger.webhook",
  nodeCount: 6,
  nodes: [
    node("n_hook", "trigger.webhook", "webhook", 340, 0, {
      path: "/hooks/intake",
      method: "POST",
      auth: "header",
    }),
    node("n_x", "ai.extract", "ai", 340, 220, {
      input: "{{webhook.body.message}}",
      schema: kvList([
        ["name", "string"],
        ["email", "string"],
        ["intent", "string"],
      ]),
      model: "fast",
      instructions: "Extract only what the visitor actually wrote.",
    }),
    node("n_c", "logic.condition", "check", 340, 470, {
      left: "{{ai.fields.intent}}",
      operator: "eq",
      right: "sales",
      caseSensitive: false,
    }),
    node("n_sl", "action.slack_message", "slack", 60, 730, {
      channel: "#sales",
      message:
        "New lead — *{{ai.fields.name}}* ({{ai.fields.email}})\n{{webhook.body.company}}",
      notify: "none",
    }),
    node("n_gm", "action.gmail_send", "gmail", 620, 730, {
      to: "{{ai.fields.email}}",
      subject: "Thanks for getting in touch",
      body: "Hi {{ai.fields.name}},\n\nThanks — we have your details and someone will reply within a day.",
      replyTo: "team@klyz.dev",
    }),
    node("n_sh", "action.sheets_append", "sheets", 340, 990, {
      spreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
      range: "Leads!A:D",
      values: kv({
        A: "{{ai.fields.name}}",
        B: "{{ai.fields.email}}",
        C: "{{ai.fields.intent}}",
        D: "{{webhook.body.receivedAt}}",
      }),
    }),
  ],
  edges: [
    edge("e_i1", "n_hook", "n_x"),
    edge("e_i2", "n_x", "n_c"),
    edge("e_i3", "n_c", "n_sl", "true"),
    edge("e_i4", "n_c", "n_gm", "false"),
    edge("e_i5", "n_sl", "n_sh"),
    edge("e_i6", "n_gm", "n_sh"),
  ],
};

const supportTriage: Workflow = {
  id: "wf_support_triage",
  name: "Support Email Triage",
  description:
    "Summarises incoming support mail, detects urgency and pushes urgent threads straight to the on-call channel.",
  status: "active",
  tags: ["support"],
  createdAt: ago(60 * 24 * 12),
  updatedAt: ago(26 * 60),
  lastExecutedAt: ago(27),
  executionCount: 892,
  successRate: 97.1,
  avgDurationMs: 4180,
  triggerType: "trigger.gmail",
  nodeCount: 6,
  nodes: [
    node("n_m", "trigger.gmail", "mail", 340, 0, {
      label: "INBOX",
      query: "is:unread",
      markRead: true,
    }),
    node("n_sum", "ai.summarize", "summary", 340, 220, {
      input: "{{mail.body}}",
      length: "short",
      tone: "support engineers",
      model: "smart",
    }),
    node("n_cls", "ai.classify", "classify", 340, 460, {
      input: "{{mail.subject}} {{summary.summary}}",
      labels: "urgent, normal, billing",
      multi: false,
      model: "fast",
    }),
    node("n_p", "logic.condition", "check", 340, 700, {
      left: "{{classify.label}}",
      operator: "eq",
      right: "urgent",
      caseSensitive: false,
    }),
    node("n_s", "action.slack_message", "slack", 60, 950, {
      channel: "#oncall",
      message: "*Urgent* — {{summary.summary}}\nFrom {{mail.from}}",
      notify: "channel",
    }),
    node("n_n", "action.notion_page", "notion", 620, 950, {
      mode: "create",
      databaseId: "3c7e1ab94f2d4a6b8c0d1e2f3a4b5c6d",
      title: "{{summary.summary}}",
      properties: kv({ Owner: "Unassigned", Priority: "{{classify.label}}" }),
    }),
  ],
  edges: [
    edge("e_s1", "n_m", "n_sum"),
    edge("e_s2", "n_sum", "n_cls"),
    edge("e_s3", "n_cls", "n_p"),
    edge("e_s4", "n_p", "n_s", "true"),
    edge("e_s5", "n_p", "n_n", "false"),
  ],
};

const nightlySync: Workflow = {
  id: "wf_nightly_sync",
  name: "Nightly Metrics Sync",
  description:
    "Pulls the product metrics endpoint every night, reshapes the payload and writes it into the warehouse.",
  status: "paused",
  tags: ["data"],
  createdAt: ago(60 * 24 * 60),
  updatedAt: ago(60 * 24 * 3),
  lastExecutedAt: ago(60 * 19),
  executionCount: 61,
  successRate: 93.4,
  avgDurationMs: 1740,
  triggerType: "trigger.schedule",
  nodeCount: 4,
  nodes: [
    node("n_sc", "trigger.schedule", "schedule", 400, 0, {
      every: "cron",
      cron: "0 2 * * *",
      timezone: "UTC",
    }),
    node("n_h", "action.http", "http", 400, 230, {
      method: "GET",
      url: "https://api.klyz.dev/v1/metrics/daily",
      headers: kv({ Accept: "application/json" }),
      auth: "bearer",
      token: "••••••••••••",
      timeout: 10000,
    }),
    node("n_t", "logic.transform", "shape", 400, 500, {
      mapping:
        '{\n  "day": {{schedule.scheduledFor}},\n  "active": {{http.body.active_users}},\n  "runs": {{http.body.executions}}\n}',
    }),
    node("n_pq", "action.postgres", "db", 400, 760, {
      credential: "",
      operation: "query",
      query:
        "insert into daily_metrics (day, active, runs)\nvalues ($1, $2, $3)\non conflict (day) do update set active = $2, runs = $3",
      params: kv({
        "1": "{{shape.value.day}}",
        "2": "{{shape.value.active}}",
        "3": "{{shape.value.runs}}",
      }),
      readMode: "none",
    }),
  ],
  edges: [
    edge("e_n1", "n_sc", "n_h"),
    edge("e_n2", "n_h", "n_t"),
    edge("e_n3", "n_t", "n_pq"),
  ],
};

const releaseNotes: Workflow = {
  id: "wf_release_notes",
  name: "Release Notes Draft",
  description:
    "Reads every commit on main, drafts release notes and posts them for a human to edit before publishing.",
  status: "draft",
  tags: ["engineering"],
  createdAt: ago(60 * 6),
  updatedAt: ago(90),
  lastExecutedAt: null,
  executionCount: 0,
  successRate: 0,
  avgDurationMs: 0,
  triggerType: "trigger.github",
  nodeCount: 4,
  nodes: [
    node("n_p", "trigger.github", "github", 400, 0, {
      repository: "klyz/platform",
      event: "push",
      branch: "main",
    }),
    node("n_l", "logic.loop", "commits", 400, 230, {
      over: "{{github.issue}}",
      mode: "batched",
      batchSize: 25,
      concurrency: 4,
    }),
    node("n_gen", "ai.generate", "draft", 400, 500, {
      prompt:
        "Write release notes for these changes. Group by feature, fix and chore.",
      context: "{{http.body.commits}}",
      model: "smart",
      temperature: 0.3,
    }),
    node("n_sl", "action.slack_message", "slack", 400, 770, {
      channel: "#releases",
      message: "{{draft.text}}",
      notify: "none",
    }),
  ],
  edges: [
    edge("e_r1", "n_p", "n_l"),
    edge("e_r2", "n_l", "n_gen"),
    edge("e_r3", "n_gen", "n_sl"),
  ],
};

const crmSync: Workflow = {
  id: "wf_crm_sync",
  name: "CRM Account Sync",
  description:
    "Pushes new accounts into the CRM on a schedule. Currently disabled after an authentication failure.",
  status: "disabled",
  tags: ["ops"],
  createdAt: ago(60 * 24 * 90),
  updatedAt: ago(60 * 24 * 9),
  lastExecutedAt: ago(60 * 26),
  executionCount: 214,
  successRate: 88.2,
  avgDurationMs: 960,
  triggerType: "trigger.schedule",
  nodeCount: 3,
  nodes: [
    node("n_s", "trigger.schedule", "schedule", 420, 0, {
      every: "1h",
      timezone: "UTC",
    }),
    node("n_h", "action.http", "crm", 420, 230, {
      method: "POST",
      url: "https://api.crm.example.com/v2/accounts/upsert",
      headers: kv({ "Content-Type": "application/json" }),
      auth: "bearer",
      token: "••••••••••••",
      body: '{\n  "external_id": "{{schedule.runKey}}",\n  "plan": "growth"\n}',
      timeout: 8000,
    }),
    node("n_p", "action.postgres", "db", 420, 520, {
      credential: "",
      operation: "query",
      query: "update accounts set synced_at = now() where id = $1",
      params: kv({ "1": "{{crm.body.account_id}}" }),
      readMode: "none",
    }),
  ],
  edges: [
    edge("e_c1", "n_s", "n_h"),
    edge("e_c2", "n_h", "n_p"),
  ],
};

/* ------------------------------------------------------------------ */
/* Runnable integration demos (A / B / C)                              */
/*                                                                     */
/* These three only use node types with real handlers, so they run     */
/* end-to-end once the noted prerequisites are met:                    */
/*   A  needs a stored PostgreSQL credential and a `leads` table        */
/*   B  runs out of the box (public echo API, no credentials)           */
/*   C  needs a stored PostgreSQL credential and a `leads` table        */
/* ------------------------------------------------------------------ */

/** A — webhook → reshape → PostgreSQL insert → log. */
const leadCapture: Workflow = {
  id: "wf_lead_capture",
  name: "Lead Capture",
  description:
    "Receives a lead over a signed-off webhook, reshapes it and writes it into the leads table.",
  status: "draft",
  tags: ["growth", "webhook", "demo"],
  createdAt: ago(60 * 5),
  updatedAt: ago(60 * 5),
  lastExecutedAt: null,
  executionCount: 0,
  successRate: 0,
  avgDurationMs: 0,
  triggerType: "trigger.webhook",
  nodeCount: 4,
  nodes: [
    node("n_hook", "trigger.webhook", "webhook", 340, 0, {
      path: "/hooks/leads",
      method: "POST",
      auth: "none",
    }),
    node("n_shape", "logic.transform", "shape", 340, 230, {
      mapping:
        '{\n  "email": {{webhook.body.email}},\n  "source": {{webhook.body.source}},\n  "received": {{webhook.receivedAt}}\n}',
    }),
    node("n_db", "action.postgres", "db", 340, 480, {
      credential: "",
      operation: "insert",
      table: "public.leads",
      values: kvList([
        ["email", "{{shape.value.email}}"],
        ["source", "{{shape.value.source}}"],
        ["created_at", "{{shape.value.received}}"],
      ]),
      returning: "id",
    }),
    node("n_log", "action.log", "log", 340, 730, {
      message: "Stored lead {{shape.value.email}} from {{shape.value.source}}",
      level: "info",
    }),
  ],
  edges: [
    edge("e_a1", "n_hook", "n_shape"),
    edge("e_a2", "n_shape", "n_db"),
    edge("e_a3", "n_db", "n_log"),
  ],
};

/** B — webhook → HTTP request → reshape → log. No credentials needed. */
const partnerRelay: Workflow = {
  id: "wf_partner_relay",
  name: "Partner Event Relay",
  description:
    "Takes an inbound partner event, forwards it to an HTTP API, reshapes the response and logs the outcome.",
  status: "draft",
  tags: ["platform", "webhook", "demo"],
  createdAt: ago(60 * 4),
  updatedAt: ago(60 * 4),
  lastExecutedAt: null,
  executionCount: 0,
  successRate: 0,
  avgDurationMs: 0,
  triggerType: "trigger.webhook",
  nodeCount: 4,
  nodes: [
    node("n_hook", "trigger.webhook", "webhook", 340, 0, {
      path: "/hooks/partner",
      method: "POST",
      auth: "none",
    }),
    node("n_http", "action.http", "http", 340, 230, {
      method: "POST",
      url: "https://postman-echo.com/post",
      headers: kvList([["Content-Type", "application/json"]]),
      auth: "none",
      body: '{\n  "event": {{webhook.body.event}},\n  "at": "{{webhook.receivedAt}}"\n}',
      timeout: 8000,
    }),
    node("n_reshape", "logic.transform", "reshape", 340, 500, {
      mapping:
        '{\n  "echoed": {{http.body.json.event}},\n  "status": {{http.status}},\n  "ms": {{http.durationMs}}\n}',
    }),
    node("n_log", "action.log", "log", 340, 750, {
      message: "Relayed {{reshape.value.echoed}} — HTTP {{reshape.value.status}} in {{reshape.value.ms}} ms",
      level: "info",
    }),
  ],
  edges: [
    edge("e_b1", "n_hook", "n_http"),
    edge("e_b2", "n_http", "n_reshape"),
    edge("e_b3", "n_reshape", "n_log"),
  ],
};

/** C — manual run → PostgreSQL read → aggregate → log. */
const dailyLeadReport: Workflow = {
  id: "wf_daily_lead_report",
  name: "Daily Lead Report",
  description:
    "Reads the newest leads from PostgreSQL, counts them with a data transform and writes the total to the run log.",
  status: "draft",
  tags: ["data", "demo"],
  createdAt: ago(60 * 3),
  updatedAt: ago(60 * 3),
  lastExecutedAt: null,
  executionCount: 0,
  successRate: 0,
  avgDurationMs: 0,
  triggerType: "trigger.manual",
  nodeCount: 4,
  nodes: [
    node("n_start", "trigger.manual", "manual", 340, 0, {}),
    node("n_read", "data.postgres", "read", 340, 230, {
      credential: "",
      query: "select email, source, created_at from leads order by created_at desc",
      limit: 100,
    }),
    node("n_stats", "logic.operations", "stats", 340, 500, {
      input: "{{read.rows}}",
      operation: "aggregate",
      fn: "count",
      path: "",
    }),
    node("n_log", "action.log", "log", 340, 750, {
      message: "Lead report: {{stats.value}} rows in the pipeline",
      level: "info",
    }),
  ],
  edges: [
    edge("e_c1", "n_start", "n_read"),
    edge("e_c2", "n_read", "n_stats"),
    edge("e_c3", "n_stats", "n_log"),
  ],
};

/* ------------------------------------------------------------------ */
/* Provider workflows — the GitHub + Gmail surface, shown as drafts     */
/* ------------------------------------------------------------------ */

/**
 * GitHub issue created → condition → Gmail send.
 *
 * Both OAuth nodes ship with an empty `credential` on purpose: a
 * connection is picked per workspace and never baked into seed data.
 */
const urgentIssueAlert: Workflow = {
  id: "wf_urgent_issue_alert",
  name: "Urgent Issue Alert",
  description:
    "When an issue is opened in the platform repository, email the on-call address only if the title reads as urgent.",
  status: "draft",
  tags: ["engineering", "github", "gmail"],
  createdAt: ago(60 * 5),
  updatedAt: ago(60 * 5),
  lastExecutedAt: null,
  executionCount: 0,
  successRate: 0,
  avgDurationMs: 0,
  triggerType: "trigger.github",
  nodeCount: 4,
  nodes: [
    node("n_gh", "trigger.github", "github", 360, 0, {
      credential: "",
      repository: "klyz/platform",
      event: "issues.opened",
    }),
    node("n_check", "logic.condition", "check", 360, 260, {
      left: "{{github.title}}",
      operator: "contains",
      right: "urgent",
      caseSensitive: false,
    }),
    node("n_mail", "action.gmail_send", "email", 120, 540, {
      credential: "",
      to: "oncall@klyz.io",
      subject: "{{github.repository}} #{{github.issueNumber}} needs attention",
      body: "{{github.title}}\n\n{{github.body}}\n\n{{github.url}}",
      format: "plain",
    }),
    node("n_log", "action.log", "log", 620, 540, {
      message: "Issue {{github.issueNumber}} triaged as routine",
      level: "info",
    }),
  ],
  edges: [
    edge("e_a1", "n_gh", "n_check"),
    edge("e_a2", "n_check", "n_mail", "true"),
    edge("e_a3", "n_check", "n_log", "false"),
  ],
};

/** Schedule → create a GitHub issue → log the new number. */
const weeklyTrackingIssue: Workflow = {
  id: "wf_weekly_tracking_issue",
  name: "Weekly Tracking Issue",
  description:
    "Opens a tracking issue in the platform repository every weekday morning and records the number it was given.",
  status: "draft",
  tags: ["engineering", "github", "operations"],
  createdAt: ago(60 * 4),
  updatedAt: ago(60 * 4),
  lastExecutedAt: null,
  executionCount: 0,
  successRate: 0,
  avgDurationMs: 0,
  triggerType: "trigger.schedule",
  nodeCount: 3,
  nodes: [
    node("n_sc", "trigger.schedule", "schedule", 360, 0, {
      every: "cron",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
    }),
    node("n_issue", "action.github_issue", "issue", 360, 260, {
      credential: "",
      operation: "create",
      repository: "klyz/platform",
      title: "Weekly ops check — {{schedule.scheduledFor}}",
      body: "Opened automatically by KLYZ on the weekday schedule.",
      labels: "ops, automated",
    }),
    node("n_log", "action.log", "log", 360, 560, {
      message: "Tracking issue {{issue.issue.number}} opened",
      level: "info",
    }),
  ],
  edges: [
    edge("e_b1", "n_sc", "n_issue"),
    edge("e_b2", "n_issue", "n_log"),
  ],
};

/** Push to main → email the commit to the engineering address. */
const pushToInbox: Workflow = {
  id: "wf_push_to_inbox",
  name: "Push to Inbox",
  description:
    "Sends one email per push to main with the commit message and a link back to the change.",
  status: "draft",
  tags: ["engineering", "github", "gmail"],
  createdAt: ago(60 * 2),
  updatedAt: ago(60 * 2),
  lastExecutedAt: null,
  executionCount: 0,
  successRate: 0,
  avgDurationMs: 0,
  triggerType: "trigger.github",
  nodeCount: 2,
  nodes: [
    node("n_gh", "trigger.github", "github", 360, 0, {
      credential: "",
      repository: "klyz/platform",
      event: "push",
      branch: "main",
    }),
    node("n_mail", "action.gmail_send", "email", 360, 260, {
      credential: "",
      to: "eng@klyz.io",
      subject: "{{github.repository}}: {{github.branch}} moved",
      body: "{{github.author}} pushed {{github.commitMessage}}\n\n{{github.commitUrl}}",
      format: "plain",
    }),
  ],
  edges: [edge("e_c1", "n_gh", "n_mail")],
};

export const DEMO_WORKFLOWS: Workflow[] = [
  githubTriage,
  customerIntake,
  supportTriage,
  nightlySync,
  releaseNotes,
  crmSync,
  leadCapture,
  partnerRelay,
  dailyLeadReport,
  urgentIssueAlert,
  weeklyTrackingIssue,
  pushToInbox,
];

export function getWorkflow(id: string): Workflow | undefined {
  return DEMO_WORKFLOWS.find((workflow) => workflow.id === id);
}
