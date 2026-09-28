import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.KLYZ_QUEUE_DRIVER = "memory";

/* One private database for this file: nothing else can see its rows. */
openTestDatabase("klyz_portability");

import { GET as exportRoute } from "@/app/api/workflows/[id]/export/route";
import { POST as importRoute } from "@/app/api/workflows/import/route";
import { createCredential } from "@/lib/server/credentials";
import { queryAll, queryOne } from "@/lib/server/db";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { endTestDatabase, openTestDatabase, createTestAccount, type TestAccount } from "@/lib/server/testing";
import { exportWorkflowFor } from "@/lib/server/portability";
import {
  createWorkflowFor,
  getWorkflowFor,
  publishWorkflowFor,
} from "@/lib/server/workflow-service";
import { portableFromWorkflow, type PortableWorkflow } from "@/lib/workflow/portable";
import type { Workflow } from "@/lib/workflow/types";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function api(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const { method = "GET", headers = {}, body } = init;
  const absolute = url.startsWith("http") ? url : `http://localhost${url}`;
  return new Request(absolute, {
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

async function errorOf(response: Response): Promise<{ status: number; code: string }> {
  const payload = (await json(response)).error as { code?: string } | undefined;
  return { status: response.status, code: payload?.code ?? "" };
}

function definition(id: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: "Weekly digest",
    description: "Collect and post",
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
        id: "start",
        type: "trigger.manual",
        position: { x: 0, y: 0 },
        data: { ref: "", config: {} },
      },
      {
        id: "log",
        type: "action.log",
        position: { x: 240, y: 0 },
        data: { ref: "note", config: { message: "hello", level: "info" } },
      },
    ],
    edges: [{ id: "e1", source: "start", target: "log" }],
    ...overrides,
  };
}

/** A schedule trigger plus a step that needs a stored connection. */
function postgresDefinition(id: string, credentialId: string): Workflow {
  return definition(id, {
    name: "Sync leads",
    triggerType: "trigger.schedule",
    nodeCount: 2,
    nodes: [
      {
        id: "start",
        type: "trigger.schedule",
        position: { x: 0, y: 0 },
        data: { ref: "", config: { every: 1, unit: "hours", timezone: "UTC" } },
      },
      {
        id: "query",
        type: "action.postgres",
        position: { x: 240, y: 0 },
        data: {
          ref: "warehouse",
          config: {
            credential: credentialId,
            operation: "query",
            query: "select 1",
          },
        },
      },
    ],
    edges: [{ id: "e1", source: "start", target: "query" }],
  });
}

function triggerRow(workflowId: string) {
  return queryOne<{ enabled: number; type: string }>(
    "SELECT enabled, type FROM workflow_triggers WHERE workflow_id = ?",
    workflowId,
  );
}

let owner: TestAccount;

beforeEach(() => {
  resetRateLimits();
});

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

