import { getDefinition } from "@/lib/workflow/registry";
import type { OutputField } from "@/lib/workflow/types";
import {
  containsExpression,
  interpolate,
  resolvePath,
  type DataScope,
} from "@/lib/workflow/expressions";

/* ------------------------------------------------------------------ */
/* Deterministic jitter so demo runs feel human but stay stable        */
/* ------------------------------------------------------------------ */

function stableHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function jitter(id: string, base: number, spread = 0.35): number {
  const ratio = (stableHash(id) % 1000) / 1000;
  return Math.max(4, Math.round(base * (1 - spread / 2 + ratio * spread)));
}

/* ------------------------------------------------------------------ */
/* Redaction — credentials never reach an execution log                */
/* ------------------------------------------------------------------ */

const SECRET_KEYS = new Set(["token", "secret", "password", "apikey", "api_key"]);

export function isSecretField(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

function redactValue(key: string, value: unknown): unknown {
  if (isSecretField(key)) return "••••••••";
  if (typeof value === "string" && /^•+$/.test(value)) return "••••••••";
  return value;
}

/* ------------------------------------------------------------------ */
/* Sample trigger payloads — the scope a run starts with               */
/* ------------------------------------------------------------------ */

export function sampleTriggerOutput(
  type: string,
  config: Record<string, unknown>,
): DataScope {
  switch (type) {
    case "trigger.github": {
      const repo = String(config.repository ?? "klyz/platform");
      return {
        event: "issues",
        action: "opened",
        repository: repo,
        repositoryId: 8_412_773,
        issueId: 2_481_006_117,
        issueNumber: 1042,
        title: "Webhook retries drop payloads larger than 64KB",
        body:
          "When a workflow emits a payload over 64KB the retry attempt silently truncates the body.\n\nRepro: set a payload of 90KB, force a timeout, then inspect the retried request.",
        author: "nadia-k",
        authorEmail: null,
        labels: ["bug", "retries"],
        url: `https://github.com/${repo}/issues/1042`,
        createdAt: "2026-09-25T09:14:22.418Z",
        branch: "",
        commitMessage: "",
        commitUrl: "",
        receivedAt: "2026-09-25T09:14:23.004Z",
        raw: { action: "opened", repository: repo },
      };
    }
    case "trigger.webhook":
      return {
        body: {
          name: "Dana Whitfield",
          email: "dana@northwind.io",
          message:
            "We are evaluating KLYZ for our support queue — roughly 400 tickets a day. Can it read from Zendesk?",
          company: "Northwind",
          plan: "growth",
          receivedAt: "2026-09-25T09:14:22.418Z",
        },
        headers: {
          "content-type": "application/json",
          "user-agent": "northwind-site/2.4",
        },
        query: {},
      };
    case "trigger.gmail":
      return sampleGmailMessage();
    case "trigger.slack":
      return {
        channel: "C07SUPPORT1",
        channelName: String(config.channel ?? "#support"),
        userId: "U07NADIA",
        userName: "nadia-k",
        text: "Deploy 4.12 is failing health checks in eu-west — anyone looking at this?",
        ts: `1758${(800_000 + (stableHash(String(config.channel ?? "slack")) % 9_000)).toString()}.004200`,
        threadTs: "",
        teamId: "T07KLYZ",
        botId: "",
        receivedAt: "2026-09-25T09:14:23.004Z",
        raw: {
          type: "event_callback",
          event: { type: "message", channel: "C07SUPPORT1" },
        },
      };
    case "trigger.schedule":
      return {
        scheduledFor: "2026-09-25T02:00:00.000Z",
        runKey: `run_${stableHash(String(config.cron ?? config.every ?? "h")).toString(36)}`,
        previous: { status: "successful", durationMs: 1640 },
      };
    case "trigger.manual":
      return {
        payload: config.sample
          ? safeParse(String(config.sample))
          : { source: "editor", requestedBy: "you" },
      };
    default:
      return { payload: {} };
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** A `keyvalue` field (key/value rows) as the plain object it writes. */
function keyValueObject(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {};
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const { key, value } = entry as { key?: unknown; value?: unknown };
      if (typeof key !== "string" || !key.trim()) continue;
      out[key] = value ?? "";
    }
    return out;
  }
  if (raw && typeof raw === "object") return { ...(raw as Record<string, unknown>) };
  return {};
}

/** Slack ids start with a letter (C…, G…, D…); anything else is a name. */
function looksLikeId(reference: string): boolean {
  return /^[CGD][A-Z0-9]{8,}$/i.test(reference.trim());
}

/** Shape declared by `trigger.gmail` / `action.gmail_get`. */
function sampleGmailMessage(): Record<string, unknown> {
  return {
    messageId: "19a2b4c5d6e7f809",
    threadId: "19a2b4c5d6e7f809",
    subject: "Export job stuck for 3 hours",
    from: "Ops <ops@harborline.com>",
    fromName: "Ops",
    fromEmail: "ops@harborline.com",
    to: "support@klyz.dev",
    cc: "",
    snippet: "our nightly export has been showing processing for three hours…",
    body:
      "Hi — our nightly export has been showing \"processing\" for three hours. This is blocking the Monday report. Can someone take a look?",
    bodyHtml: "",
    labels: ["INBOX", "UNREAD"],
    attachments: [],
    url: "https://mail.google.com/mail/u/0/#all/19a2b4c5d6e7f809",
    receivedAt: "2026-09-25T09:10:07.002Z",
    historyId: "1884210",
    raw: { snippet: "our nightly export has been showing processing for three hours…" },
  };
}

/* ------------------------------------------------------------------ */
/* Sample content used by AI nodes                                     */
/* ------------------------------------------------------------------ */

const SUMMARIES = [
  "Webhook retries truncate bodies over 64KB; payloads are silently shortened on the second attempt.",
  "Customer cannot finish the nightly export — the job stays in \"processing\" and blocks Monday's report.",
  "Sign-up form drops the company field when the postcode is left empty, so leads arrive unqualified.",
  "Search latency spikes above 800ms whenever the index rebuild overlaps with peak traffic.",
];

const DRAFTS = [
  "## Fixes\n- Retry payloads above 64KB are no longer truncated\n- Export jobs now surface a stuck state after 30 minutes\n\n## Chores\n- Bumped the queue consumer to 2.9",
  "## Features\n- Added branch-aware execution logs\n\n## Fixes\n- Condition nodes no longer evaluate skipped inputs\n\n## Chores\n- Reduced worker heartbeat interval to 5s",
];

const FIELD_SAMPLES: Record<string, string> = {
  priority: "high",
  category: "bug",
  name: "Dana Whitfield",
  email: "dana@northwind.io",
  intent: "sales",
  urgency: "urgent",
};

function summarize(text: string, seed: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length < 40) return SUMMARIES[seed % SUMMARIES.length]!;
  const cut = trimmed.slice(0, 140);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 60 ? cut.slice(0, boundary) : cut).trim().replace(/[.,;]$/, "")}.`;
}

/* ------------------------------------------------------------------ */
/* Condition evaluation — the inspector shows *why* a branch was taken */
/* ------------------------------------------------------------------ */

function resolveOperand(value: unknown, scope: DataScope): unknown {
  if (typeof value !== "string") return value;
  if (containsExpression(value)) return interpolate(value, scope).trim();
  return value;
}

function evaluateCondition(
  config: Record<string, unknown>,
  scope: DataScope,
): boolean {
  const left = resolveOperand(config.left, scope);
  const operator = String(config.operator ?? "eq");
  const caseSensitive = Boolean(config.caseSensitive);

  if (operator === "exists") return left !== undefined && left !== null && left !== "";

  const rawRight = config.right;
  const right =
    typeof rawRight === "string" && containsExpression(rawRight)
      ? interpolate(rawRight, scope).trim()
      : rawRight;

  const a = left === undefined || left === null ? "" : String(left);
  const b = right === undefined || right === null ? "" : String(right);
  const A = caseSensitive ? a : a.toLowerCase();
  const B = caseSensitive ? b : b.toLowerCase();

  switch (operator) {
    case "neq":
      return A !== B;
    case "contains":
      return A.includes(B);
    case "gt":
      return Number(a) > Number(b);
    case "lt":
      return Number(a) < Number(b);
    case "matches":
      try {
        return new RegExp(b).test(a);
      } catch {
        return false;
      }
    default:
      return A === B;
  }
}

/* ------------------------------------------------------------------ */
/* Per-node input / output                                             */
/* ------------------------------------------------------------------ */

interface StepIO {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

function defaultOutput(
  nodeId: string,
  nodeType: string,
  config: Record<string, unknown>,
  scope: DataScope,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const seed = stableHash(nodeId);

  switch (nodeType) {
    case "ai.extract": {
      const schema = Array.isArray(config.schema) ? config.schema : [];
      const fields: Record<string, unknown> = {};
      for (const entry of schema) {
        const key = String((entry as { key?: string }).key ?? "");
        if (!key) continue;
        if (key in FIELD_SAMPLES) {
          fields[key] = FIELD_SAMPLES[key];
        } else if (key === "summary") {
          fields[key] = summarize(String(input.input ?? ""), seed);
        } else {
          fields[key] = `sample ${key}`;
        }
      }
      return { fields, tokens: 128 + (seed % 90) };
    }
    case "ai.summarize":
      return {
        summary: summarize(String(input.input ?? input.content ?? ""), seed),
        tokens: 210 + (seed % 160),
      };
    case "ai.classify": {
      const labels = String(config.labels ?? "normal")
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean);
      const label = labels[seed % labels.length] ?? "normal";
      const scores: Record<string, number> = {};
      labels.forEach((name, index) => {
        scores[name] = name === label ? 0.94 : Number((0.08 + index * 0.03).toFixed(2));
      });
      return { label, scores };
    }
    case "ai.generate":
      return { text: DRAFTS[seed % DRAFTS.length], tokens: 340 + (seed % 220) };

    case "action.http": {
      const url = String(config.url ?? "");
      const method = String(config.method ?? "GET");
      return {
        status: 200,
        body: url.includes("crm")
          ? { account_id: "acc_9182", synced: true }
          : url.includes("metrics")
            ? { active_users: 1284, executions: 4831, day: "2026-09-24" }
            : { ok: true, method, path: url.replace(/^https?:\/\/[^/]+/, "") },
        headers: { "content-type": "application/json", "x-request-id": `req_${seed.toString(36)}` },
      };
    }
    case "action.postgres":
      return config.readMode === "none"
        ? { rowCount: 1, rows: [] }
        : { rowCount: 3, rows: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    case "data.postgres":
      return {
        rowCount: 4,
        rows: [
          { id: "acc_9182", plan: "growth" },
          { id: "acc_9183", plan: "starter" },
          { id: "acc_9184", plan: "growth" },
          { id: "acc_9185", plan: "scale" },
        ],
      };
    case "action.gmail_send":
      return {
        id: `msg_${seed.toString(36)}${(seed * 7).toString(36)}`,
        threadId: `thr_${(seed * 13).toString(36)}`,
        status: "sent",
      };
    case "action.gmail_reply":
      return {
        id: `msg_${seed.toString(36)}${(seed * 11).toString(36)}`,
        threadId: `thr_${(seed * 13).toString(36)}`,
        inReplyTo: `<${seed.toString(36)}@mail.gmail.com>`,
        status: "sent",
      };
    case "action.gmail_label":
      return {
        messageId: "19a2b4c5d6e7f809",
        label: String(config.label ?? "Support/Closed"),
        operation: String(config.operation ?? "add") === "remove" ? "remove" : "add",
        labels: ["INBOX", String(config.label ?? "Support/Closed")],
      };
    case "action.gmail_get":
      return sampleGmailMessage();
    case "action.github_issue": {
      const repo = String(config.repository ?? "klyz/platform");
      const operation = String(config.operation ?? "create");
      const issue = {
        id: 2_481_006_117,
        number: 1042,
        title: String(config.title ?? "Webhook retries drop payloads larger than 64KB"),
        body: String(config.body ?? ""),
        state: operation === "update" && config.state === "closed" ? "closed" : "open",
        url: `https://github.com/${repo}/issues/1042`,
        author: "nadia-k",
        labels: String(config.labels ?? "bug,retries")
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
        assignees: [],
        createdAt: "2026-09-25T09:14:22.418Z",
        updatedAt: "2026-09-25T09:31:08.991Z",
        commentCount: operation === "get" ? 4 : 0,
      };
      return { issue, issues: [issue], count: 1, operation };
    }
    case "action.github_comment":
      return {
        comment: {
          id: 9_148_271 + (seed % 900),
          url: `https://github.com/${String(config.repository ?? "klyz/platform")}/issues/1042#issuecomment-${9_148_271 + (seed % 900)}`,
          body: String(config.body ?? ""),
          author: "klyz-bot",
          createdAt: "2026-09-25T09:32:11.207Z",
        },
        issueNumber: Number(config.number) || 1042,
      };
    case "action.slack_message": {
      const channel = String(config.channel ?? "#support");
      const operation = String(config.operation ?? "send") === "reply" ? "reply" : "send";
      return {
        ts: `${1758_000000 + (seed % 90000)}.${(seed % 1000).toString().padStart(3, "0")}`,
        threadTs: operation === "reply" ? String(config.threadTs ?? "{{slack.ts}}") : "",
        channel: looksLikeId(channel) ? channel : "C07SUPPORT1",
        channelName: channel,
        text: String(config.message ?? ""),
        operation,
      };
    }
    case "action.slack_channel": {
      const operation = String(config.operation ?? "find") === "info" ? "info" : "find";
      const ref = String(config.name || config.channel || "engineering");
      const found = ref.trim().length > 0;
      return {
        channel: {
          id: "C07ENG42",
          name: ref.replace(/^#/, ""),
          isPrivate: false,
          isMember: true,
          topic: "Ship it",
          purpose: "Release coordination",
          memberCount: 148,
          archived: false,
        },
        found,
        operation,
      };
    }
    case "action.sheets_append":
      return {
        rowNumber: 214 + (seed % 40),
        updatedRows: 1,
        range: String(config.range ?? "Leads!A:D"),
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${String(config.spreadsheetId ?? "").slice(0, 12)}…`,
        values: keyValueObject(config.values),
      };
    case "action.sheets_read": {
      const operation = String(config.operation ?? "get") === "find" ? "find" : "get";
      const rows = [
        { Name: "Dana Whitfield", Email: "dana@northwind.io", Intent: "sales", Received: "2026-09-25T09:14:22.418Z" },
        { Name: "Marco Reyes", Email: "marco@harborline.com", Intent: "support", Received: "2026-09-25T09:16:04.882Z" },
        { Name: "Priya Raman", Email: "priya@lumenlabs.io", Intent: "sales", Received: "2026-09-25T09:18:51.107Z" },
      ];
      const columns = Object.keys(rows[0]!);
      const matched = operation === "find" ? [rows[0]!] : rows;
      return {
        rows: matched,
        row: matched[0] ?? {},
        rowNumber: 2,
        columns,
        rowCount: matched.length,
        range: String(config.range ?? "Leads!A:D"),
        operation,
      };
    }
    case "action.sheets_write": {
      const operation = String(config.operation ?? "update") === "clear" ? "clear" : "update";
      return {
        updatedCells: 4,
        updatedRows: 1,
        rowNumber: Number(config.row) || 214,
        range: String(config.range ?? "Leads!A:D"),
        values: keyValueObject(config.values),
        operation,
      };
    }
    case "action.notion_page": {
      const operation = String(config.operation ?? config.mode ?? "create");
      const pageId = `${seed.toString(36)}${(seed * 3).toString(36)}`.padEnd(32, "0");
      const title = String(config.title ?? "Untitled");
      return {
        page: {
          id: pageId,
          title,
          url: `https://notion.so/${pageId.slice(0, 8)}`,
          createdAt: "2026-09-25T09:14:22.418Z",
          updatedAt: "2026-09-25T09:14:22.418Z",
          archived: false,
          properties: keyValueObject(config.properties),
          parent: {
            type: String(config.parentType ?? "database"),
            id: String(config.parentId ?? config.databaseId ?? ""),
          },
          raw: {},
        },
        pageId,
        url: `https://notion.so/${pageId.slice(0, 8)}`,
        title,
        operation,
      };
    }
    case "action.notion_search": {
      const query = String(config.query ?? "");
      const results = [
        { id: "8f2a91c0d17b4c2ea1b0c4d5e6f7a8b9", title: "Incident — export job stuck", url: "https://notion.so/8f2a91c0", type: "page", createdAt: "2026-09-25T09:14:22.418Z", updatedAt: "2026-09-25T09:20:11.002Z", archived: false, icon: "🚨" },
        { id: "3c7e1ab94f2d4a6b8c0d1e2f3a4b5c6d", title: "Triage queue", url: "https://notion.so/3c7e1ab9", type: "database", createdAt: "2026-09-20T11:02:00.000Z", updatedAt: "2026-09-24T18:41:09.771Z", archived: false, icon: "🗂️" },
      ];
      return { results, result: results[0]!, count: results.length, query };
    }

    case "logic.condition": {
      const result = evaluateCondition(config, scope);
      return { result, matchedBranch: result ? "true" : "false" };
    }
    case "logic.switch": {
      const value = String(resolveOperand(config.value, scope) ?? "");
      return { matchedCase: value || "fallback" };
    }
    case "logic.filter":
      return { passed: Boolean(resolveOperand(config.expression, scope)) };
    case "logic.loop":
      return { count: 6, results: Array.from({ length: 6 }, (_, i) => ({ i, ok: true })) };
    case "logic.delay":
      return { resumedAt: "2026-09-25T09:15:30.000Z" };
    case "logic.transform": {
      const raw = interpolate(String(config.mapping ?? "{}"), scope);
      const parsed = safeParse(raw);
      return { value: parsed };
    }

    case "data.variables":
      return {
        vars: Object.fromEntries(
          (Array.isArray(config.values) ? config.values : []).map((entry) => {
            const item = entry as { key?: string; value?: string };
            return [item.key ?? "", resolveOperand(item.value ?? "", scope)];
          }),
        ),
      };
    case "data.json":
      return {
        value: config.mode === "stringify"
          ? String(resolveOperand(config.source ?? "", scope))
          : safeParse(String(config.source ?? "{}")),
      };

    default:
      return { ok: true };
  }
}

