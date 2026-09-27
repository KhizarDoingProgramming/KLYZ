import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Webhook flow — real transport.
 *
 * publish → receiver route → BullMQ → worker → persisted execution and
 * delivery bookkeeping. Needs the docker compose Redis; fails loudly
 * with setup instructions when it is not reachable.
 */

const tmpDir = mkdtempSync(join(tmpdir(), "klyz-webhook-infra-"));
process.env.KLYZ_DB_PATH = join(tmpDir, "klyz.db");
process.env.KLYZ_QUEUE_DRIVER = "redis";
process.env.KLYZ_QUEUE_NAME = `klyz-test-${Math.random().toString(36).slice(2, 10)}`;
process.env.KLYZ_WORKER_CONCURRENCY = "2";
process.env.KLYZ_EXECUTION_TIMEOUT_MS = "0";

import { defaultActor } from "@/lib/server/identity";
import { getExecutionDetailFor } from "@/lib/server/execution-service";
import {
  getWebhookFor,
  publishWebhook,
  unpublishWebhook,
} from "@/lib/server/webhooks";
import { closeQueue, queueStats } from "@/lib/queue";
import { closeWorker, startWorker } from "@/lib/queue/worker";
import { getQueue } from "@/lib/queue/redis-driver";
import { closeRedis } from "@/lib/server/redis";
import { getDb } from "@/lib/server/db";
import { POST as receive } from "@/app/api/webhooks/[...key]/route";
import type { Workflow } from "@/lib/workflow/types";

const actor = defaultActor();
const WORKFLOW_ID = "wf_webhook_infra";
const SECRET = "whsec_infra_secret";
const PATH = "/hooks/infra";

function definition(): Workflow {
  return {
    id: WORKFLOW_ID,
    name: "Webhook infra",
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
        id: "n_hook",
        type: "trigger.webhook",
        position: { x: 0, y: 0 },
        data: { ref: "webhook", config: { path: PATH, method: "POST", auth: "header" } },
      },
      {
        id: "n_log",
        type: "action.log",
        position: { x: 0, y: 200 },
        data: { ref: "log", config: { message: "got {{webhook.body.hello}}" } },
      },
    ],
    edges: [{ id: "e_1", source: "n_hook", target: "n_log" }],
  };
}

function call(
  path: string,
  init: RequestInit = {},
  segments?: string[],
) {
  const key = segments ?? path.replace(/^\/api\/webhooks\/?/, "").split("/");
  return receive(
    new Request(`http://klyz.test${path}`, init),
    { params: Promise.resolve({ key }) },
  );
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function isRedisReachable(): Promise<boolean> {
  const { createConnection } = await import("node:net");
  return new Promise((resolve) => {
    const socket = createConnection({ port: 6379, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

beforeAll(async () => {
  if (!(await isRedisReachable())) {
    throw new Error(
      "Redis is not reachable on 127.0.0.1:6379.\n" +
        "Webhook infrastructure tests need the real transport:\n" +
        "    npm run infra:up   (docker compose up -d redis postgres)",
    );
  }
  await startWorker({ sweep: false });
}, 30_000);

afterAll(async () => {
  try {
    unpublishWebhook(actor, WORKFLOW_ID);
  } catch {
    /* not published */
  }
  await closeWorker();
  try {
    await getQueue().obliterate({ force: true });
  } catch {
    /* queue already gone */
  }
  await closeQueue();
  await closeRedis();
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("webhook publish → receive → worker", () => {
  it("queues and completes a run for an authenticated delivery", async () => {
    const published = publishWebhook(actor, {
      definition: definition(),
      path: PATH,
      method: "POST",
      auth: "header",
      secret: SECRET,
    });
    expect(published.enabled).toBe(true);
    expect(published.secretSet).toBe(true);
    expect(published.url).toContain("/api/webhooks/");
    /* The versioned definition never stores the secret. */
    expect(published.auth).toBe("header");

    const response = await call(
      "/api/webhooks/hooks/infra",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-klyz-webhook-secret": SECRET,
        },
        body: JSON.stringify({ hello: "infra" }),
      },
      ["hooks", "infra"],
    );
    expect(response.status).toBe(202);
    const delivery = (await response.json()) as { executionId: string; status: string };
    expect(delivery.executionId).toMatch(/^ex_/);

    await waitFor(
      () => {
        const status = getExecutionDetailFor(actor, delivery.executionId).status;
        return status === "completed" || status === "failed" || status === "cancelled";
      },
      "webhook execution to settle",
    );
    const detail = getExecutionDetailFor(actor, delivery.executionId);
    expect(detail.status).toBe("completed");
    expect(detail.steps.map((step) => step.nodeId)).toEqual(["n_hook", "n_log"]);
    expect(detail.source).toBe("webhook");

    const view = getWebhookFor(actor, WORKFLOW_ID);
    expect(view?.deliveryCount).toBeGreaterThanOrEqual(1);
    expect(view?.lastDeliveryStatus).toBe("accepted");
    expect(view?.sample).toContain("infra");
  }, 20_000);

  it("rejects a wrong secret, a wrong method and an unknown path", async () => {
    const wrongSecret = await call(
      "/api/webhooks/hooks/infra",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-klyz-webhook-secret": "nope" },
        body: JSON.stringify({ hello: "x" }),
      },
      ["hooks", "infra"],
    );
    expect(wrongSecret.status).toBe(401);
    expect(((await wrongSecret.json()) as { error?: { code?: string } }).error?.code).toBe(
      "WEBHOOK_AUTH_FAILED",
    );

    const wrongMethod = await call(
      "/api/webhooks/hooks/infra",
      { method: "GET" },
      ["hooks", "infra"],
    );
    expect(wrongMethod.status).toBe(405);

    const unknown = await call(
      "/api/webhooks/hooks/nowhere",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ["hooks", "nowhere"],
    );
    expect(unknown.status).toBe(404);
  });

  it("keeps queue stats reachable while webhooks are flowing", async () => {
    const stats = await queueStats();
    expect(stats.driver).toBe("redis");
    expect(stats.reachable).toBe(true);
  });
});
