import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.KLYZ_QUEUE_DRIVER = "memory";

/* Provider HTTP is the seam every integration talks to the outside
   world through (node:http underneath, so global fetch mocking would
   never see these calls). Each test routes the operations it expects
   and fails loudly on anything else. */
const transport = vi.hoisted(() => ({
  calls: [] as Array<{ provider: string; operation: string; url: string; json: unknown }>,
  route: null as null | ((call: unknown) => unknown),
}));

vi.mock("@/lib/integrations/provider/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/provider/http")>();
  return {
    ...actual,
    providerFetch: async <T,>(call: import("@/lib/integrations/provider/http").ProviderCall) => {
      transport.calls.push({
        provider: call.provider,
        operation: call.operation,
        url: call.url,
        json: call.json ?? null,
      });
      if (!transport.route) {
        throw new Error(`unexpected provider call: ${call.provider}:${call.operation} ${call.url}`);
      }
      const data = (await transport.route(call)) as T;
      return {
        status: 200,
        headers: {},
        data,
        text: JSON.stringify(data ?? null),
        durationMs: 1,
        rateLimit: null,
      } satisfies import("@/lib/integrations/provider/http").ProviderResult<T>;
    },
  };
});

/* One private database for this file: nothing else can see its rows. */
openTestDatabase("klyz_cross_provider");

import { defaultActor } from "./identity";
import { queryOne } from "./db";
import { endTestDatabase, openTestDatabase } from "./testing";
import { upsertOAuthCredential } from "./credentials";
import { startWorkflowRun } from "./execution-service";
import type { ExecutionDetail } from "@/lib/execution/types";
import type { Workflow } from "@/lib/workflow/types";
import { ProviderError } from "@/lib/integrations/provider/errors";
import { clearChannelCache } from "@/lib/integrations/slack";

const actor = defaultActor();

afterAll(async () => {
  await endTestDatabase();
});

beforeEach(() => {
  transport.calls = [];
  transport.route = null;
  clearChannelCache();
});

/* ------------------------------------------------------------------ */
/* Connections (one per provider — never shared)                       */
/* ------------------------------------------------------------------ */

function connect(kind: string, name: string, fields: Record<string, string>) {
  return upsertOAuthCredential({
    workspaceId: actor.workspaceId,
    kind,
    name,
    fields,
    account: `${kind}-account`,
    scopes: [],
    expiresAt: null,
  });
}

const github = connect("github", "GitHub", { accessToken: "ghp_test" });
const sheets = connect("google_sheets", "Sheets", { accessToken: "ya29.sheets" });
const gmail = connect("gmail", "Gmail", { accessToken: "ya29.gmail" });
const notion = connect("notion", "Notion", { accessToken: "secret_test" });
const slack = connect("slack", "Slack", { accessToken: "xoxb-test" });

const SPREADSHEET_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
const NOTION_DB_ID = "0123456789abcdef0123456789abcdef";
const NOTION_PAGE_ID = "89abcdef0123456789abcdef01234567";

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

interface StepSpec {
  id: string;
  type: string;
  ref: string;
  config: Record<string, unknown>;
}

function workflow(id: string, steps: StepSpec[]): Workflow {
  return {
    id,
    name: `Cross provider ${id}`,
    description: "",
    status: "draft",
    tags: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastExecutedAt: null,
    executionCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    triggerType: steps[0]?.type ?? "trigger.manual",
    nodeCount: steps.length,
    nodes: steps.map((step, index) => ({
      id: step.id,
      type: step.type,
      position: { x: index * 260, y: 0 },
      data: { ref: step.ref, config: step.config },
    })),
    edges: steps.slice(1).map((step, index) => ({
      id: `e${index}`,
      source: steps[index]?.id ?? "",
      target: step.id,
    })),
  };
}

const ISSUE_SAMPLE = JSON.stringify({
  action: "opened",
  issue: {
    number: 482,
    title: "Export job stuck in queue",
    body: "The nightly export never leaves the queue.",
    user: { login: "dana" },
    labels: [{ name: "bug" }],
    html_url: "https://github.com/klyz/platform/issues/482",
  },
  repository: {
    full_name: "klyz/platform",
    html_url: "https://github.com/klyz/platform",
  },
});

