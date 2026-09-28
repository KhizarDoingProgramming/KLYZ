import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.KLYZ_QUEUE_DRIVER = "memory";

/* One private database for this file: nothing else can see its rows. */
openTestDatabase("klyz_templates");

import { GET as listRoute, POST as createRoute } from "@/app/api/templates/route";
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/templates/[id]/route";
import { POST as createFromTemplateRoute } from "@/app/api/templates/[id]/create-workflow/route";
import { POST as saveAsTemplateRoute } from "@/app/api/workflows/[id]/template/route";
import { queryAll, queryOne, run as sqlRun } from "@/lib/server/db";
import { resetRateLimits } from "@/lib/server/rate-limit";
import {
  ensureSystemTemplates,
  resetSystemTemplateCache,
} from "@/lib/server/templates";
import { SYSTEM_TEMPLATES } from "@/lib/server/template-library";
import { endTestDatabase, openTestDatabase, createTestAccount } from "@/lib/server/testing";
import { createWorkflowFor, getWorkflowFor } from "@/lib/server/workflow-service";
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

function definition(id: string, name = "Template source"): Workflow {
  return {
    id,
    name,
    description: "A workflow worth reusing",
    status: "draft",
    tags: ["ops"],
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
  };
}

function portableOf(workflow: Workflow): PortableWorkflow {
  return portableFromWorkflow(workflow).portable;
}

function storedDefinition(templateId: string): PortableWorkflow | null {
  const row = queryOne<{ definition: string }>(
    "SELECT definition FROM templates WHERE id = ?",
    templateId,
  );
  return row ? (JSON.parse(row.definition) as PortableWorkflow) : null;
}

beforeEach(() => {
  resetRateLimits();
});

/* ------------------------------------------------------------------ */
/* The built-in library                                                */
/* ------------------------------------------------------------------ */

