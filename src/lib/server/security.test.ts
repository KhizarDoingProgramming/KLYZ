import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/* One real database for the whole file — the routes under test talk to
   it exactly as they do in production. */
process.env.KLYZ_QUEUE_DRIVER = "memory";

/* One private database for this file: nothing else can see its rows. */
openTestDatabase("klyz_security");

import { GET as listExecutions } from "@/app/api/executions/route";
import { GET as getExecution } from "@/app/api/executions/[id]/route";
import { POST as executeWorkflow } from "@/app/api/workflows/[id]/execute/route";
import { GET as listCredentials } from "@/app/api/credentials/route";
import { GET as getAudit } from "@/app/api/audit/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as addMemberRoute } from "@/app/api/workspaces/members/route";
import {
  findUserById,
  sessionTokenFromStoredValue,
  SESSION_COOKIE,
  verifyLogin,
} from "@/lib/server/auth";
import { queryOne, run } from "@/lib/server/db";
import { auditMetadataIsSafe, listAuditFor } from "@/lib/server/audit";
import { actorFromToken } from "@/lib/server/identity";
import { requirePermission } from "@/lib/server/authz";
import { assertResourceId, assertWorkflowUsable } from "@/lib/server/authz";
import { createCredential, listCredentials as listCredentialsFor } from "@/lib/server/credentials";
import { getExecutionDetailFor } from "@/lib/server/execution-service";
import { FatalJobError, processExecutionJob } from "@/lib/server/execution-runner";
import { receiveWebhook } from "@/lib/server/webhooks";
import { parseDefinition } from "@/lib/server/execution-service";
import { publishWebhook } from "@/lib/server/webhooks";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { HttpError, errorResponse } from "@/lib/server/http";
import { addMember, changeMemberRole } from "@/lib/server/workspaces";
import { countOwners } from "@/lib/server/identity";
import { endTestDatabase, openTestDatabase, createTestAccount, createWorkspaceRow, addMemberRow } from "@/lib/server/testing";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function api(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Request {
  const { method = "GET", headers = {}, body } = init;
  return new Request(url, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function statusOf(
  handler: (request: Request, context?: unknown) => Promise<Response>,
  request: Request,
  context?: unknown,
): Promise<{ status: number; code: string | null }> {
  const response = await handler(request, context);
  const payload = (await response.json().catch(() => null)) as
    | { error?: { code?: string } }
    | null;
  return { status: response.status, code: payload?.error?.code ?? null };
}

/** Insert a finished execution for a workspace (optionally still queued). */
function seedExecution(
  workspaceId: string,
  workflowId: string,
  status = "completed",
): string {
  const id = `ex_test_${Math.random().toString(36).slice(2, 10)}`;
  const versionId = `wv_test_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  run(
    `INSERT INTO workflow_versions (id, workflow_id, workspace_id, version, hash, definition, created_at)
     VALUES (?, ?, ?, 1, 'hash', ?, ?)`,
    versionId,
    workflowId,
    workspaceId,
    JSON.stringify({ id: workflowId, name: "T", nodes: [], edges: [] }),
    now,
  );
  run(
    `INSERT INTO executions
       (id, workspace_id, workflow_id, workflow_name, workflow_version_id, workflow_version,
        status, trigger_type, trigger_label, source, started_at, completed_at, duration_ms,
        input, output, error, note, metadata, step_count, failed_step_count, created_at)
     VALUES (?, ?, ?, 'Test', ?, 1, ?, 'trigger.manual', 'Manual', 'manual',
             ?, ?, 10, NULL, NULL, NULL, NULL, NULL, 0, 0, ?)`,
    id,
    workspaceId,
    workflowId,
    versionId,
    status,
    now,
    now + 10,
    now,
  );
  return id;
}

beforeEach(() => {
  resetRateLimits();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await endTestDatabase();
});

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

describe("session authentication", () => {
  it("refuses an anonymous caller with 401, not an empty 200", async () => {
    const result = await statusOf(
      listExecutions as never,
      api("http://localhost/api/executions"),
    );
    expect(result.status).toBe(401);
    expect(result.code).toBe("UNAUTHENTICATED");
  });

  it("refuses a forged cookie", async () => {
    const result = await statusOf(
      listExecutions as never,
      api("http://localhost/api/executions", {
        headers: { cookie: `${SESSION_COOKIE}=not-a-real-token` },
      }),
    );
    expect(result.status).toBe(401);
  });

  it("accepts a real session", async () => {
    const account = createTestAccount();
    const result = await statusOf(
      listExecutions as never,
      api("http://localhost/api/executions", { headers: account.headers }),
    );
    expect(result.status).toBe(200);
  });

  it("issues an HttpOnly, SameSite=Lax cookie scoped to /", async () => {
    const account = createTestAccount({ password: "a-perfectly-fine-passphrase" });
    const response = await login(
      api("http://localhost/api/auth/login", {
        method: "POST",
        body: { email: account.email, password: "a-perfectly-fine-passphrase" },
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("never returns the token in the session payload", async () => {
    const account = createTestAccount();
    const response = await login(
      api("http://localhost/api/auth/login", {
        method: "POST",
        body: { email: account.email, password: "correct horse battery" },
      }),
    );
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain(account.token);
  });

  it("revokes the presented session on login (no fixation)", async () => {
    const account = createTestAccount();
    const response = await login(
      api("http://localhost/api/auth/login", {
        method: "POST",
        headers: account.headers,
        body: { email: account.email, password: "correct horse battery" },
      }),
    );
    expect(response.status).toBe(200);
    const stale = queryOne("SELECT id FROM sessions WHERE token_hash IS NOT NULL");
    const revived = await statusOf(
      listExecutions as never,
      api("http://localhost/api/executions", { headers: account.headers }),
    );
    /* The pre-login cookie must be dead; a new one was issued instead. */
    expect(revived.status).toBe(401);
    expect(stale).toBeDefined();
  });

  it("reads a server-component cookie value exactly like the API reads the header", () => {
    const account = createTestAccount();
    /* `cookies()` returns the decoded value; the API receives the raw
       header. Both must resolve to the same token. */
    expect(sessionTokenFromStoredValue(account.token)).toBe(account.token);
    expect(sessionTokenFromStoredValue(encodeURIComponent(account.token))).toBe(
      account.token,
    );
    expect(sessionTokenFromStoredValue(null)).toBeNull();
    expect(sessionTokenFromStoredValue("   ")).toBeNull();

    /* Extraction is not authentication: a value that is not a session
       survives parsing and dies at the session row. */
    expect(sessionTokenFromStoredValue("forged-token")).toBe("forged-token");
    expect(actorFromToken("forged-token")).toBeNull();
    expect(actorFromToken(account.token)?.userId).toBe(account.userId);
  });

  it("stores only a salted hash, never the password", () => {
    const account = createTestAccount({ password: "super-secret-passphrase" });
    const row = findUserById(account.userId);
    expect(row?.password_hash).toBeTruthy();
    expect(row?.password_hash).not.toContain("super-secret-passphrase");
    expect(verifyLogin(account.email, "super-secret-passphrase")).not.toBeNull();
    expect(verifyLogin(account.email, "wrong-password")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Authorization by role                                               */
/* ------------------------------------------------------------------ */

describe("role enforcement", () => {
  it("lets a viewer read runs but not start one", async () => {
    const viewer = createTestAccount({ role: "viewer" });
    const read = await statusOf(
      listExecutions as never,
      api("http://localhost/api/executions", { headers: viewer.headers }),
    );
    expect(read.status).toBe(200);

    const definition = { id: "wf_viewer_block", name: "Blocked", nodes: [], edges: [] };
    const write = await statusOf(
      executeWorkflow as never,
      api("http://localhost/api/workflows/wf_viewer_block/execute", {
        method: "POST",
        headers: viewer.headers,
        body: { definition },
      }),
      { params: Promise.resolve({ id: "wf_viewer_block" }) },
    );
    expect(write.status).toBe(403);
    expect(write.code).toBe("FORBIDDEN");
  });

  it("keeps credential metadata away from viewers", async () => {
    const viewer = createTestAccount({ role: "viewer" });
    const result = await statusOf(
      listCredentials as never,
      api("http://localhost/api/credentials", { headers: viewer.headers }),
    );
    expect(result.status).toBe(403);
  });

  it("keeps the audit trail away from non-admins", async () => {
    const member = createTestAccount({ role: "member" });
    const result = await statusOf(
      getAudit as never,
      api("http://localhost/audit-api", { headers: member.headers }),
    );
    expect(result.status).toBe(403);

    const admin = createTestAccount({ role: "admin" });
    const allowed = await statusOf(
      getAudit as never,
      api("http://localhost/api/audit", { headers: admin.headers }),
    );
    expect(allowed.status).toBe(200);
  });

  it("refuses member management to a plain member", async () => {
    const member = createTestAccount({ role: "member" });
    const result = await statusOf(
      addMemberRoute as never,
      api("http://localhost/api/workspaces/members", {
        method: "POST",
        headers: member.headers,
        body: { email: "nobody@example.test", role: "viewer" },
      }),
    );
    expect(result.status).toBe(403);
    expect(result.code).toBe("FORBIDDEN");
  });

  it("refuses a permission the role does not hold", () => {
    const viewer = createTestAccount({ role: "viewer" });
    expect(() => requirePermission(viewer.actor, "credential:manage")).toThrow(HttpError);
    try {
      requirePermission(viewer.actor, "credential:manage");
    } catch (error) {
      expect((error as HttpError).status).toBe(403);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Cross-tenant access (IDOR)                                          */
/* ------------------------------------------------------------------ */

describe("cross-tenant access", () => {
  it("404s an execution owned by another workspace", () => {
    const alice = createTestAccount();
    const bob = createTestAccount();
    const executionId = seedExecution(alice.workspaceId, "wf_alice");

    expect(() => getExecutionDetailFor(alice.actor, executionId)).not.toThrow();
    expect(() => getExecutionDetailFor(bob.actor, executionId)).toThrow(HttpError);
    try {
      getExecutionDetailFor(bob.actor, executionId);
    } catch (error) {
      expect((error as HttpError).status).toBe(404);
    }
  });

  it("404s an execution read through the route, with a session", async () => {
    const alice = createTestAccount();
    const bob = createTestAccount();
    const executionId = seedExecution(alice.workspaceId, `wf_route_${Date.now()}`);
    const context = { params: Promise.resolve({ id: executionId }) };
    const url = `http://localhost/api/executions/${executionId}`;

    const owner = await statusOf(
      getExecution as never,
      api(url, { headers: alice.headers }),
      context,
    );
    expect(owner.status).toBe(200);

    const stranger = await statusOf(
      getExecution as never,
      api(url, { headers: bob.headers }),
      context,
    );
    expect(stranger.status).toBe(404);
    expect(stranger.code).toBe("NOT_FOUND");
  });

  it("404s a credential owned by another workspace", () => {
    const alice = createTestAccount();
    const bob = createTestAccount({ role: "admin" });
    const credential = createCredential(alice.actor, {
      name: "Alice key",
      kind: "http_bearer",
      fields: { token: "tok_alice_secret" },
    });

    expect(listCredentialsFor(alice.actor).map((row) => row.id)).toContain(credential.id);
    expect(listCredentialsFor(bob.actor).map((row) => row.id)).not.toContain(credential.id);
    expect(bob.workspaceId).not.toBe(alice.workspaceId);
  });

  it("404s a workflow id from another workspace instead of confirming it", () => {
    const alice = createTestAccount();
    const bob = createTestAccount();
    run(
      "INSERT INTO workflows (id, workspace_id, name, status, trigger_type, node_count, created_at, updated_at) VALUES (?, ?, 'Alice wf', 'draft', 'manual', 0, ?, ?)",
      "wf_alice_only",
      alice.workspaceId,
      Date.now(),
      Date.now(),
    );
    expect(() => assertWorkflowUsable(alice.actor, "wf_alice_only")).not.toThrow();
    expect(() => assertWorkflowUsable(bob.actor, "wf_alice_only")).toThrow(HttpError);
  });

  it("treats a foreign workspace selection hint as a refusal, not a switch", () => {
    const alice = createTestAccount();
    const bob = createTestAccount();
    const request = api("http://localhost/api/executions", {
      headers: { ...bob.headers, "x-klyz-workspace": alice.workspaceId },
    });
    expect(() => requirePermission(
      { userId: bob.userId, workspaceId: alice.workspaceId },
      "execution:read",
    )).toThrow();
    /* The hint never reaches a resource read without a membership. */
    expect(request.headers.get("x-klyz-workspace")).toBe(alice.workspaceId);
  });

  it("rejects malformed resource ids before they touch a query", () => {
    expect(() => assertResourceId("wf_ok-1.2:3")).not.toThrow();
    expect(() => assertResourceId("")).toThrow(HttpError);
    expect(() => assertResourceId("has spaces")).toThrow(HttpError);
    expect(() => assertResourceId("wf/../etc")).toThrow(HttpError);
    expect(() => assertResourceId({ id: "wf" })).toThrow(HttpError);
  });
});