function githubTrigger(config: Record<string, unknown> = {}): StepSpec {
  return {
    id: "trigger",
    type: "trigger.github",
    ref: "github",
    config: {
      credential: github.id,
      repository: "klyz/platform",
      event: "issues",
      sample: ISSUE_SAMPLE,
      ...config,
    },
  };
}

function sheetsAppend(config: Record<string, unknown>): StepSpec {
  return {
    id: "sheets",
    type: "action.sheets_append",
    ref: "sheets",
    config: { credential: sheets.id, spreadsheetId: SPREADSHEET_ID, range: "Leads!A:D", ...config },
  };
}

function slackMessage(config: Record<string, unknown>): StepSpec {
  return {
    id: "slack",
    type: "action.slack_message",
    ref: "slack",
    config: { credential: slack.id, operation: "send", channel: "support", ...config },
  };
}

const GMAIL_MESSAGE = {
  id: "msg_1",
  threadId: "thr_1",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "The invoice is 30 days past due.",
  internalDate: "1758864000000",
  historyId: "99",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Dana Reyes <dana@harborline.com>" },
      { name: "To", value: "support@klyz.dev" },
      { name: "Subject", value: "Invoice past due" },
    ],
    body: { data: Buffer.from("Please chase this invoice before Friday.").toString("base64url") },
  },
};

function gmailTrigger(config: Record<string, unknown> = {}): StepSpec {
  return {
    id: "trigger",
    type: "trigger.gmail",
    ref: "mail",
    config: { credential: gmail.id, label: "INBOX", since: "any", ...config },
  };
}

