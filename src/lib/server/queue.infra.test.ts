import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * Queue infrastructure tests — the real transport.
 *
 * These run against a live Redis (docker compose up -d redis) and the
 * real BullMQ worker, so what they prove is what production does:
 * enqueue → worker claim → engine → persisted events → terminal state.
 * They fail with instructions rather than silently skipping.
 */

process.env.KLYZ_QUEUE_DRIVER = "redis";
process.env.KLYZ_QUEUE_NAME = `klyz-test-${Math.random().toString(36).slice(2, 10)}`;
process.env.KLYZ_WORKER_CONCURRENCY = "2";
process.env.KLYZ_EXECUTION_TIMEOUT_MS = "0";
process.env.KLYZ_CANCEL_POLL_MS = "200";

/* One private database for this file: nothing else can see its rows. */
openTestDatabase("klyz_queue_infra");

import { defaultActor } from "./identity";
import { queryAll, queryOne, run as sqlRun } from "./db";
import { endTestDatabase, openTestDatabase } from "./testing";
import {
  cancelExecutionFor,
  getExecutionDetailFor,
  startWorkflowRun,
} from "./execution-service";
import { processExecutionJob, sweepExecutions } from "./execution-runner";
import { closeQueue, enqueueExecution, executionJobState, queueStats } from "@/lib/queue";
import { closeWorker, startWorker } from "@/lib/queue/worker";
import { getQueue } from "@/lib/queue/redis-driver";
import { closeRedis } from "./redis";
import type { Workflow } from "@/lib/workflow/types";

const actor = defaultActor();

type TestNode = Workflow["nodes"][number];
type TestEdge = Workflow["edges"][number];

function node(id: string, type: string, config: Record<string, unknown> = {}, ref = id): TestNode {
  return { id, type, position: { x: 0, y: 0 }, data: { ref, config } };
}

function edge(source: string, target: string): TestEdge {
  return { id: `e_${source}_${target}`, source, target };
}