describe("system templates", () => {
  it("is available in every workspace", async () => {
    const account = createTestAccount();
    const response = await listRoute(api("/api/templates", { headers: account.headers }));
    expect(response.status).toBe(200);

    const payload = (await json(response)) as {
      templates: Array<{ id: string; system: boolean }>;
    };
    const systemIds = payload.templates
      .filter((entry) => entry.system)
      .map((entry) => entry.id);
    for (const template of SYSTEM_TEMPLATES) {
      expect(systemIds).toContain(template.id);
    }
    expect(systemIds).toHaveLength(SYSTEM_TEMPLATES.length);
  });

  it("seeds only once — a second run must not duplicate the library", () => {
    createTestAccount();
    const before = queryAll<{ id: string }>("SELECT id FROM templates WHERE system = 1")
      .length;
    expect(before).toBe(SYSTEM_TEMPLATES.length);

    sqlRun("DELETE FROM templates WHERE system = 1");
    resetSystemTemplateCache();
    ensureSystemTemplates();
    ensureSystemTemplates();

    expect(queryAll("SELECT id FROM templates WHERE system = 1")).toHaveLength(before);
  });

  it("stores built-ins as tenantless portable documents", () => {
    createTestAccount();
    const rows = queryAll<{ workspace_id: string; definition: string; node_count: number }>(
      "SELECT workspace_id, definition, node_count FROM templates WHERE system = 1",
    );
    expect(rows).toHaveLength(SYSTEM_TEMPLATES.length);
    for (const row of rows) {
      expect(row.workspace_id).toBe("*");
      const portable = JSON.parse(row.definition) as PortableWorkflow;
      expect(portable.format).toBe("klyz.workflow");
      expect(portable.nodes.length).toBe(row.node_count);
      expect(portable.nodes.length).toBeGreaterThan(0);
    }
  });

  it("refuses to be edited or deleted", async () => {
    const account = createTestAccount();
    const id = SYSTEM_TEMPLATES[0]!.id;

    const patched = await patchRoute(
      api(`/api/templates/${id}`, {
        method: "PATCH",
        headers: account.headers,
        body: { name: "Hijacked" },
      }),
      context(id),
    );
    expect(await errorOf(patched)).toEqual({ status: 422, code: "TEMPLATE_SYSTEM" });

    const removed = await deleteRoute(
      api(`/api/templates/${id}`, { method: "DELETE", headers: account.headers }),
      context(id),
    );
    expect(await errorOf(removed)).toEqual({ status: 422, code: "TEMPLATE_SYSTEM" });
    expect(queryOne("SELECT name FROM templates WHERE id = ?", id)).toBeDefined();
  });

  it("creates a draft from a built-in without publishing anything", async () => {
    const account = createTestAccount();
    const response = await createFromTemplateRoute(
      api(`/api/templates/${SYSTEM_TEMPLATES[0]!.id}/create-workflow`, {
        method: "POST",
        headers: account.headers,
        body: { name: "Copied built-in" },
      }),
      context(SYSTEM_TEMPLATES[0]!.id),
    );

    expect(response.status).toBe(201);
    const payload = (await json(response)) as {
      workflow: { id: string; status: string; publishedVersion: number; name: string };
      summary: { nodeCount: number };
      requirements: Array<{ resolved: boolean }>;
    };
    expect(payload.workflow.status).toBe("draft");
    expect(payload.workflow.publishedVersion).toBe(0);
    expect(payload.workflow.name).toBe("Copied built-in");
    expect(payload.summary.nodeCount).toBeGreaterThan(0);
    expect(payload.requirements.length).toBeGreaterThanOrEqual(0);

    const stored = getWorkflowFor(account.actor, payload.workflow.id);
    expect(stored.publishedVersion).toBe(0);
    expect(stored.name).toBe("Copied built-in");
  });

  it("records who started a workflow from a template", async () => {
    const account = createTestAccount();
    const response = await createFromTemplateRoute(
      api(`/api/templates/${SYSTEM_TEMPLATES[1]!.id}/create-workflow`, {
        method: "POST",
        headers: account.headers,
        body: {},
      }),
      context(SYSTEM_TEMPLATES[1]!.id),
    );
    const payload = (await json(response)) as { workflow: { id: string } };

    const rows = queryAll<{ action: string; resource_id: string }>(
      "SELECT action, resource_id FROM audit_events WHERE workspace_id = ?",
      account.workspaceId,
    );
    expect(rows).toContainEqual({
      action: "workflow.created_from_template",
      resource_id: payload.workflow.id,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Workspace templates                                                 */
/* ------------------------------------------------------------------ */

describe("workspace templates", () => {
  it("captures a workflow's draft as a portable blueprint", async () => {
    const account = createTestAccount();
    const workflow = createWorkflowFor(account.actor, {
      id: "wf_to_template",
      definition: definition("wf_to_template", "Nightly rollup"),
    });

    const response = await saveAsTemplateRoute(
      api(`/api/workflows/${workflow.id}/template`, {
        method: "POST",
        headers: account.headers,
        body: { name: "Nightly rollup", category: "data" },
      }),
      context(workflow.id),
    );

    expect(response.status).toBe(201);
    const payload = (await json(response)) as {
      template: { id: string; name: string; category: string; nodeCount: number; system: boolean };
    };
    expect(payload.template.name).toBe("Nightly rollup");
    expect(payload.template.category).toBe("data");
    expect(payload.template.nodeCount).toBe(2);
    expect(payload.template.system).toBe(false);

    const stored = storedDefinition(payload.template.id);
    expect(stored?.format).toBe("klyz.workflow");
    expect(JSON.stringify(stored)).toBe(JSON.stringify(portableOf(definition("wf_to_template", "Nightly rollup"))));
  });

  it("accepts a portable document directly", async () => {
    const account = createTestAccount();
    const response = await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: account.headers,
        body: {
          name: "From a file",
          description: "Hand written",
          category: "ai",
          definition: portableOf(definition("wf_file", "From a file")),
        },
      }),
    );

    expect(response.status).toBe(201);
    const payload = (await json(response)) as {
      template: { id: string; description: string; category: string };
    };
    expect(payload.template.description).toBe("Hand written");
    expect(payload.template.category).toBe("ai");
  });

  it("refuses a document with a step this build does not have", async () => {
    const account = createTestAccount();
    const doc = portableOf(definition("wf_unknown"));
    doc.nodes[1]!.type = "capability.something_new";
    const response = await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: account.headers,
        body: { name: "Future", definition: doc },
      }),
    );
    expect(await errorOf(response)).toEqual({ status: 422, code: "IMPORT_UNSUPPORTED" });
  });

  it("renames and recategorises an owned template", async () => {
    const account = createTestAccount();
    const created = await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: account.headers,
        body: { name: "Before", definition: portableOf(definition("wf_rename")) },
      }),
    );
    const template = ((await json(created)) as { template: { id: string } }).template;

    const response = await patchRoute(
      api(`/api/templates/${template.id}`, {
        method: "PATCH",
        headers: account.headers,
        body: { name: "After", category: "notifications" },
      }),
      context(template.id),
    );
    expect(response.status).toBe(200);
    const payload = (await json(response)) as {
      template: { name: string; category: string };
    };
    expect(payload.template.name).toBe("After");
    expect(payload.template.category).toBe("notifications");
  });

  it("falls back to the general category for anything unrecognised", async () => {
    const account = createTestAccount();
    const created = await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: account.headers,
        body: { name: "Odd category", definition: portableOf(definition("wf_cat")) },
      }),
    );
    const template = ((await json(created)) as { template: { id: string; category: string } })
      .template;
    expect(template.category).toBe("general");
  });

  it("deletes a template it owns and only that one", async () => {
    const account = createTestAccount();
    const created = await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: account.headers,
        body: { name: "Temporary", definition: portableOf(definition("wf_del")) },
      }),
    );
    const template = ((await json(created)) as { template: { id: string } }).template;

    const response = await deleteRoute(
      api(`/api/templates/${template.id}`, { method: "DELETE", headers: account.headers }),
      context(template.id),
    );
    expect(response.status).toBe(200);
    expect(queryOne("SELECT id FROM templates WHERE id = ?", template.id)).toBeUndefined();

    const rows = queryAll<{ action: string }>(
      "SELECT action FROM audit_events WHERE workspace_id = ?",
      account.workspaceId,
    );
    expect(rows.map((entry) => entry.action)).toContain("template.deleted");
  });

  it("filters the library by category and by free text", async () => {
    const account = createTestAccount();
    await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: account.headers,
        body: {
          name: "Pager escalation",
          category: "notifications",
          definition: portableOf(definition("wf_pager", "Pager escalation")),
        },
      }),
    );

    const byCategory = await listRoute(
      api("/api/templates?category=notifications", { headers: account.headers }),
    );
    const notified = (await json(byCategory)) as {
      templates: Array<{ name: string; category: string }>;
    };
    expect(notified.templates.every((entry) => entry.category === "notifications")).toBe(true);
    expect(notified.templates.map((entry) => entry.name)).toContain("Pager escalation");

    const byText = await listRoute(api("/api/templates?q=escalation", { headers: account.headers }));
    const found = (await json(byText)) as { templates: Array<{ name: string }> };
    expect(found.templates.map((entry) => entry.name)).toEqual(["Pager escalation"]);
  });

  it("answers 404 when somebody else's template is named directly", async () => {
    const first = createTestAccount();
    const created = await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: first.headers,
        body: { name: "Private", definition: portableOf(definition("wf_private")) },
      }),
    );
    const template = ((await json(created)) as { template: { id: string } }).template;

    const stranger = createTestAccount();
    const direct = await getRoute(
      api(`/api/templates/${template.id}`, { headers: stranger.headers }),
      context(template.id),
    );
    expect(direct.status).toBe(404);
  });

  it("lets a viewer read the library but not grow it", async () => {
    const owner = createTestAccount();
    const viewer = createTestAccount({
      workspaceId: owner.workspaceId,
      role: "viewer",
    });

    const read = await listRoute(api("/api/templates", { headers: viewer.headers }));
    expect(read.status).toBe(200);

    const write = await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: viewer.headers,
        body: { name: "Nope", definition: portableOf(definition("wf_viewer")) },
      }),
    );
    expect(await errorOf(write)).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  it("stops at the workspace's template ceiling", async () => {
    const account = createTestAccount();
    const at = Date.now();
    const portable = JSON.stringify(portableOf(definition("wf_bulk")));
    for (let index = 0; index < 200; index += 1) {
      sqlRun(
        `INSERT INTO templates (id, workspace_id, name, description, category, icon,
           definition, node_count, trigger_type, integrations, required_credentials,
           system, created_by, created_at, updated_at)
         VALUES (?, ?, ?, '', 'general', 'workflow', ?, 2, 'trigger.manual', '[]', '[]', 0, ?, ?, ?)`,
        `tpl_bulk_${index}`,
        account.workspaceId,
        `Bulk ${index}`,
        portable,
        account.userId,
        at + index,
        at + index,
      );
    }

    const response = await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: account.headers,
        body: { name: "One too many", definition: portableOf(definition("wf_over")) },
      }),
    );
    expect(await errorOf(response)).toEqual({ status: 422, code: "TEMPLATE_LIMIT" });
  });
});