function notionPage(config: Record<string, unknown>): StepSpec {
  return {
    id: "notion",
    type: "action.notion_page",
    ref: "notion",
    config: {
      credential: notion.id,
      operation: "create",
      parentType: "database",
      parentId: NOTION_DB_ID,
      ...config,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

async function run(definition: Workflow, options?: Record<string, unknown>): Promise<ExecutionDetail> {
  await startWorkflowRun(actor, { definition, source: "manual", options: options ?? {} });

  const row = queryOne<{ id: string }>(
    "SELECT id FROM executions WHERE workflow_id = ? ORDER BY COALESCE(started_at, 0) DESC, created_at DESC, id DESC LIMIT 1",
    definition.id,
  );
  if (!row) throw new Error("no execution was created");

  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = queryOne<{ status: string }>("SELECT status FROM executions WHERE id = ?", row.id);
    if (status && ["completed", "failed", "cancelled"].includes(status.status)) {
      const { getExecutionDetailFor } = await import("./execution-service");
      return getExecutionDetailFor(actor, row.id);
    }
    if (Date.now() > deadline) throw new Error("execution did not settle");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function stepFor(execution: ExecutionDetail, ref: string) {
  const found = execution.steps.find((candidate) => candidate.ref === ref);
  if (!found) throw new Error(`no step with ref "${ref}" in ${execution.steps.map((s) => s.ref).join(", ")}`);
  return found;
}

function route(handlers: Record<string, (call: { json: unknown; url: string }) => unknown>): void {
  transport.route = (raw) => {
    const call = raw as { operation: string; json: unknown; url: string };
    const handler = handlers[call.operation];
    if (!handler) throw new Error(`unexpected provider call: ${call.operation} ${call.url}`);
    return handler(call);
  };
}

function operations(): string[] {
  return transport.calls.map((call) => call.operation);
}

function bodyFor(operation: string): unknown {
  const call = transport.calls.find((candidate) => candidate.operation === operation);
  if (!call) throw new Error(`no call captured for ${operation}`);
  return call.json ?? {};
}

/** Walks a captured request body — `at(body, "properties", "Name", 0)`. */
function at(root: unknown, ...path: Array<string | number>): unknown {
  let cursor = root;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = Array.isArray(cursor)
      ? typeof key === "number"
        ? cursor[key]
        : undefined
      : (cursor as Record<string, unknown>)[String(key)];
  }
  return cursor;
}

const CHANNELS = {
  "conversations.list": () => ({
    channels: [{ id: "C07SUPPORT", name: "support", is_archived: false, is_member: true }],
    response_metadata: { next_cursor: "" },
  }),
};

/* ------------------------------------------------------------------ */
/* Flows                                                               */
/* ------------------------------------------------------------------ */

describe("cross-provider workflows", () => {
  it("carries a GitHub issue into a Google Sheets row", async () => {
    route({
      "values.append": () => ({
        range: "Leads!A214:D",
        majorDimension: "ROWS",
        updates: {
          range: "Leads!A214:D",
          majorDimension: "ROWS",
          updatedRows: 1,
          updatedCells: 2,
          updatedRange: "Leads!A214:D",
        },
      }),
    });

    const definition = workflow("xprov_github_sheets", [
      githubTrigger(),
      sheetsAppend({
        values: [
          { key: "A", value: "{{github.title}}" },
          { key: "B", value: "{{github.issueNumber}}" },
        ],
      }),
    ]);

    const execution = await run(definition);
    expect(execution.status).toBe("completed");
    expect(operations()).toEqual(["values.append"]);

    const appended = bodyFor("values.append");
    expect(at(appended, "range")).toBe("Leads!A:D");
    expect(at(appended, "values")).toEqual([["Export job stuck in queue", "482"]]);

    const row = stepFor(execution, "sheets");
    expect(row.status).toBe("completed");
    expect(row.output).toMatchObject({ rowNumber: 214, updatedRows: 1 });
    expect(row.output?.values).toEqual({ A: "Export job stuck in queue", B: "482" });
  });

  it("posts a GitHub issue into a Slack channel", async () => {
    route({
      ...CHANNELS,
      "chat.postMessage": (call) => {
        const body = call.json as { channel: string };
        expect(body.channel).toBe("C07SUPPORT");
        return { ok: true, channel: body.channel, ts: "1758900000.000100" };
      },
    });

    const definition = workflow("xprov_github_slack", [
      githubTrigger(),
      slackMessage({ message: "New issue {{github.issueNumber}}: {{github.title}}" }),
    ]);

    const execution = await run(definition);
    expect(execution.status).toBe("completed");

    expect(at(bodyFor("chat.postMessage"), "text")).toBe(
      "New issue 482: Export job stuck in queue",
    );

    const posted = stepFor(execution, "slack");
    expect(posted.output).toMatchObject({
      ts: "1758900000.000100",
      channel: "C07SUPPORT",
      channelName: "support",
      operation: "send",
    });
  });

  it("turns a Gmail message into a Notion page", async () => {
    route({
      "messages.list": () => ({ messages: [{ id: "msg_1", threadId: "thr_1" }], resultSizeEstimate: 1 }),
      "messages.get": () => GMAIL_MESSAGE,
      "databases.get": () => ({
        object: "database",
        id: NOTION_DB_ID,
        properties: { Name: { type: "title" } },
      }),
      "pages.create": (call) => {
        const body = call.json as { parent: { database_id: string } };
        expect(body.parent.database_id).toBe(NOTION_DB_ID);
        return {
          object: "page",
          id: NOTION_PAGE_ID,
          url: `https://www.notion.so/${NOTION_PAGE_ID}`,
          created_time: "2026-09-26T09:00:00.000Z",
          last_edited_time: "2026-09-26T09:00:00.000Z",
          properties: { Name: { title: [{ plain_text: "Invoice past due" }] } },
        };
      },
    });

    const definition = workflow("xprov_gmail_notion", [
      gmailTrigger(),
      notionPage({ title: "{{mail.subject}}", content: "{{mail.snippet}}" }),
    ]);

    const execution = await run(definition);
    expect(execution.status).toBe("completed");
    expect(operations()).toEqual(["messages.list", "messages.get", "databases.get", "pages.create"]);

    const created = bodyFor("pages.create");
    expect(at(created, "properties", "Name", "title", 0, "text", "content")).toBe(
      "Invoice past due",
    );

    const mail = stepFor(execution, "mail");
    expect(mail.output).toMatchObject({
      subject: "Invoice past due",
      fromEmail: "dana@harborline.com",
      messageId: "msg_1",
    });

    const page = stepFor(execution, "notion");
    expect(page.output).toMatchObject({ pageId: NOTION_PAGE_ID, title: "Invoice past due", operation: "create" });
  });

  it("chains Gmail into Sheets and reports the row in Slack", async () => {
    route({
      ...CHANNELS,
      "messages.list": () => ({ messages: [{ id: "msg_1", threadId: "thr_1" }], resultSizeEstimate: 1 }),
      "messages.get": () => GMAIL_MESSAGE,
      "values.append": () => ({
        range: "Leads!A88:D",
        updates: { range: "Leads!A88:D", updatedRows: 1, updatedCells: 2, updatedRange: "Leads!A88:D" },
      }),
      "chat.postMessage": () => ({ ok: true, channel: "C07SUPPORT", ts: "1758900000.000300" }),
    });

    const definition = workflow("xprov_gmail_sheets_slack", [
      gmailTrigger(),
      sheetsAppend({
        values: [
          { key: "A", value: "{{mail.subject}}" },
          { key: "B", value: "{{mail.fromEmail}}" },
        ],
      }),
      slackMessage({ message: "Row {{sheets.rowNumber}} logged for {{mail.subject}}" }),
    ]);

    const execution = await run(definition);
    expect(execution.status).toBe("completed");
    expect(operations()).toEqual([
      "messages.list",
      "messages.get",
      "values.append",
      "conversations.list",
      "chat.postMessage",
    ]);

    expect(at(bodyFor("values.append"), "values")).toEqual([
      ["Invoice past due", "dana@harborline.com"],
    ]);
    expect(at(bodyFor("chat.postMessage"), "text")).toBe(
      "Row 88 logged for Invoice past due",
    );

    expect(stepFor(execution, "sheets").output).toMatchObject({ rowNumber: 88, updatedRows: 1 });
    expect(stepFor(execution, "slack").output).toMatchObject({ ts: "1758900000.000300" });
  });

  it("retries a rate-limited Slack step until it lands", async () => {
    let posts = 0;
    route({
      ...CHANNELS,
      "chat.postMessage": () => {
        posts += 1;
        if (posts === 1) {
          throw new ProviderError("slack", "Slack is rate limiting this connection.", {
            operation: "chat.postMessage",
            category: "rate_limit",
            status: 429,
            retryAfterMs: 1,
          });
        }
        return { ok: true, channel: "C07SUPPORT", ts: "1758900000.000400" };
      },
    });

    const definition = workflow("xprov_slack_retry", [
      githubTrigger(),
      slackMessage({ message: "{{github.title}}" }),
    ]);

    const execution = await run(definition, { maxAttempts: 3 });
    expect(execution.status).toBe("completed");
    expect(posts).toBe(2);

    const posted = stepFor(execution, "slack");
    expect(posted.status).toBe("completed");
    expect(posted.attempt).toBe(2);
    expect(posted.output).toMatchObject({ ts: "1758900000.000400" });
  });

  it("fails permanently when a provider rejects a step, without retrying", async () => {
    let posts = 0;
    route({
      ...CHANNELS,
      "chat.postMessage": () => {
        posts += 1;
        throw new ProviderError("slack", "Slack refused an empty message.", {
          operation: "chat.postMessage",
          category: "validation",
          status: 400,
          providerMessage: "no_text",
        });
      },
    });

    const definition = workflow("xprov_slack_reject", [
      githubTrigger(),
      slackMessage({ message: "{{github.title}}" }),
    ]);

    const execution = await run(definition, { maxAttempts: 3 });
    expect(execution.status).toBe("failed");
    expect(posts).toBe(1);

    const posted = stepFor(execution, "slack");
    expect(posted.status).toBe("failed");
    expect(posted.attempt).toBe(1);
    expect(posted.error?.code).toBe("SLACK_VALIDATION");
    expect(posted.error?.message).toMatch(/empty message/i);
  });

  it("refuses to hand one provider's credential to another provider's node", async () => {
    const before = transport.calls.length;
    const definition = workflow("xprov_credential_isolation", [
      githubTrigger(),
      /* A Slack credential wired into a Sheets step — the kind check in
         loadConnection must stop it before any request leaves KLYZ. */
      sheetsAppend({ credential: slack.id, values: [{ key: "A", value: "{{github.title}}" }] }),
    ]);

    const execution = await run(definition);
    expect(execution.status).toBe("failed");
    expect(transport.calls.length).toBe(before);

    const step = stepFor(execution, "sheets");
    expect(step.status).toBe("failed");
    expect(step.error?.code).toBe("GOOGLE_SHEETS_VALIDATION");
    expect(step.error?.message).toBe(
      "That credential is a slack credential, not a google_sheets connection.",
    );
    expect(step.error?.remediation).toBeDefined();
  });
});