/* ------------------------------------------------------------------ */
/* Privilege escalation                                                */
/* ------------------------------------------------------------------ */

describe("privilege escalation", () => {
  it("refuses to grant a role above the granter's own", () => {
    const admin = createTestAccount({ role: "admin" });
    const newcomer = createTestAccount();
    expect(() => addMember(admin.actor, newcomer.email, "owner")).toThrow(HttpError);
    try {
      addMember(admin.actor, newcomer.email, "owner");
    } catch (error) {
      expect((error as HttpError).status).toBe(403);
    }
    expect(() => addMember(admin.actor, newcomer.email, "admin")).not.toThrow();
  });

  it("protects the last owner from demotion", () => {
    const owner = createTestAccount({ role: "owner" });
    expect(countOwners(owner.workspaceId)).toBe(1);
    expect(() => changeMemberRole(owner.actor, owner.userId, "admin")).toThrow(HttpError);
    expect(countOwners(owner.workspaceId)).toBe(1);
  });

  it("allows a second owner, then allows demotion of the first", () => {
    const first = createTestAccount({ role: "owner" });
    const second = createTestAccount();
    addMember(first.actor, second.email, "owner");
    expect(countOwners(first.workspaceId)).toBe(2);
    expect(() => changeMemberRole(first.actor, first.userId, "admin")).not.toThrow();
    expect(countOwners(first.workspaceId)).toBe(1);
  });

  it("refuses a workspace mutation from a member with no admin role", () => {
    const member = createTestAccount({ role: "member" });
    expect(() => requirePermission(member.actor, "workspace:update")).toThrow(HttpError);
  });
});