function workflow(id: string, nodes: TestNode[], edges: TestEdge[]): Workflow {
  return {
    id,
    name: `Infra ${id}`,
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
    nodeCount: nodes.length,
    nodes,
    edges,
  };
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

beforeAll(async () => {
  try {
    await queueStats();
  } catch {
    /* stats swallows transport errors — probe the socket directly */
  }
  const probe = await fetch("http://127.0.0.1:6379").catch(() => null);
  const reachable = await isRedisReachable().catch(() => false);
  if (!reachable && probe === null) {
    throw new Error(
      "Redis is not reachable on 127.0.0.1:6379.\n" +
        "Queue infrastructure tests need the real transport:\n" +
        "    npm run infra:up   (docker compose up -d redis postgres)",
    );
  }
  await startWorker({ sweep: false });
}, 30_000);

afterAll(async () => {
  await closeWorker();
  try {
    await getQueue().obliterate({ force: true });
  } catch {
    /* queue already gone */
  }
  await closeQueue();
  await closeRedis();
  await endTestDatabase();
});

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

describe("redis queue round trip", () => {
  it("runs a workflow through BullMQ to a completed execution", async () => {
    const definition = workflow(
      "wf_infra_linear",
      [
        node("t", "trigger.manual", {}),
        node("vars", "data.variables", { values: [{ id: "1", key: "flag", value: "on" }] }),
        node("log", "action.log", { message: "infra {{vars.vars.flag}}" }),
      ],
      [edge("t", "vars"), edge("vars", "log")],
    );

    const started = await startWorkflowRun(actor, { definition });
    expect(started.status).toBe("queued");

    await waitFor(
      () => {
        const status = getExecutionDetailFor(actor, started.id).status;
        return status === "completed" || status === "failed" || status === "cancelled";
      },
      "queued execution to settle",
    );

    const detail = getExecutionDetailFor(actor, started.id);
    expect(detail.status).toBe("completed");
    expect(detail.steps.map((step) => step.nodeId)).toEqual(["t", "vars", "log"]);
    expect(detail.metadata.engine).toBe("klyz-local");
  });

  it("reports queue stats and a live worker heartbeat", async () => {
    const stats = await queueStats();
    expect(stats.driver).toBe("redis");
    expect(stats.reachable).toBe(true);
    expect(stats.name).toBe(process.env.KLYZ_QUEUE_NAME);

    const { readHeartbeat } = await import("@/lib/queue/worker");
    const heartbeat = readHeartbeat();
    expect(heartbeat.alive).toBe(true);
    expect(heartbeat.concurrency).toBe(2);
  }, 10_000);

  it("ignores a duplicate delivery of the same execution", async () => {
    const definition = workflow(
      "wf_infra_duplicate",
      [node("t", "trigger.manual", {}), node("log", "action.log", { message: "once" })],
      [edge("t", "log")],
    );
    const started = await startWorkflowRun(actor, { definition });
    await waitFor(
      () => getExecutionDetailFor(actor, started.id).status === "completed",
      "first delivery to finish",
    );

    /* A stale redelivery after completion must be a no-op. */
    const outcome = await processExecutionJob({ executionId: started.id }, { attempt: 2 });
    expect(outcome).toBe("skipped");

    const detail = getExecutionDetailFor(actor, started.id);
    expect(detail.status).toBe("completed");
    expect(detail.steps).toHaveLength(2);
    expect(detail.stepCount).toBe(2);
  }, 15_000);

  it("does not start a second engine when an execution is already running", async () => {
    const definition = workflow(
      "wf_infra_race",
      [
        node("t", "trigger.manual", {}),
        node("wait", "logic.delay", { duration: "custom", custom: 4_000 }),
        node("log", "action.log", { message: "after wait" }),
      ],
      [edge("t", "wait"), edge("wait", "log")],
    );
    const started = await startWorkflowRun(actor, { definition });
    await waitFor(
      () => getExecutionDetailFor(actor, started.id).status === "waiting",
      "delay to enter waiting",
    );

    const outcome = await processExecutionJob({ executionId: started.id }, { attempt: 1 });
    expect(outcome).toBe("interrupted");

    const detail = getExecutionDetailFor(actor, started.id);
    expect(detail.steps.filter((step) => step.nodeId === "wait")).toHaveLength(1);

    /* let the run finish so later tests see a quiet queue */
    await waitFor(
      () => getExecutionDetailFor(actor, started.id).status === "completed",
      "delayed run to finish",
    );
  }, 20_000);

  it("cancels a run the worker owns via cancel_requested", async () => {
    const definition = workflow(
      "wf_infra_cancel",
      [
        node("t", "trigger.manual", {}),
        node("wait", "logic.delay", { duration: "custom", custom: 30_000 }),
        node("log", "action.log", { message: "never" }),
      ],
      [edge("t", "wait"), edge("wait", "log")],
    );
    const started = await startWorkflowRun(actor, { definition });
    await waitFor(
      () => getExecutionDetailFor(actor, started.id).status === "waiting",
      "delay to start",
    );

    /* No local AbortController here — the flag is the only channel,
       exactly like cancelling from another process would be. */
    const result = await cancelExecutionFor(actor, started.id);
    expect(result.accepted).toBe(true);

    await waitFor(
      () => getExecutionDetailFor(actor, started.id).status === "cancelled",
      "worker to observe cancel_requested",
      10_000,
    );
    const detail = getExecutionDetailFor(actor, started.id);
    expect(detail.error?.code).toBe("CANCELLED");
    expect(detail.steps.find((step) => step.nodeId === "wait")?.error?.code).toBe("CANCELLED");
  }, 20_000);

  it("settles a still-queued execution immediately on cancel", async () => {
    /* Stop the worker so nothing can race the claim: this case is
       specifically about cancelling before a worker picks the job up. */
    await closeWorker();
    try {
      const definition = workflow(
        "wf_infra_cancel_queued",
        [node("t", "trigger.manual", {}), node("log", "action.log", { message: "never" })],
        [edge("t", "log")],
      );
      const started = await startWorkflowRun(actor, { definition });
      expect(
        queryOne<{ status: string }>(
          "SELECT status FROM executions WHERE id = ?",
          started.id,
        )?.status,
      ).toBe("queued");

      const cancelled = await cancelExecutionFor(actor, started.id);
      expect(cancelled.accepted).toBe(true);
      expect(cancelled.status).toBe("cancelled");

      const detail = getExecutionDetailFor(actor, started.id);
      expect(detail.status).toBe("cancelled");
      expect(detail.steps).toHaveLength(0);
      expect(detail.error?.code).toBe("CANCELLED");
      /* The job came off the queue — nothing is left to run it. */
      expect(await executionJobState(started.id)).toBe("unknown");
    } finally {
      await startWorker({ sweep: false });
    }
  }, 15_000);
});

describe("sweeper", () => {
  it("re-enqueues an execution whose job vanished", async () => {
    const definition = workflow(
      "wf_infra_sweep_requeue",
      [node("t", "trigger.manual", {}), node("log", "action.log", { message: "swept" })],
      [edge("t", "log")],
    );
    const started = await startWorkflowRun(actor, { definition });
    await waitFor(
      () => getExecutionDetailFor(actor, started.id).status === "completed",
      "setup run to finish",
    );

    /* Simulate a Redis flush: the job is gone, the row is still queued. */
    const job = await getQueue().getJob(started.id);
    await job?.remove();
    sqlRun(
      "UPDATE executions SET status = 'queued', completed_at = NULL, started_at = ?, output = NULL, error = NULL WHERE id = ?",
      Date.now() - 120_000,
      started.id,
    );
    expect(
      queryOne<{ status: string }>("SELECT status FROM executions WHERE id = ?", started.id)?.status,
    ).toBe("queued");

    const result = await sweepExecutions({
      state: executionJobState,
      enqueue: enqueueExecution,
      staleMs: 60_000,
    });
    expect(result.requeued).toContain(started.id);

    await waitFor(
      () => getExecutionDetailFor(actor, started.id).status === "completed",
      "re-enqueued execution to finish",
    );
  }, 20_000);

  it("closes a stranded running execution as WORKER_LOST instead of leaving it open", async () => {
    const definition = workflow(
      "wf_infra_sweep_lost",
      [node("t", "trigger.manual", {}), node("log", "action.log", { message: "x" })],
      [edge("t", "log")],
    );
    const started = await startWorkflowRun(actor, { definition });
    await waitFor(
      () => getExecutionDetailFor(actor, started.id).status === "completed",
      "execution to finish",
    );

    /* Pretend the worker died: reopen as running with no job behind it. */
    sqlRun(
      "UPDATE executions SET status = 'running', completed_at = NULL, started_at = ? WHERE id = ?",
      Date.now() - 120_000,
      started.id,
    );

    const result = await sweepExecutions({
      state: async () => "unknown",
      enqueue: async () => {},
      staleMs: 60_000,
    });
    expect(result.finalized.map((entry) => entry.executionId)).toContain(started.id);

    const detail = getExecutionDetailFor(actor, started.id);
    expect(detail.status).toBe("failed");
    expect(detail.error?.code).toBe("WORKER_LOST");
  }, 15_000);

  it("leaves executions with a live job alone", async () => {
    const before = queryAll<{ id: string }>(
      "SELECT id FROM executions WHERE status IN ('queued','running','waiting')",
    );
    const result = await sweepExecutions({
      state: async () => "active",
      enqueue: async () => {
        throw new Error("should not re-enqueue a live job");
      },
      staleMs: 0,
    });
    expect(result.requeued).toHaveLength(0);
    expect(result.finalized).toHaveLength(0);
    expect(before.length).toBeGreaterThanOrEqual(0);
  });
});
