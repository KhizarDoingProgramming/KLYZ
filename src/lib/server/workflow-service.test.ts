import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* One real database for the whole file — the routes under test talk to
   it exactly as they do in production. */
const tmpDir = mkdtempSync(join(tmpdir(), "klyz-workflows-"));
process.env.KLYZ_DB_PATH = join(tmpDir, "klyz.db");
process.env.KLYZ_QUEUE_DRIVER = "memory";

import {
  GET as listWorkflowsRoute,
  POST as createWorkflowRoute,
} from "@/app/api/workflows/route";
import {
  DELETE as archiveWorkflowRoute,
  GET as getWorkflowRoute,
  PATCH as patchWorkflowRoute,
} from "@/app/api/workflows/[id]/route";
import { PUT as saveDraftRoute } from "@/app/api/workflows/[id]/draft/route";
import { POST as publishRoute } from "@/app/api/workflows/[id]/publish/route";
import {
  GET as listVersionsRoute,
  POST as restoreVersionRoute,
} from "@/app/api/workflows/[id]/versions/route";
import { POST as executeRoute } from "@/app/api/workflows/[id]/execute/route";
import { SCHEMA_VERSION, queryAll, queryOne, run } from "@/lib/server/db";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { HttpError } from "@/lib/server/http";
import { createTestAccount, type TestAccount } from "@/lib/server/testing";
import {
  archiveWorkflowFor,
  createWorkflowFor,
  duplicateWorkflowFor,
  getWorkflowFor,
  listVersionsFor,
  publishWorkflowFor,
  restoreVersionFor,
  runWorkflowFor,
  saveDraftFor,
} from "@/lib/server/workflow-service";
import type { Workflow } from "@/lib/workflow/types";

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
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** The smallest graph the registry and the validator both accept. */
function runnable(id: string, message = "hello"): Workflow {
  return {
    id,
    name: "Test workflow",
    description: "",
    status: "draft",
    tags: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastExecutedAt: null,
    executionCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    triggerType: "trigger.manual",
    nodeCount: 2,
    nodes: [
      {
        id: "n_start",
        type: "trigger.manual",
        position: { x: 0, y: 0 },
        data: { ref: "", config: {} },
      },
      {
        id: "n_log",
        type: "action.log",
        position: { x: 260, y: 0 },
        data: { ref: "", config: { message, level: "info" } },
      },
    ],
    edges: [{ id: "e1", source: "n_start", target: "n_log" }],
  };
}

/** The `action.log` node of a graph built by `runnable()`. */
function logNode(workflow: Workflow): NonNullable<Workflow["nodes"][number]> {
  const node = workflow.nodes[1];
  if (!node) throw new Error("runnable() must produce two nodes");
  return node;
}

function statusOf(response: Response): Promise<{ status: number; code: string | null }> {
  return json(response).then((payload) => {
    const error = payload.error as { code?: string } | undefined;
    return { status: response.status, code: error?.code ?? null };
  });
}

function versionsOf(workflowId: string): Array<Record<string, unknown>> {
  return queryAll(
    "SELECT id, version, hash, definition, created_at, created_by FROM workflow_versions WHERE workflow_id = ? ORDER BY version",
    workflowId,
  );
}

function expectHttp(fn: () => unknown, status: number): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "expected the call to throw").toBeInstanceOf(HttpError);
  expect((thrown as HttpError).status).toBe(status);
}

