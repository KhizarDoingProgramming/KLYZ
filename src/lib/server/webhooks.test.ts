import { afterAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "klyz-webhook-test-"));
process.env.KLYZ_DB_PATH = join(tmpDir, "klyz.db");
process.env.KLYZ_QUEUE_DRIVER = "memory";

import { HttpError } from "./http";
import { defaultActor } from "./identity";
import { getDb, queryAll, queryOne } from "./db";
import {
  getWebhookFor,
  publishWebhook,
  receiveWebhook,
  unpublishWebhook,
} from "./webhooks";
import type { ExecutionDetail } from "@/lib/execution/types";
import type { Workflow } from "@/lib/workflow/types";

const actor = defaultActor();

afterAll(() => {
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

function webhookWorkflow(
  id: string,
  config: Record<string, unknown>,
): Workflow {
  return {
    id,
    name: `Webhook ${id}`,
    description: "",
    status: "draft",
    tags: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastExecutedAt: null,
    executionCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    triggerType: "trigger.webhook",
    nodeCount: 2,
    nodes: [
      {
        id: "hook",
        type: "trigger.webhook",
        position: { x: 0, y: 0 },
        data: { ref: "webhook", config },
      },
      {
        id: "log",
        type: "action.log",
        position: { x: 240, y: 0 },
        data: { ref: "log", config: { message: "got {{webhook.body.msg}}" } },
      },
    ],
    edges: [
      { id: "e_hook_log", source: "hook", target: "log" },
    ],
  };
}

async function runFor(workflowId: string): Promise<ExecutionDetail> {
  const row = queryOne<{ id: string }>(
    "SELECT id FROM executions WHERE workflow_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    workflowId,
  );
  if (!row) throw new Error("no execution found");
  const deadline = Date.now() + 10_000;
  for (;;) {
    const detail = queryOne<{ status: string }>(
      "SELECT status FROM executions WHERE id = ?",
      row.id,
    );
    if (detail && ["completed", "failed", "cancelled"].includes(detail.status)) {
      const { getExecutionDetailFor } = await import("./execution-service");
      return getExecutionDetailFor(actor, row.id);
    }
    if (Date.now() > deadline) throw new Error("execution did not settle");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function deliveryRequest(
  url: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  return new Request(url, {
    method: options.method ?? "POST",
    body: options.body,
    headers: options.headers ?? { "content-type": "application/json" },
  });
}

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code} but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status, `status for ${code}`).toBe(status);
    expect((error as HttpError).code).toBe(code);
  }
}

/* ------------------------------------------------------------------ */
/* Publish                                                             */
/* ------------------------------------------------------------------ */