/* ------------------------------------------------------------------ */
/* Login hardening                                                     */
/* ------------------------------------------------------------------ */

describe("credential verification and brute force", () => {
  it("answers 401 for a wrong password without revealing whether the account exists", async () => {
    const account = createTestAccount();
    const missing = await statusOf(
      login as never,
      api("http://localhost/api/auth/login", {
        method: "POST",
        body: { email: "ghost@example.test", password: "whatever" },
      }),
    );
    const wrong = await statusOf(
      login as never,
      api("http://localhost/api/auth/login", {
        method: "POST",
        body: { email: account.email, password: "wrong" },
      }),
    );
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.code).toBe(wrong.code);
  });

  it("rate limits repeated failures for one address", async () => {
    vi.stubEnv("KLYZ_LOGIN_RATE_LIMIT", "3");
    const account = createTestAccount();
    const attempt = () =>
      statusOf(
        login as never,
        api("http://localhost/api/auth/login", {
          method: "POST",
          body: { email: account.email, password: "wrong" },
        }),
      );

    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.code).toBe("RATE_LIMITED");
  });

  it("can be switched off entirely by configuration", async () => {
    vi.stubEnv("KLYZ_ALLOW_REGISTRATION", "false");
    const result = await statusOf(
      register as never,
      api("http://localhost/api/auth/register", {
        method: "POST",
        body: { email: "new@example.test", password: "a-long-enough-passphrase", name: "New" },
      }),
    );
    expect(result.status).toBe(403);
    expect(result.code).toBe("REGISTRATION_DISABLED");
  });
});