beforeEach(() => {
  resetRateLimits();
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Drafts                                                              */
/* ------------------------------------------------------------------ */

describe("server-owned drafts", () => {
  it("creates a workflow as an unpublished draft", () => {
    const account = createTestAccount();
    const workflow = createWorkflowFor(account.actor, {
      id: "wf_draft_new",
      name: "First draft",
    });

    expect(workflow.id).toBe("wf_draft_new");
    expect(workflow.name).toBe("First draft");
    expect(workflow.revision).toBe(1);
    expect(workflow.publishedVersionId).toBeNull();
    expect(workflow.publishedVersion).toBe(0);
    expect(workflow.hasUnpublishedChanges).toBe(true);
    expect(workflow.nodes).toHaveLength(1);
    expect(versionsOf(workflow.id)).toHaveLength(0);
  });

  it("stores the graph the editor saves and hands back a new revision", () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_draft_edit" });

    const saved = saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id),
      revision: created.revision,
    });

    expect(saved.revision).toBe(created.revision + 1);
    expect(saved.nodeCount).toBe(2);
    expect(saved.triggerType).toBe("trigger.manual");
    expect(saved.hasUnpublishedChanges).toBe(true);
  });

  it("refuses a stale revision instead of overwriting newer work", () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_draft_race" });
    const stale = created.revision;

    saveDraftFor(account.actor, created.id, {
      definition: { ...runnable(created.id), name: "Newer" },
      revision: stale,
    });

    let payload: Record<string, unknown> | undefined;
    try {
      saveDraftFor(account.actor, created.id, {
        definition: { ...runnable(created.id), name: "Older" },
        revision: stale,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(409);
      expect((error as HttpError).code).toBe("REVISION_CONFLICT");
      payload = (error as HttpError).details as Record<string, unknown>;
    }

    expect(payload).toBeDefined();
    const server = payload?.workflow as { name: string; revision: number };
    expect(server.name).toBe("Newer");
    expect(server.revision).toBe(stale + 1);
    expect(getWorkflowFor(account.actor, created.id).name).toBe("Newer");
  });

  it("will not accept a definition for a different workflow id", () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_draft_mismatch" });

    expectHttp(
      () =>
        saveDraftFor(account.actor, created.id, {
          definition: runnable("wf_someone_else"),
          revision: created.revision,
        }),
      400,
    );
  });

  it("refuses raw credential values in a draft", () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, {
      id: "wf_draft_secret",
      definition: runnable("wf_draft_secret"),
    });
    const definition = runnable(created.id);
    logNode(definition).data.config.token = "ghp_live_not_a_reference";

    let code: string | undefined;
    try {
      saveDraftFor(account.actor, created.id, { definition, revision: created.revision });
    } catch (error) {
      expect((error as HttpError).status).toBe(422);
      code = (error as HttpError).code;
    }
    expect(code).toBe("CREDENTIAL_VALUE_IN_DEFINITION");
    /* The value never reached the row. */
    expect(logNode(getWorkflowFor(account.actor, created.id)).data.config.token).toBeUndefined();
  });

  it("keeps a masked placeholder and a credential reference", () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_draft_ref" });
    const definition = runnable(created.id);
    logNode(definition).data.config.token = "••••••••••••";
    logNode(definition).data.config.credential = "cred_abc";

    const saved = saveDraftFor(account.actor, created.id, {
      definition,
      revision: created.revision,
    });
    expect(saved.revision).toBe(created.revision + 1);
  });
});

/* ------------------------------------------------------------------ */
/* Published versions                                                  */
/* ------------------------------------------------------------------ */