describe("publishing an endpoint", () => {
  it("creates a copyable endpoint and never persists the plaintext secret", async () => {
    const definition = webhookWorkflow("wf_wh_publish", {
      path: "/hooks/demo",
      method: "POST",
      auth: "header",
      secret: "whsec_super_secret_value",
    });

    const view = publishWebhook(actor, { definition });
    expect(view.slug).toMatch(/^wh_/);
    expect(view.url).toContain(`/api/webhooks/${view.slug}`);
    expect(view.path).toBe("/hooks/demo");
    expect(view.method).toBe("POST");
    expect(view.auth).toBe("header");
    expect(view.secretSet).toBe(true);
    expect(view.enabled).toBe(true);
    expect(view).not.toHaveProperty("secret");
    expect(JSON.stringify(view)).not.toContain("whsec_super_secret_value");

    /* The version store must hold the secret-stripped definition. */
    const version = queryOne<{ definition: string }>(
      "SELECT definition FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1",
      "wf_wh_publish",
    );
    expect(version).toBeTruthy();
    const stored = JSON.parse(version!.definition) as Workflow;
    const node = stored.nodes.find((item) => item.type === "trigger.webhook");
    expect((node?.data.config as Record<string, unknown>).secret).toBe("");
    expect(version!.definition).not.toContain("whsec_super_secret_value");
  });

  it("does not bump the version when only the secret changes", () => {
    const before = queryAll<{ version: number }>(
      "SELECT version FROM workflow_versions WHERE workflow_id = ?",
      "wf_wh_publish",
    ).length;

    publishWebhook(actor, {
      definition: webhookWorkflow("wf_wh_publish", {
        path: "/hooks/demo",
        method: "POST",
        auth: "header",
        secret: "whsec_rotated_value",
      }),
    });

    const after = queryAll<{ version: number }>(
      "SELECT version FROM workflow_versions WHERE workflow_id = ?",
      "wf_wh_publish",
    ).length;
    expect(after).toBe(before);

    const view = getWebhookFor(actor, "wf_wh_publish");
    expect(view?.secretSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain("whsec_rotated_value");
  });

  it("refuses a path another endpoint already owns", async () => {
    const definition = webhookWorkflow("wf_wh_clash", {
      path: "/hooks/demo",
      method: "POST",
      auth: "none",
    });
    await expectHttpError(
      Promise.resolve().then(() => publishWebhook(actor, { definition })),
      409,
      "PATH_IN_USE",
    );
  });

  it("requires a webhook trigger on the graph", async () => {
    const definition = webhookWorkflow("wf_wh_notrigger", {
      path: "/hooks/x",
      method: "POST",
      auth: "none",
    });
    definition.nodes = definition.nodes.filter((node) => node.type !== "trigger.webhook");
    definition.edges = [];
    await expectHttpError(
      Promise.resolve().then(() => publishWebhook(actor, { definition })),
      422,
      "NO_WEBHOOK_TRIGGER",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Receiving                                                           */
/* ------------------------------------------------------------------ */

describe("receiving deliveries", () => {
  it("accepts an unauthenticated POST and runs the published workflow", async () => {
    const definition = webhookWorkflow("wf_wh_open", {
      path: "/hooks/open",
      method: "POST",
      auth: "none",
    });
    const view = publishWebhook(actor, { definition });

    const delivery = await receiveWebhook(
      deliveryRequest(`http://localhost/api/webhooks/${view.slug}`, {
        body: JSON.stringify({ msg: "hello" }),
        headers: { "content-type": "application/json", authorization: "Bearer leak-me" },
      }),
      view.slug,
    );
    expect(delivery.executionId).toMatch(/^ex_/);
    expect(["queued", "running", "completed", "failed"]).toContain(delivery.status);

    const execution = await runFor("wf_wh_open");
    expect(execution.status).toBe("completed");
    expect(execution.source).toBe("webhook");
    const triggerStep = execution.steps.find((step) => step.nodeId === "hook");
    expect(triggerStep?.status).toBe("completed");
    expect(triggerStep?.output).toMatchObject({
      body: { msg: "hello" },
      query: {},
    });
    /* Auth headers are redacted before they reach run history. */
    expect(JSON.stringify(triggerStep?.output)).not.toContain("leak-me");

    const logStep = execution.steps.find((step) => step.nodeId === "log");
    expect(logStep?.output).toMatchObject({ message: "got hello" });
  });

  it("is reachable by its published path as well as by slug", async () => {
    const view = publishWebhook(actor, {
      definition: webhookWorkflow("wf_wh_path", {
        path: "/hooks/by-path",
        method: "POST",
        auth: "none",
      }),
    });
    expect(view.path).toBe("/hooks/by-path");

    const delivery = await receiveWebhook(
      deliveryRequest("http://localhost/api/webhooks/hooks/by-path", {
        body: JSON.stringify({ msg: "via path" }),
      }),
      "hooks/by-path",
    );
    expect(delivery.executionId).toMatch(/^ex_/);
    const execution = await runFor("wf_wh_path");
    expect(execution.status).toBe("completed");
  });

  it("rejects a wrong or missing shared-secret header", async () => {
    const view = publishWebhook(actor, {
      definition: webhookWorkflow("wf_wh_header", {
        path: "/hooks/secure",
        method: "POST",
        auth: "header",
        secret: "whsec_right",
      }),
    });

    await expectHttpError(
      receiveWebhook(
        deliveryRequest(`http://localhost/api/webhooks/${view.slug}`, {
          body: JSON.stringify({ msg: "nope" }),
        }),
        view.slug,
      ),
      401,
      "WEBHOOK_AUTH_FAILED",
    );
    await expectHttpError(
      receiveWebhook(
        deliveryRequest(`http://localhost/api/webhooks/${view.slug}`, {
          body: JSON.stringify({ msg: "nope" }),
          headers: {
            "content-type": "application/json",
            "x-klyz-webhook-secret": "whsec_wrong",
          },
        }),
        view.slug,
      ),
      401,
      "WEBHOOK_AUTH_FAILED",
    );

    const delivery = await receiveWebhook(
      deliveryRequest(`http://localhost/api/webhooks/${view.slug}`, {
        body: JSON.stringify({ msg: "yes" }),
        headers: {
          "content-type": "application/json",
          "x-klyz-webhook-secret": "whsec_right",
        },
      }),
      view.slug,
    );
    expect(delivery.executionId).toMatch(/^ex_/);
    const execution = await runFor("wf_wh_header");
    expect(execution.status).toBe("completed");
  });

  it("verifies an HMAC signature over the exact body", async () => {
    const secret = "whsec_hmac_secret";
    const view = publishWebhook(actor, {
      definition: webhookWorkflow("wf_wh_hmac", {
        path: "/hooks/hmac",
        method: "POST",
        auth: "hmac",
        secret,
      }),
    });
    const body = JSON.stringify({ msg: "signed" });
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    await expectHttpError(
      receiveWebhook(
        deliveryRequest(`http://localhost/api/webhooks/${view.slug}`, {
          body,
          headers: { "content-type": "application/json", "x-klyz-signature": "sha256=bad" },
        }),
        view.slug,
      ),
      401,
      "WEBHOOK_AUTH_FAILED",
    );

    const delivery = await receiveWebhook(
      deliveryRequest(`http://localhost/api/webhooks/${view.slug}`, {
        body,
        headers: { "content-type": "application/json", "x-klyz-signature": signature },
      }),
      view.slug,
    );
    expect(delivery.executionId).toMatch(/^ex_/);
    const execution = await runFor("wf_wh_hmac");
    expect(execution.status).toBe("completed");
  });

  it("enforces the configured method", async () => {
    const view = publishWebhook(actor, {
      definition: webhookWorkflow("wf_wh_method", {
        path: "/hooks/method",
        method: "POST",
        auth: "none",
      }),
    });
    await expectHttpError(
      receiveWebhook(
        deliveryRequest(`http://localhost/api/webhooks/${view.slug}`, { method: "GET" }),
        view.slug,
      ),
      405,
      "WEBHOOK_METHOD_NOT_ALLOWED",
    );
  });

  it("404s unknown, disabled and unpublished endpoints", async () => {
    await expectHttpError(
      receiveWebhook(deliveryRequest("http://localhost/api/webhooks/wh_missing"), "wh_missing"),
      404,
      "WEBHOOK_NOT_FOUND",
    );

    const view = publishWebhook(actor, {
      definition: webhookWorkflow("wf_wh_disabled", {
        path: "/hooks/disabled",
        method: "POST",
        auth: "none",
      }),
      enabled: false,
    });
    expect(getWebhookFor(actor, "wf_wh_disabled")?.enabled).toBe(false);
    await expectHttpError(
      receiveWebhook(
        deliveryRequest(`http://localhost/api/webhooks/${view.slug}`, { body: "{}" }),
        view.slug,
      ),
      404,
      "WEBHOOK_NOT_FOUND",
    );

    const published = publishWebhook(actor, {
      definition: webhookWorkflow("wf_wh_gone", {
        path: "/hooks/gone",
        method: "POST",
        auth: "none",
      }),
    });
    unpublishWebhook(actor, "wf_wh_gone");
    expect(getWebhookFor(actor, "wf_wh_gone")).toBeNull();
    await expectHttpError(
      receiveWebhook(
        deliveryRequest(`http://localhost/api/webhooks/${published.slug}`, { body: "{}" }),
        published.slug,
      ),
      404,
      "WEBHOOK_NOT_FOUND",
    );
  });

  it("records delivery bookkeeping and a redacted sample", async () => {
    const view = publishWebhook(actor, {
      definition: webhookWorkflow("wf_wh_bookkeeping", {
        path: "/hooks/count",
        method: "POST",
        auth: "none",
      }),
    });
    await receiveWebhook(
      deliveryRequest(`http://localhost/api/webhooks/${view.slug}`, {
        body: JSON.stringify({ msg: "counted", password: "hunter2" }),
      }),
      view.slug,
    );
    const after = getWebhookFor(actor, "wf_wh_bookkeeping");
    expect(after?.deliveryCount).toBe(1);
    expect(after?.lastDeliveryStatus).toBe("accepted");
    expect(after?.lastDeliveryAt).toBeTruthy();
    expect(after?.sample).toContain("counted");
    expect(after?.sample).not.toContain("hunter2");
  });
});