/* ------------------------------------------------------------------ */
/* Creating a workflow from a template                                 */
/* ------------------------------------------------------------------ */

describe("creating a workflow from a template", () => {
  it("lands as an unpublished draft with its own identity", async () => {
    const account = createTestAccount();
    const created = await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: account.headers,
        body: { name: "Blue print", definition: portableOf(definition("wf_bp", "Blue print")) },
      }),
    );
    const template = ((await json(created)) as { template: { id: string } }).template;

    const response = await createFromTemplateRoute(
      api(`/api/templates/${template.id}/create-workflow`, {
        method: "POST",
        headers: account.headers,
        body: { name: "Second copy" },
      }),
      context(template.id),
    );

    expect(response.status).toBe(201);
    const payload = (await json(response)) as {
      workflow: { id: string; name: string; status: string; publishedVersion: number };
      requirements: unknown[];
      warnings: unknown[];
    };
    expect(payload.workflow.name).toBe("Second copy");
    expect(payload.workflow.status).toBe("draft");
    expect(payload.workflow.publishedVersion).toBe(0);
    expect(Array.isArray(payload.requirements)).toBe(true);
    expect(Array.isArray(payload.warnings)).toBe(true);

    const stored = getWorkflowFor(account.actor, payload.workflow.id);
    expect(stored.id).not.toBe("wf_bp");
    expect(stored.name).toBe("Second copy");
  });

  it("keeps a copied schedule switched off", async () => {
    const account = createTestAccount();
    const scheduled: Workflow = {
      ...definition("wf_sched", "Hourly digest"),
      triggerType: "trigger.schedule",
      nodes: [
        {
          id: "start",
          type: "trigger.schedule",
          position: { x: 0, y: 0 },
          data: { ref: "", config: { every: 1, unit: "hours", timezone: "UTC" } },
        },
        {
          id: "log",
          type: "action.log",
          position: { x: 240, y: 0 },
          data: { ref: "note", config: { message: "tick", level: "info" } },
        },
      ],
      edges: [{ id: "e1", source: "start", target: "log" }],
    };

    const created = await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: account.headers,
        body: { name: "Hourly digest", definition: portableOf(scheduled) },
      }),
    );
    const template = ((await json(created)) as { template: { id: string } }).template;

    const response = await createFromTemplateRoute(
      api(`/api/templates/${template.id}/create-workflow`, {
        method: "POST",
        headers: account.headers,
        body: {},
      }),
      context(template.id),
    );
    const payload = (await json(response)) as { workflow: { id: string } };

    const row = queryOne<{ enabled: number; type: string }>(
      "SELECT enabled, type FROM workflow_triggers WHERE workflow_id = ?",
      payload.workflow.id,
    );
    expect(row?.type).toBe("schedule");
    expect(row?.enabled).toBe(0);
  });

  it("reports a connection the template still needs", async () => {
    const account = createTestAccount();
    const withCredential: Workflow = {
      ...definition("wf_need_cred", "Needs a connection"),
      triggerType: "trigger.schedule",
      nodes: [
        {
          id: "start",
          type: "trigger.schedule",
          position: { x: 0, y: 0 },
          data: { ref: "", config: { every: 1, unit: "days", timezone: "UTC" } },
        },
        {
          id: "query",
          type: "action.postgres",
          position: { x: 240, y: 0 },
          data: {
            ref: "warehouse",
            config: { credential: "cred_stored_elsewhere", operation: "query", query: "select 1" },
          },
        },
      ],
      edges: [{ id: "e1", source: "start", target: "query" }],
    };

    const created = await createRoute(
      api("/api/templates", {
        method: "POST",
        headers: account.headers,
        body: { name: "Needs a connection", definition: portableOf(withCredential) },
      }),
    );
    const template = ((await json(created)) as { template: { id: string } }).template;

    const response = await createFromTemplateRoute(
      api(`/api/templates/${template.id}/create-workflow`, {
        method: "POST",
        headers: account.headers,
        body: {},
      }),
      context(template.id),
    );
    expect(response.status).toBe(201);
    const payload = (await json(response)) as {
      requirements: Array<{ field: string; resolved: boolean; providers: string[] }>;
      workflow: { id: string };
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
    expect(draft.nodes.find((node) => node.type === "action.postgres")?.data.config.credential)
      .toBeUndefined();
  });
});

afterAll(async () => {
  await endTestDatabase();
}, 60_000);