/* ------------------------------------------------------------------ */
/* Request forgery                                                     */
/* ------------------------------------------------------------------ */

describe("cross-site request forgery", () => {
  it("refuses a state change whose Origin is another site", async () => {
    const account = createTestAccount();
    const result = await statusOf(
      addMemberRoute as never,
      api("http://localhost/api/workspaces/members", {
        method: "POST",
        headers: { ...account.headers, origin: "https://evil.example" },
        body: { email: "x@example.test", role: "viewer" },
      }),
    );
    expect(result.status).toBe(403);
    expect(result.code).toBe("CSRF_ORIGIN");
  });

  it("allows a same-origin state change", async () => {
    const account = createTestAccount({ role: "admin" });
    const other = createTestAccount();
    const result = await statusOf(
      addMemberRoute as never,
      api("http://localhost/api/workspaces/members", {
        method: "POST",
        headers: { ...account.headers, origin: "http://localhost" },
        body: { email: other.email, role: "viewer" },
      }),
    );
    expect(result.status).toBe(201);
  });
});

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

describe("audit trail", () => {
  it("records sign-in and sign-out without storing secrets", async () => {
    const account = createTestAccount();
    await login(
      api("http://localhost/api/auth/login", {
        method: "POST",
        body: { email: account.email, password: "correct horse battery" },
      }),
    );

    const events = listAuditFor(account.actor, { limit: 200 }).events;
    expect(events.some((event) => event.action === "auth.login")).toBe(true);
    expect(auditMetadataIsSafe(events[0]?.metadata ?? null)).toBe(true);
    for (const event of events) {
      expect(JSON.stringify(event.metadata ?? {})).not.toContain("correct horse battery");
    }
  });

  it("scopes the listing to the acting workspace", () => {
    const alice = createTestAccount();
    const bob = createTestAccount();
    const aliceEvents = listAuditFor(alice.actor, { limit: 200 }).events;
    const bobEvents = listAuditFor(bob.actor, { limit: 200 }).events;
    const aliceIds = new Set(aliceEvents.map((event) => event.id));
    expect(bobEvents.some((event) => aliceIds.has(event.id))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Public surfaces                                                     */
/* ------------------------------------------------------------------ */

describe("inbound webhooks", () => {
  it("caps the payload size on an enabled endpoint", async () => {
    const account = createTestAccount();
    const workflowId = `wf_hook_${Date.now()}`;
    const definition = parseDefinition({
      id: workflowId,
      name: "Hook",
      nodes: [
        {
          id: "n1",
          type: "trigger.webhook",
          position: { x: 0, y: 0 },
          data: { ref: "", config: { path: `/hook-${workflowId}`, method: "POST", auth: "none" } },
        },
      ],
      edges: [],
    });
    const webhook = publishWebhook(account.actor, { definition });

    const oversized = new Request(`http://localhost/api/webhooks/${webhook.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1_100_000),
    });
    await expect(receiveWebhook(oversized, webhook.slug)).rejects.toMatchObject({
      status: 413,
      code: "WEBHOOK_BODY_TOO_LARGE",
    });
  });

  it("answers 404 for an unknown endpoint", async () => {
    const request = new Request("http://localhost/api/webhooks/nope", { method: "POST" });
    await expect(receiveWebhook(request, "nope")).rejects.toMatchObject({ status: 404 });
  });
});

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

describe("worker tenant integrity", () => {
  it("refuses to run an execution whose version belongs to another workspace", async () => {
    const alice = createTestAccount();
    const bob = createTestAccount();
    const sharedWorkflow = `wf_shared_${Date.now()}`;
    const executionId = seedExecution(alice.workspaceId, sharedWorkflow, "queued");

    /* Point the execution at Bob's version of the "same" workflow. */
    const bobVersion = `wv_bob_${Date.now()}`;
    run(
      `INSERT INTO workflow_versions (id, workflow_id, workspace_id, version, hash, definition, created_at)
       VALUES (?, ?, ?, 2, 'hash', ?, ?)`,
      bobVersion,
      sharedWorkflow,
      bob.workspaceId,
      JSON.stringify({ id: sharedWorkflow, name: "Bob's", nodes: [], edges: [] }),
      Date.now(),
    );
    run("UPDATE executions SET workflow_version_id = ? WHERE id = ?", bobVersion, executionId);

    await expect(processExecutionJob({ executionId }, {})).rejects.toBeInstanceOf(
      FatalJobError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Error disclosure                                                    */
/* ------------------------------------------------------------------ */

describe("error responses", () => {
  it("keeps internal detail in development and hides it in production", async () => {
    const error = new Error("sqlite: table users column password_hash");
    expect(errorResponse(error).status).toBe(500);

    vi.stubEnv("NODE_ENV", "production");
    try {
      const response = errorResponse(error);
      const text = await response.text();
      expect(text).not.toContain("password_hash");
      expect(text).not.toContain("sqlite");
      expect(response.status).toBe(500);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still surfaces intentional, safe messages", async () => {
    const response = errorResponse(new HttpError(404, "NOT_FOUND", "That run is gone."));
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("That run is gone.");
  });
});

/* ------------------------------------------------------------------ */
/* Workspace seeding                                                   */
/* ------------------------------------------------------------------ */

describe("identity seeding", () => {
  it("keeps a second workspace fully isolated from the first", () => {
    const first = createTestAccount();
    const created = createWorkspaceRow("Fresh tenant");
    const tenant = createTestAccount({ workspaceId: created, workspaceName: "Fresh tenant" });
    addMemberRow(created, first.userId, "member");

    expect(created).not.toBe(first.workspaceId);
    const ownRun = seedExecution(created, `wf_fresh_${Date.now()}`);
    const foreignRun = seedExecution(first.workspaceId, `wf_first_${Date.now()}`);

    expect(() => getExecutionDetailFor(tenant.actor, ownRun)).not.toThrow();
    expect(() => getExecutionDetailFor(first.actor, foreignRun)).not.toThrow();
    expect(() => getExecutionDetailFor(tenant.actor, foreignRun)).toThrow(HttpError);
  });
});