/** Derives the `INPUT` block the inspector shows for a step. */
function buildStepInput(
  nodeId: string,
  nodeType: string,
  config: Record<string, unknown>,
  scope: DataScope,
): Record<string, unknown> {
  const definition = getDefinition(nodeType);
  if (!definition) return {};

  const input: Record<string, unknown> = {};
  for (const field of definition.fields) {
    const raw = config[field.key];
    if (raw === undefined || raw === null || raw === "") continue;

    if (field.kind === "keyvalue" && Array.isArray(raw)) {
      const resolved: Record<string, unknown> = {};
      for (const entry of raw as Array<{ key?: string; value?: string }>) {
        if (!entry.key) continue;
        resolved[entry.key] = redactValue(
          entry.key,
          resolveOperand(entry.value ?? "", scope),
        );
      }
      if (Object.keys(resolved).length > 0) input[field.key] = resolved;
      continue;
    }

    if (field.kind === "code") {
      const text = String(raw);
      input[field.key] = containsExpression(text)
        ? interpolate(text, scope)
        : text;
      continue;
    }

    if (typeof raw === "string" && containsExpression(raw)) {
      input[field.key] = interpolate(raw, scope);
    } else if (field.bindable || field.required || typeof raw !== "string") {
      input[field.key] = redactValue(field.key, raw);
    }
  }
  return input;
}