describe("workflow export", () => {
  it("returns a portable document as a download", async () => {
    owner = createTestAccount();
    const workflow = createWorkflowFor(owner.actor, {
      id: "wf_export_one",
      definition: definition("wf_export_one"),
    });

    const response = await exportRoute(
      api(`/api/workflows/${workflow.id}/export`, { headers: owner.headers }),
      context(workflow.id),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(".klyz.json");
    const payload = (await json(response)) as { export: { portable: PortableWorkflow } };
    expect(payload.export.portable.format).toBe("klyz.workflow");
    expect(payload.export.portable.version).toBe(1);
    expect(payload.export.portable.nodes).toHaveLength(2);
  });

  it("leaves no workspace, credential or run identifiers in the bytes", async () => {
    owner = createTestAccount();
    const credential = createCredential(owner.actor, {
      name: "Warehouse",
      kind: "postgres",
      fields: { host: "db.internal", database: "leads", password: "hunter2-very-secret" },
    });
    const workflow = createWorkflowFor(owner.actor, {
      id: "wf_export_cred",
      definition: postgresDefinition("wf_export_cred", credential.id),
    });

    const response = await exportRoute(
      api(`/api/workflows/${workflow.id}/export`, { headers: owner.headers }),
      context(workflow.id),
    );
    const raw = await response.text();

    expect(raw).not.toContain(owner.workspaceId);
    expect(raw).not.toContain(credential.id);
    expect(raw).not.toContain("hunter2-very-secret");
    expect(raw).not.toContain("db.internal");
    expect(raw).not.toContain("createdAt");

    const payload = JSON.parse(raw) as { export: { portable: PortableWorkflow } };
    const node = payload.export.portable.nodes.find(
      (entry) => entry.type === "action.postgres",
    );
    expect(node?.config.credential).toBeUndefined();
    expect(node?.credentials).toEqual({
      credential: { provider: "postgres", name: "Warehouse" },
    });
  });

  it("exports an immutable version when one is named", async () => {
    owner = createTestAccount();
    const workflow = createWorkflowFor(owner.actor, {
      id: "wf_export_version",
      definition: definition("wf_export_version"),
    });
    const published = publishWorkflowFor(owner.actor, workflow.id);
    expect(published.version.id).toBeTruthy();

    const response = await exportRoute(
      api(`/api/workflows/${workflow.id}/export?version=${published.version.id}`, {
        headers: owner.headers,
      }),
      context(workflow.id),
    );
    expect(response.status).toBe(200);
    const payload = (await json(response)) as { export: { source: string } };
    expect(payload.export.source).toBe("version");
  });

  it("answers 404 for a workflow in somebody else's workspace", async () => {
    const other = createTestAccount();
    const secret = createWorkflowFor(other.actor, {
      id: "wf_private_to_other",
      definition: definition("wf_private_to_other"),
    });
    const stranger = createTestAccount();

    const response = await exportRoute(
      api(`/api/workflows/${secret.id}/export`, { headers: stranger.headers }),
      context(secret.id),
    );
    expect(response.status).toBe(404);
  });

  it("records the export in the audit log", async () => {
    owner = createTestAccount();
    const workflow = createWorkflowFor(owner.actor, {
      id: "wf_audited_export",
      definition: definition("wf_audited_export"),
    });
    await exportRoute(
      api(`/api/workflows/${workflow.id}/export`, { headers: owner.headers }),
      context(workflow.id),
    );

    const rows = queryAll<{ action: string }>(
      "SELECT action FROM audit_events WHERE workspace_id = ? ORDER BY id DESC",
      owner.workspaceId,
    );
    expect(rows.map((entry) => entry.action)).toContain("workflow.exported");
  });
});

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

function portableFor(name: string): PortableWorkflow {
  return portableFromWorkflow(definition("wf_source", { name })).portable;
}

async function post(body: unknown, headers: Record<string, string>): Promise<Response> {
  return importRoute(
    api("/api/workflows/import", { method: "POST", headers, body }),
  );
}

describe("workflow import", () => {
  it("creates an unpublished draft", async () => {
    owner = createTestAccount();
    const response = await post({ definition: portableFor("Imported draft") }, owner.headers);

    expect(response.status).toBe(201);
    const payload = (await json(response)) as {
      workflow: { id: string; status: string; publishedVersion: number; name: string };
      dryRun: boolean;
      summary: { nodeCount: number };
    };
    expect(payload.dryRun).toBe(false);
    expect(payload.workflow.status).toBe("draft");
    expect(payload.workflow.publishedVersion).toBe(0);
    expect(payload.workflow.name).toBe("Imported draft");
    expect(payload.summary.nodeCount).toBe(2);

    const stored = getWorkflowFor(owner.actor, payload.workflow.id);
    expect(stored.publishedVersion).toBe(0);
    expect(stored.publishedVersionId).toBeNull();
  });

  it("validates without writing anything when asked for a dry run", async () => {
    owner = createTestAccount();
    const before = queryAll<{ id: string }>(
      "SELECT id FROM workflows WHERE workspace_id = ?",
      owner.workspaceId,
    );

    const response = await post(
      { definition: portableFor("Preview only"), dryRun: true },
      owner.headers,
    );

    expect(response.status).toBe(201);
    const payload = (await json(response)) as {
      workflow: unknown;
      summary: { name: string };
      dryRun: boolean;
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.workflow).toBeNull();
    expect(payload.summary.name).toBe("Preview only");

    const after = queryAll<{ id: string }>(
      "SELECT id FROM workflows WHERE workspace_id = ?",
      owner.workspaceId,
    );
    expect(after).toHaveLength(before.length);
  });

  it("leaves a schedule paused until somebody turns it on", async () => {
    owner = createTestAccount();
    const credential = createCredential(owner.actor, {
      name: "Warehouse",
      kind: "postgres",
      fields: { host: "db.internal", database: "leads", password: "pw" },
    });
    const created = createWorkflowFor(owner.actor, {
      id: "wf_schedule_source",
      definition: postgresDefinition("wf_schedule_source", credential.id),
    });
    const source = exportWorkflowFor(owner.actor, created.id).portable;

    const response = await post({ definition: source }, owner.headers);
    expect(response.status).toBe(201);
    const payload = (await json(response)) as { workflow: { id: string } };

    const row = triggerRow(payload.workflow.id);
    expect(row?.type).toBe("schedule");
    expect(row?.enabled).toBe(0);
  });

  it("maps a stored connection by exact name and kind", async () => {
    owner = createTestAccount();
    const credential = createCredential(owner.actor, {
      name: "Warehouse",
      kind: "postgres",
      fields: { host: "db.internal", database: "leads", password: "pw" },
    });
    const created = createWorkflowFor(owner.actor, {
      id: "wf_map_source",
      definition: postgresDefinition("wf_map_source", credential.id),
    });
    const source = exportWorkflowFor(owner.actor, created.id).portable;

    const response = await post({ definition: source }, owner.headers);
    expect(response.status).toBe(201);
    const payload = (await json(response)) as {
      workflow: { id: string };
      requirements: Array<{ field: string; resolved: boolean }>;
    };

    const requirement = payload.requirements.find((entry) => entry.field === "credential");
    expect(requirement?.resolved).toBe(true);

    const stored = getWorkflowFor(owner.actor, payload.workflow.id);
    const draft = JSON.parse(
      queryOne<{ draft: string }>("SELECT draft FROM workflows WHERE id = ?", payload.workflow.id)!
        .draft,
    ) as Workflow;
    const node = draft.nodes.find((entry) => entry.type === "action.postgres");
    expect(node?.data.config.credential).toBe(credential.id);
    expect(stored.nodeCount).toBe(2);
  });

  it("reports the connection it still needs when none matches", async () => {
    owner = createTestAccount();
    /* Exported from a graph whose stored connection does not exist in
       this workspace — the placeholder survives, nothing maps. */
    const created = createWorkflowFor(owner.actor, {
      id: "wf_needs_cred",
      definition: postgresDefinition("wf_needs_cred", "cred_from_the_other_side"),
    });
    const source = exportWorkflowFor(owner.actor, created.id).portable;

    const response = await post({ definition: source }, owner.headers);
    expect(response.status).toBe(201);
    const payload = (await json(response)) as {
      workflow: { id: string };
      requirements: Array<{ field: string; resolved: boolean; providers: string[] }>;
    };
    expect(payload.requirements.find((entry) => entry.field === "credential")?.resolved).toBe(
      false,
    );

    const draft = JSON.parse(
      queryOne<{ draft: string }>(
        "SELECT draft FROM workflows WHERE id = ?",
        payload.workflow.id,
      )!.draft,
    ) as Workflow;
    const node = draft.nodes.find((entry) => entry.type === "action.postgres");
    expect(node?.data.config.credential).toBeUndefined();
  });

  it("accepts an explicit connection choice and rejects one that does not fit", async () => {
    owner = createTestAccount();
    const credential = createCredential(owner.actor, {
      name: "Warehouse",
      kind: "postgres",
      fields: { host: "db.internal", database: "leads", password: "pw" },
    });
    const created = createWorkflowFor(owner.actor, {
      id: "wf_explicit",
      definition: postgresDefinition("wf_explicit", credential.id),
    });
    const source = exportWorkflowFor(owner.actor, created.id).portable;

    const key = "postgres_1.credential";
    const good = await post(
      { definition: source, credentials: { [key]: credential.id } },
      owner.headers,
    );
    expect(good.status).toBe(201);
    const goodPayload = (await json(good)) as { requirements: Array<{ resolved: boolean }> };
    expect(goodPayload.requirements.every((entry) => entry.resolved)).toBe(true);

    resetRateLimits();
    const wrongField = await post(
      { definition: source, credentials: { "nope.credential": credential.id } },
      owner.headers,
    );
    expect(await errorOf(wrongField)).toEqual({
      status: 422,
      code: "CREDENTIAL_UNKNOWN_FIELD",
    });
  });

  it("refuses a document this build cannot read", async () => {
    owner = createTestAccount();
    const response = await post({ definition: { format: "not-klyz" } }, owner.headers);
    const error = await errorOf(response);
    expect(error.status).toBe(422);
    expect(error.code).toBe("IMPORT_UNSUPPORTED_FORMAT");
  });

  it("refuses a definition that hides a secret", async () => {
    owner = createTestAccount();
    const doc = portableFor("Sneaky");
    doc.nodes[1]!.config = { message: "hi", level: "info", apiKey: "sk-live_abcdef99" };
    const response = await post({ definition: doc }, owner.headers);
    const error = await errorOf(response);
    expect(error.status).toBe(422);
    expect(error.code).toBe("IMPORT_UNSUPPORTED");
  });

  it("refuses a body larger than the request ceiling", async () => {
    owner = createTestAccount();
    const huge = `{ "definition": ${JSON.stringify(portableFor("Big"))}, "pad": "${"x".repeat(600_000)}" }`;
    const response = await post(huge, owner.headers);
    expect(await errorOf(response)).toEqual({ status: 413, code: "REQUEST_TOO_LARGE" });
  });

  it("rate limits how often one workspace may import", async () => {
    owner = createTestAccount();
    const definition = portableFor("Rate limited");
    let last = 0;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await post({ definition }, owner.headers);
      last = response.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it("records the import in the audit log", async () => {
    owner = createTestAccount();
    const response = await post({ definition: portableFor("Audited") }, owner.headers);
    const payload = (await json(response)) as { workflow: { id: string } };

    const rows = queryAll<{ action: string; resource_id: string }>(
      "SELECT action, resource_id FROM audit_events WHERE workspace_id = ?",
      owner.workspaceId,
    );
    expect(rows).toContainEqual({
      action: "workflow.imported",
      resource_id: payload.workflow.id,
    });
  });

  it("keeps an imported workflow out of another workspace", async () => {
    owner = createTestAccount();
    const stranger = createTestAccount();
    const response = await post({ definition: portableFor("Mine") }, owner.headers);
    const payload = (await json(response)) as { workflow: { id: string } };

    expect(() => getWorkflowFor(stranger.actor, payload.workflow.id)).toThrow(
      /does not exist/i,
    );
  });
});

afterAll(async () => {
  await endTestDatabase();
}, 60_000);