describe("published versions", () => {
  it("mints an immutable version and points the workflow at it", () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_pub_1" });
    saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id),
      revision: created.revision,
    });

    const { workflow, version } = publishWorkflowFor(account.actor, created.id);

    expect(version.version).toBe(1);
    expect(version.isPublished).toBe(true);
    expect(workflow.publishedVersionId).toBe(version.id);
    expect(workflow.publishedVersion).toBe(1);
    expect(workflow.hasUnpublishedChanges).toBe(false);

    const row = versionsOf(created.id);
    expect(row).toHaveLength(1);
    expect(row[0]!.created_by).toBe(account.userId);
  });

  it("reuses the same version while the graph has not changed", () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_pub_idem" });
    saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id),
      revision: created.revision,
    });

    const first = publishWorkflowFor(account.actor, created.id);
    const second = publishWorkflowFor(account.actor, created.id);

    expect(second.version.id).toBe(first.version.id);
    expect(versionsOf(created.id)).toHaveLength(1);
  });

  it("never rewrites an older version when a newer one is published", () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_pub_immutable" });
    saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id, "first"),
      revision: created.revision,
    });
    publishWorkflowFor(account.actor, created.id);

    const before = versionsOf(created.id);
    expect(before).toHaveLength(1);

    const current = getWorkflowFor(account.actor, created.id);
    saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id, "second"),
      revision: current.revision,
    });
    publishWorkflowFor(account.actor, created.id);

    const after = versionsOf(created.id);
    expect(after).toHaveLength(2);
    /* The first row is byte-for-byte what it was: definition, hash and
       timestamp all survive the second publish untouched. */
    expect(after[0]).toEqual(before[0]);
    expect(String(after[0]!.definition)).toContain("first");
    expect(String(after[1]!.definition)).toContain("second");
  });

  it("restores an old version into the draft without moving the pointer", () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_pub_restore" });
    saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id, "one"),
      revision: created.revision,
    });
    const first = publishWorkflowFor(account.actor, created.id);

    const current = getWorkflowFor(account.actor, created.id);
    saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id, "two"),
      revision: current.revision,
    });
    publishWorkflowFor(account.actor, created.id);
    const published = getWorkflowFor(account.actor, created.id);

    const restored = restoreVersionFor(account.actor, created.id, first.version.id);
    expect(restored.publishedVersionId).toBe(published.publishedVersionId);
    expect(restored.publishedVersion).toBe(published.publishedVersion);
    expect(restored.hasUnpublishedChanges).toBe(true);

    const draftNode = logNode(restored);
    expect(draftNode.data.config.message).toBe("one");
    /* Nothing was published by restoring. */
    expect(versionsOf(created.id)).toHaveLength(2);
  });

  it("refuses to publish a graph the validator rejects", () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_pub_invalid" });
    /* A step that is not connected to anything cannot be ordered. */
    const orphaned = runnable(created.id);
    orphaned.edges = [];
    saveDraftFor(account.actor, created.id, {
      definition: orphaned,
      revision: created.revision,
    });

    expectHttp(() => publishWorkflowFor(account.actor, created.id), 422);
    expect(versionsOf(created.id)).toHaveLength(0);
    expect(getWorkflowFor(account.actor, created.id).publishedVersionId).toBeNull();
  });

  it("refuses a credential value at publish time even when it is already stored", async () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, {
      id: "wf_pub_secret",
      definition: runnable("wf_pub_secret"),
    });
    /* Simulate a draft written by an older build that did not have the
       check — publish and run must both refuse it. */
    const poisoned = runnable(created.id);
    logNode(poisoned).data.config.password = "hunter2hunter2";
    run("UPDATE workflows SET draft = ? WHERE id = ?", JSON.stringify(poisoned), created.id);

    let code: string | undefined;
    try {
      publishWorkflowFor(account.actor, created.id);
    } catch (error) {
      code = (error as HttpError).code;
    }
    expect(code).toBe("CREDENTIAL_VALUE_IN_DEFINITION");
    expect(versionsOf(created.id)).toHaveLength(0);
    await expect(runWorkflowFor(account.actor, created.id, {})).rejects.toMatchObject({
      code: "CREDENTIAL_VALUE_IN_DEFINITION",
    });
  });

  it("has no UPDATE path to a workflow version", () => {
    /* The invariant is enforced by construction, so assert it against
       the sources the server actually loads. */
    const roots = [join(process.cwd(), "src/lib/server"), join(process.cwd(), "src/app/api")];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        if (/update\s+workflow_versions/i.test(text)) offenders.push(full);
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Executions pin a version                                            */
/* ------------------------------------------------------------------ */

describe("executions reference versions", () => {
  it("runs the published version and records its id on the execution", async () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_run_pin" });
    const draft = saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id),
      revision: created.revision,
    });
    expect(draft.publishedVersionId).toBeNull();
    const published = publishWorkflowFor(account.actor, created.id);

    const execution = await runWorkflowFor(account.actor, created.id, { input: { a: 1 } });

    expect(execution.workflowVersionId).toBe(published.version.id);
    expect(execution.workflowVersion).toBe(1);

    const row = queryOne<{ workflow_version_id: string }>(
      "SELECT workflow_version_id FROM executions WHERE id = ?",
      execution.id,
    );
    expect(row?.workflow_version_id).toBe(published.version.id);
    expect(getWorkflowFor(account.actor, created.id).publishedVersionId).toBe(
      published.version.id,
    );
    expect(getWorkflowFor(account.actor, created.id).hasUnpublishedChanges).toBe(false);
  });

  it("publishes an edited draft on the first run, then reuses that version", async () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_run_implicit" });
    saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id),
      revision: created.revision,
    });

    const first = await runWorkflowFor(account.actor, created.id, {});
    const second = await runWorkflowFor(account.actor, created.id, {});

    expect(first.workflowVersionId).toBe(second.workflowVersionId);
    expect(versionsOf(created.id)).toHaveLength(1);
    expect(getWorkflowFor(account.actor, created.id).hasUnpublishedChanges).toBe(false);
  });

  it("ignores a definition smuggled into the run request", async () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_run_ignore" });
    saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id, "the real graph"),
      revision: created.revision,
    });
    const published = publishWorkflowFor(account.actor, created.id);

    const response = await executeRoute(
      api(`http://localhost/api/workflows/${created.id}/execute`, {
        method: "POST",
        headers: account.headers,
        body: {
          definition: {
            ...runnable(created.id, "pwned graph"),
            nodes: [
              ...runnable(created.id, "pwned graph").nodes,
              { id: "n_x", type: "action.log", position: { x: 0, y: 400 }, data: { ref: "", config: { message: "pwned" } } },
            ],
          },
          input: { hello: "world" },
        },
      }),
      context(created.id),
    );
    expect(response.status).toBe(201);

    const payload = await json(response);
    const execution = payload.execution as { id: string; workflowVersionId?: string };
    expect(execution.workflowVersionId).toBe(published.version.id);

    const definition = versionsOf(created.id)[0]!.definition as string;
    expect(definition).toContain("the real graph");
    expect(definition).not.toContain("pwned");
  });

  it("keeps a client definition from reaching the queue at all", async () => {
    const account = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_run_body" });
    saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id),
      revision: created.revision,
    });

    const response = await executeRoute(
      api(`http://localhost/api/workflows/${created.id}/execute`, {
        method: "POST",
        headers: account.headers,
        body: { definition: { id: created.id, name: "X", nodes: [], edges: [] } },
      }),
      context(created.id),
    );
    /* An empty graph would fail validation if it were believed. */
    expect(response.status).toBe(201);
    expect((await json(response)).execution).toBeTruthy();
  });

  it("refuses to run a workflow that has never been saved", async () => {
    const account = createTestAccount();
    const response = await executeRoute(
      api("http://localhost/api/workflows/wf_never_exists/execute", {
        method: "POST",
        headers: account.headers,
        body: {},
      }),
      context("wf_never_exists"),
    );
    expect(response.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

describe("workflow permissions", () => {
  it("lets a viewer read but not author, publish or run", async () => {
    const owner = createTestAccount();
    const viewerAccount = createTestAccount({
      role: "viewer",
      workspaceId: owner.workspaceId,
    });
    const created = createWorkflowFor(owner.actor, { id: "wf_perm_view" });
    saveDraftFor(owner.actor, created.id, {
      definition: runnable(created.id),
      revision: created.revision,
    });

    expect(getWorkflowFor(viewerAccount.actor, created.id).id).toBe(created.id);
    expectHttp(() => createWorkflowFor(viewerAccount.actor, { name: "nope" }), 403);
    expectHttp(
      () =>
        saveDraftFor(viewerAccount.actor, created.id, {
          definition: runnable(created.id),
          revision: 1,
        }),
      403,
    );
    expectHttp(() => publishWorkflowFor(viewerAccount.actor, created.id), 403);
    expectHttp(() => archiveWorkflowFor(viewerAccount.actor, created.id), 403);
    await expect(
      runWorkflowFor(viewerAccount.actor, created.id, {}),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets a member publish and only an admin archive", () => {
    const owner = createTestAccount();
    const member = createTestAccount({ role: "member", workspaceId: owner.workspaceId });
    const admin = createTestAccount({ role: "admin", workspaceId: owner.workspaceId });
    const created = createWorkflowFor(member.actor, { id: "wf_perm_admin" });
    saveDraftFor(member.actor, created.id, {
      definition: runnable(created.id),
      revision: created.revision,
    });

    expect(publishWorkflowFor(member.actor, created.id).version.version).toBe(1);
    expectHttp(() => archiveWorkflowFor(member.actor, created.id), 403);
    expect(() => archiveWorkflowFor(admin.actor, created.id)).not.toThrow();
    expectHttp(() => getWorkflowFor(admin.actor, created.id), 404);
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation                                                    */
/* ------------------------------------------------------------------ */

describe("tenant isolation", () => {
  it("hides another workspace's workflow behind 404 on every path", async () => {
    const alice = createTestAccount();
    const bob = createTestAccount();
    const created = createWorkflowFor(alice.actor, { id: "wf_tenant_only" });
    saveDraftFor(alice.actor, created.id, {
      definition: runnable(created.id),
      revision: created.revision,
    });

    expect(() => getWorkflowFor(bob.actor, created.id)).toThrow(HttpError);
    expectHttp(() => getWorkflowFor(bob.actor, created.id), 404);
    expectHttp(
      () =>
        saveDraftFor(bob.actor, created.id, {
          definition: runnable(created.id),
          revision: 1,
        }),
      404,
    );
    expectHttp(() => publishWorkflowFor(bob.actor, created.id), 404);
    expectHttp(() => archiveWorkflowFor(bob.actor, created.id), 404);
    expectHttp(() => restoreVersionFor(bob.actor, created.id, "wfv_x"), 404);
    await expect(runWorkflowFor(bob.actor, created.id, {})).rejects.toMatchObject({
      status: 404,
    });

    /* The list never shows it either. */
    const list = await listWorkflowsRoute(
      api("http://localhost/api/workflows", { headers: bob.headers }),
    );
    expect(list.status).toBe(200);
    const payload = await json(list);
    const ids = (payload.workflows as Array<{ id: string }>).map((row) => row.id);
    expect(ids).not.toContain(created.id);
  });

  it("answers 404 through the routes, with a session", async () => {
    const alice = createTestAccount();
    const bob = createTestAccount();
    const created = createWorkflowFor(alice.actor, { id: "wf_tenant_route" });
    const id = created.id;

    const routes: Array<[string, () => Promise<Response>]> = [
      ["get", () => getWorkflowRoute(api(`http://localhost/api/workflows/${id}`, { headers: bob.headers }), context(id))],
      ["patch", () => patchWorkflowRoute(api(`http://localhost/api/workflows/${id}`, { method: "PATCH", headers: bob.headers, body: { name: "stolen" } }), context(id))],
      ["draft", () => saveDraftRoute(api(`http://localhost/api/workflows/${id}/draft`, { method: "PUT", headers: bob.headers, body: { definition: runnable(id), revision: 1 } }), context(id))],
      ["publish", () => publishRoute(api(`http://localhost/api/workflows/${id}/publish`, { method: "POST", headers: bob.headers }), context(id))],
      ["versions", () => listVersionsRoute(api(`http://localhost/api/workflows/${id}/versions`, { headers: bob.headers }), context(id))],
      ["restore", () => restoreVersionRoute(api(`http://localhost/api/workflows/${id}/versions`, { method: "POST", headers: bob.headers, body: { versionId: "wfv_x" } }), context(id))],
      ["execute", () => executeRoute(api(`http://localhost/api/workflows/${id}/execute`, { method: "POST", headers: bob.headers, body: {} }), context(id))],
      ["archive", () => archiveWorkflowRoute(api(`http://localhost/api/workflows/${id}`, { method: "DELETE", headers: bob.headers }), context(id))],
    ];

    for (const [name, call] of routes) {
      const result = await statusOf(await call());
      expect(result.status, name).toBe(404);
      expect(result.code, name).toBe("NOT_FOUND");
    }

    /* Alice's workflow is untouched. */
    expect(getWorkflowFor(alice.actor, id).name).toBe("Untitled workflow");
  });
});

/* ------------------------------------------------------------------ */
/* AI-generated workflows                                              */
/* ------------------------------------------------------------------ */

describe("AI-generated plans", () => {
  it("lands in the draft and cannot skip the publish step", async () => {
    const account = createTestAccount();

    /* This is exactly what "Apply to editor" calls. */
    const applied = createWorkflowFor(account.actor, {
      id: "wf_ai_applied",
      name: "Generated by AI",
      definition: runnable("wf_ai_applied"),
    });

    expect(applied.hasUnpublishedChanges).toBe(true);
    expect(applied.publishedVersionId).toBeNull();
    expect(versionsOf(applied.id)).toHaveLength(0);

    /* Nothing runs until the draft is valid and versioned. */
    const execution = await runWorkflowFor(account.actor, applied.id, {});
    expect(execution.workflowVersionId).toBeTruthy();
    expect(queryOne<{ id: string }>("SELECT id FROM workflow_versions WHERE id = ?", execution.workflowVersionId ?? ""))
      .toBeTruthy();
    expect(getWorkflowFor(account.actor, applied.id).publishedVersionId).toBe(
      execution.workflowVersionId,
    );
  });

  it("keeps a generated plan out of the version store when it is invalid", () => {
    const account = createTestAccount();
    const broken = runnable("wf_ai_broken");
    broken.edges = [{ id: "e1", source: "n_missing", target: "n_log" }];

    const applied = createWorkflowFor(account.actor, {
      id: "wf_ai_broken",
      definition: broken,
    });
    expect(applied.publishedVersionId).toBeNull();
    expectHttp(() => publishWorkflowFor(account.actor, applied.id), 422);
    expect(versionsOf(applied.id)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Archiving                                                           */
/* ------------------------------------------------------------------ */

describe("archiving", () => {
  it("removes a workflow from the list but leaves its history readable", async () => {
    const account: TestAccount = createTestAccount();
    const created = createWorkflowFor(account.actor, { id: "wf_archive" });
    saveDraftFor(account.actor, created.id, {
      definition: runnable(created.id),
      revision: created.revision,
    });
    publishWorkflowFor(account.actor, created.id);
    const execution = await runWorkflowFor(account.actor, created.id, {});

    archiveWorkflowFor(account.actor, created.id);

    expectHttp(() => getWorkflowFor(account.actor, created.id), 404);
    expectHttp(() => listVersionsFor(account.actor, created.id), 404);

    /* The execution still resolves the version it ran: archiving never
       takes history away from the runs that reference it. */
    const row = queryOne<{ workflow_version_id: string }>(
      "SELECT workflow_version_id FROM executions WHERE id = ?",
      execution.id,
    );
    expect(row?.workflow_version_id).toBeTruthy();
    expect(
      queryAll("SELECT id FROM workflow_versions WHERE id = ?", row?.workflow_version_id ?? ""),
    ).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Route behaviour                                                     */
/* ------------------------------------------------------------------ */

describe("workflow routes", () => {
  it("creates, drafts, publishes and versions over HTTP", async () => {
    const account = createTestAccount();

    const created = await createWorkflowRoute(
      api("http://localhost/api/workflows", {
        method: "POST",
        headers: account.headers,
        body: { name: "Over HTTP" },
      }),
    );
    expect(created.status).toBe(201);
    const workflow = (await json(created)).workflow as {
      id: string;
      revision: number;
      publishedVersionId: string | null;
    };
    expect(workflow.publishedVersionId).toBeNull();

    const draft = await saveDraftRoute(
      api(`http://localhost/api/workflows/${workflow.id}/draft`, {
        method: "PUT",
        headers: account.headers,
        body: { definition: runnable(workflow.id), revision: workflow.revision },
      }),
      context(workflow.id),
    );
    expect(draft.status).toBe(200);

    /* A stale revision is a 409 carrying the server's copy. */
    const stale = await saveDraftRoute(
      api(`http://localhost/api/workflows/${workflow.id}/draft`, {
        method: "PUT",
        headers: account.headers,
        body: { definition: runnable(workflow.id), revision: workflow.revision },
      }),
      context(workflow.id),
    );
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toMatchObject({ code: "REVISION_CONFLICT" });

    const published = await publishRoute(
      api(`http://localhost/api/workflows/${workflow.id}/publish`, {
        method: "POST",
        headers: account.headers,
      }),
      context(workflow.id),
    );
    expect(published.status).toBe(201);

    const versions = await listVersionsRoute(
      api(`http://localhost/api/workflows/${workflow.id}/versions`, {
        headers: account.headers,
      }),
      context(workflow.id),
    );
    const list = ((await json(versions)).versions as Array<{ id: string; isPublished: boolean }>);
    expect(list).toHaveLength(1);
    expect(list[0]!.isPublished).toBe(true);

    const archived = await archiveWorkflowRoute(
      api(`http://localhost/api/workflows/${workflow.id}`, {
        method: "DELETE",
        headers: account.headers,
      }),
      context(workflow.id),
    );
    expect(archived.status).toBe(200);
    expectHttp(() => getWorkflowFor(account.actor, workflow.id), 404);
  });

  it("requires a session for every workflow route", async () => {
    const results: number[] = [];
    results.push(
      (await createWorkflowRoute(api("http://localhost/api/workflows", { method: "POST" }))).status,
    );
    results.push((await getWorkflowRoute(api("http://localhost/api/workflows/wf_x"), context("wf_x"))).status);
    results.push(
      (await saveDraftRoute(
        api("http://localhost/api/workflows/wf_x/draft", { method: "PUT", body: {} }),
        context("wf_x"),
      )).status,
    );
    results.push(
      (await publishRoute(
        api("http://localhost/api/workflows/wf_x/publish", { method: "POST" }),
        context("wf_x"),
      )).status,
    );
    expect(results).toEqual([401, 401, 401, 401]);
  });
});

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

describe("schema migration", () => {
  it("gives a legacy workflow row safe defaults for every new column", () => {
    const now = Date.now();
    run(
      `INSERT INTO workflows (id, workspace_id, name, status, trigger_type, node_count, latest_version, created_at, updated_at)
       VALUES (?, 'ws_legacy', 'Legacy', 'draft', 'trigger.manual', 0, 3, ?, ?)`,
      "wf_legacy",
      now,
      now,
    );

    const row = queryOne<{
      draft: string;
      draft_revision: number;
      published_version: number;
      published_version_id: string | null;
      archived_at: number | null;
      description: string;
    }>(
      "SELECT draft, draft_revision, published_version, published_version_id, archived_at, description FROM workflows WHERE id = ?",
      "wf_legacy",
    );
    expect(row?.draft).toBe("{}");
    expect(row?.draft_revision).toBe(0);
    expect(row?.published_version).toBe(0);
    expect(row?.published_version_id).toBeNull();
    expect(row?.archived_at).toBeNull();
    expect(row?.description).toBe("");
  });

  it(`has moved the schema to version ${SCHEMA_VERSION}`, () => {
    const version = queryOne<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'schema_version'",
    );
    expect(version?.value).toBe(String(SCHEMA_VERSION));
  });

  it("created the trigger tables with their idempotency key", () => {
    const columns = queryAll<{ name: string }>(
      "PRAGMA table_info(trigger_fires)",
    ).map((column) => column.name);
    expect(columns).toContain("trigger_id");
    expect(columns).toContain("occurrence_key");
    expect(columns).toContain("execution_id");

    /* The claim barrier: one row per (trigger, occurrence), ever. */
    const primary = queryAll<{ name: string; origin: string }>(
      "PRAGMA index_list(trigger_fires)",
    ).find((index) => index.origin === "pk");
    expect(primary, "trigger_fires needs a primary key").toBeTruthy();
    const keyColumns = queryAll<{ name: string }>(
      `PRAGMA index_info(${primary!.name})`,
    ).map((column) => column.name);
    expect(keyColumns).toEqual(["trigger_id", "occurrence_key"]);

    /* Backfilled from the seed: a seeded schedule already has a row,
       so it can fire without anyone opening its card first. */
    const seeded = queryOne<{ type: string; enabled: number; schedule_cron: string | null }>(
      "SELECT type, enabled, schedule_cron FROM workflow_triggers WHERE workflow_id = ?",
      "wf_nightly_sync",
    );
    expect(seeded?.type).toBe("schedule");
    expect(seeded?.enabled).toBe(1);
    expect(seeded?.schedule_cron).toBeTruthy();
  });

  it("seeds a draft and a published pointer, not a bare definition", () => {
    /* Any workflow write makes sure the identity + demo seed ran. */
    const account = createTestAccount();
    createWorkflowFor(account.actor, { name: "trigger seed" });

    const row = queryOne<{
      draft: string;
      published_version: number;
      published_version_id: string | null;
    }>(
      "SELECT draft, published_version, published_version_id FROM workflows WHERE id = ?",
      "wf_customer_intake",
    );
    expect(row?.published_version).toBe(1);
    expect(row?.published_version_id).toBe("wfv_seed_wf_customer_intake");
    expect(String(row?.draft)).toContain("nodes");

    const definition = queryOne<{ definition: string }>(
      "SELECT definition FROM workflow_versions WHERE id = ?",
      row?.published_version_id ?? "",
    );
    expect(definition?.definition).toBeTruthy();
  });
});

describe("duplication", () => {
  /** A webhook workflow, the case where a copy must not inherit identity. */
  function webhookWorkflow(id: string): Workflow {
    return {
      ...runnable(id),
      triggerType: "trigger.webhook",
      nodes: [
        {
          id: "n_start",
          type: "trigger.webhook",
          position: { x: 0, y: 0 },
          data: {
            ref: "hook",
            config: { path: `/hooks/${id}`, method: "POST", auth: "none", secret: "" },
          },
        },
        {
          id: "n_log",
          type: "action.log",
          position: { x: 260, y: 0 },
          data: { ref: "", config: { message: "copied", level: "info" } },
        },
      ],
    };
  }

  function pathOf(workflowId: string): string {
    const row = queryOne<{ draft: string }>(
      "SELECT draft FROM workflows WHERE id = ?",
      workflowId,
    );
    const graph = JSON.parse(String(row?.draft)) as Workflow;
    return String(graph.nodes?.[0]?.data?.config?.path ?? "");
  }

  function publishedVersionOf(workflowId: string): number {
    return Number(
      queryOne<{ published_version: number }>(
        "SELECT published_version FROM workflows WHERE id = ?",
        workflowId,
      )?.published_version ?? 0,
    );
  }

  it("gives the copy its own path, and starts unpublished", () => {
    const account = createTestAccount();
    const source = createWorkflowFor(account.actor, {
      name: "source",
      definition: webhookWorkflow("wf_hook_src"),
    });
    const copy = duplicateWorkflowFor(account.actor, source.id);

    expect(pathOf(source.id)).toBe("/hooks/wf_hook_src");
    expect(pathOf(copy.id)).not.toBe(pathOf(source.id));
    expect(copy.status).toBe("draft");
    expect(publishedVersionOf(copy.id)).toBe(0);
    expect(versionsOf(copy.id)).toHaveLength(0);
  });

  it("keeps successive copies off each other's paths", () => {
    /* The clash check has to see claims other copies are sitting on,
       not only endpoints somebody has published — otherwise the second
       copy silently shares the first one's path until a publish fails. */
    const account = createTestAccount();
    const source = createWorkflowFor(account.actor, {
      name: "multi",
      definition: webhookWorkflow("wf_hook_multi"),
    });

    const paths = [pathOf(source.id)];
    for (let i = 0; i < 3; i += 1) {
      const copy = duplicateWorkflowFor(account.actor, source.id);
      paths.push(pathOf(copy.id));
    }

    expect(new Set(paths).size).toBe(paths.length);
  });

  it("leaves the source where it was", () => {
    const account = createTestAccount();
    const source = createWorkflowFor(account.actor, {
      name: "untouched",
      definition: webhookWorkflow("wf_hook_untouched"),
    });
    const before = JSON.stringify(pathOf(source.id));

    duplicateWorkflowFor(account.actor, source.id);
    duplicateWorkflowFor(account.actor, source.id);

    expect(pathOf(source.id)).toBe(JSON.parse(before) as string);
    expect(publishedVersionOf(source.id)).toBe(0);
  });
});