export function computeStepIO(
  nodeId: string,
  nodeType: string,
  config: Record<string, unknown>,
  scope: DataScope,
): StepIO {
  const input = buildStepInput(nodeId, nodeType, config, scope);
  const output = defaultOutput(nodeId, nodeType, config, scope, input);
  return { input, output };
}

/* ------------------------------------------------------------------ */
/* Flattens a declared output tree into data-picker paths              */
/* ------------------------------------------------------------------ */

export function outputPaths(fields: OutputField[], prefix = ""): string[] {
  const paths: string[] = [];
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    paths.push(path);
    if (field.children) paths.push(...outputPaths(field.children, path));
  }
  return paths;
}

/** Builds a plausible value for a reference, used by the picker preview. */
export function sampleValueFor(path: string): string {
  const leaf = path.split(".").pop() ?? path;
  if (leaf in FIELD_SAMPLES) return String(FIELD_SAMPLES[leaf]);
  if (["summary", "text", "body", "snippet"].includes(leaf)) return "…";
  if (["url", "spreadsheetUrl"].includes(leaf)) return "https://…";
  if (leaf === "number") return "1042";
  if (leaf === "messageId" || leaf === "threadId") return "19a2b4c5d6e7f809";
  if (leaf === "rowCount" || leaf === "count" || leaf === "tokens") return "128";
  if (leaf === "ts" || leaf === "threadTs") return "1758800000.004200";
  if (leaf === "channelName") return "#support";
  if (leaf === "pageId") return "8f2a91c0d17b4c2ea1b0c4d5e6f7a8b9";
  if (leaf === "rowNumber" || leaf === "updatedRows" || leaf === "updatedCells") return "214";
  if (path.endsWith("at")) return "2026-09-25T09:14:22.418Z";
  if (["rows", "results", "attachments", "labels", "assignees"].includes(leaf)) return "[…]";
  if (["fields", "vars", "scores", "headers", "query", "raw", "issue", "comment"].includes(leaf))
    return "{…}";
  if (leaf === "result" || leaf === "passed" || leaf === "success") return "true";
  if (leaf === "status") return "200";
  if (leaf === "label" || leaf === "priority" || leaf === "category") return "high";
  return "…";
}

export { resolvePath };
