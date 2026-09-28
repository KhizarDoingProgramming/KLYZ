import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Same seam as the other server tests: a real database, a mocked model. */
process.env.KLYZ_QUEUE_DRIVER = "memory";

/* One private database for this file: nothing else can see its rows. */
openTestDatabase("klyz_ai_route");

import { POST } from "./route";
import { queryAll, queryOne } from "@/lib/server/db";
import { endTestDatabase, openTestDatabase, createTestAccount } from "@/lib/server/testing";
import { validateWorkflow } from "@/lib/workflow/validation";
import type { Workflow } from "@/lib/workflow/types";

const fetchMock = vi.fn();

function planContent(): string {
  return JSON.stringify({
    title: "Slack digest",
    description: "Post a digest.",
    summary: "Trigger, then post.",
    nodes: [
      { id: "n1", type: "trigger.manual", config: {}, why: "Start." },
      {
        id: "n2",
        type: "action.slack_message",
        config: { operation: "send", channel: "#general", message: "hi" },
        why: "Post.",
      },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2" }],
    sideEffects: [],
  });
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/ai/workflows/generate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/* Session established the same way production does — a real account,
   a real membership and a real session cookie. */
let account = createTestAccount();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("KLYZ_AI_API_KEY", "sk-test");
  vi.stubEnv("KLYZ_AI_MODEL", "openai/test-model");
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content: planContent() } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  account = createTestAccount();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await endTestDatabase();
});

describe("POST /api/ai/workflows/generate", () => {
  it("returns the plan envelope for a workspace member", async () => {
    const response = await POST(
      request({ intent: "Post a digest to Slack" }, account.headers),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "connections",
      "meta",
      "plan",
      "validation",
      "workflow",
    ]);
    const validation = payload.validation as { applyable: boolean; ok: boolean };
    expect(validation.applyable).toBe(true);
    expect(validation.ok).toBe(true);
    expect((payload.workflow as { nodes: unknown[] }).nodes).toHaveLength(2);
  });

  it("refuses a caller with no session", async () => {
    const response = await POST(request({ intent: "Post a digest" }));
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("UNAUTHENTICATED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a workspace the caller does not belong to", async () => {
    const stranger = createTestAccount();
    const response = await POST(
      request(
        { intent: "Post a digest" },
        {
          ...stranger.headers,
          /* Selection hint, never identity: this user is not a member. */
          "x-klyz-workspace": account.workspaceId,
        },
      ),
    );
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("NOT_A_MEMBER");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 with setup guidance when the builder is not configured", async () => {
    vi.stubEnv("KLYZ_AI_API_KEY", "");
    const response = await POST(request({ intent: "Post a digest" }, account.headers));
    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("AI_CONFIGURATION_MISSING");
    expect(payload.error.message).toContain("KLYZ_AI_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty or malformed body before any model call", async () => {
    const empty = await POST(request({ intent: "   " }, account.headers));
    expect(empty.status).toBe(400);

    const malformed = await POST(request("{not json", account.headers));
    expect(malformed.status).toBe(400);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never returns the API key, even in the metadata line", async () => {
    const response = await POST(request({ intent: "Post a digest" }, account.headers));
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("sk-test");
  });

  it("writes nothing — no workflow, version, trigger, run or audit row", async () => {
    const before = workspaceCounts(account.workspaceId);

    const response = await POST(request({ intent: "Post a digest" }, account.headers));
    expect(response.status).toBe(200);

    const after = workspaceCounts(account.workspaceId);
    expect(after.workflows).toBe(before.workflows);
    expect(after.versions).toBe(before.versions);
    expect(after.triggers).toBe(before.triggers);
    expect(after.executions).toBe(before.executions);

    /* An audit line for the request itself is fine — what must never
       appear is any row that makes the plan live. */
    const actions = queryAll<{ action: string }>(
      "SELECT action FROM audit_events WHERE workspace_id = ?",
      account.workspaceId,
    ).map((row) => row.action);
    expect(actions.filter((action) => action.startsWith("workflow."))).toEqual([]);
  });

  it("returns a draft-shaped workflow the editor can save normally", async () => {
    const response = await POST(request({ intent: "Post a digest" }, account.headers));
    const payload = (await response.json()) as {
      workflow: Workflow;
      validation: { ok: boolean };
    };

    const workflow = payload.workflow;
    expect(workflow.status).toBe("draft");
    /* The shape the editor saves, not a row: no persistence columns. */
    expect("publishedVersion" in workflow).toBe(false);
    expect(workflow.id.startsWith("wf_ai")).toBe(true);

    /* Saving it goes through the same validator the editor uses. The
       only tolerated gap is the Slack connection the model cannot
       invent — that is a requirement the user fills in, not a defect. */
    const errors = validateWorkflow(workflow)
      .filter((issue) => issue.severity === "error")
      .filter((issue) => !issue.id.startsWith("missing_"));
    expect(errors).toEqual([]);
    expect(payload.validation.ok).toBe(true);
  });
});

function workspaceCounts(workspaceId: string) {
  return {
    workflows: scalar("SELECT COUNT(*) AS n FROM workflows WHERE workspace_id = ?", workspaceId),
    versions: scalar(
      "SELECT COUNT(*) AS n FROM workflow_versions WHERE workspace_id = ?",
      workspaceId,
    ),
    triggers: scalar(
      "SELECT COUNT(*) AS n FROM workflow_triggers WHERE workspace_id = ?",
      workspaceId,
    ),
    executions: scalar(
      "SELECT COUNT(*) AS n FROM executions WHERE workspace_id = ?",
      workspaceId,
    ),
    audits: scalar("SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ?", workspaceId),
  };
}

function scalar(sql: string, ...params: Array<string | number | null>): number {
  const row = queryOne<{ n: number }>(sql, ...params);
  return row?.n ?? 0;
}
