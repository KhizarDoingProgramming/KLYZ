import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The debugger contract, end to end.
 *
 * Everything a run shows in the canvas, the timeline and the inspector
 * is decided here: the retry trail, the waiting flip, the provider-call
 * telemetry, the redaction of run input, and the definition/rerun reads
 * behind the two new endpoints. Real engine, real HTTP, real SQLite —
 * no mocks, because the assertions *are* about what got persisted.
 */

const tmpDir = mkdtempSync(join(tmpdir(), "klyz-debugger-test-"));
process.env.KLYZ_DB_PATH = join(tmpDir, "klyz.db");
process.env.KLYZ_QUEUE_DRIVER = "memory";
process.env.KLYZ_HTTP_ALLOW_PRIVATE = "1";

import { defaultActor } from "./identity";
import { getDb, queryAll, queryOne } from "./db";
import { HttpError } from "./http";
import {
  getExecutionDefinitionFor,
  getExecutionDetailFor,
  rerunExecutionFor,
  startWorkflowRun,
} from "./execution-service";
import type { ExecutionDetail, ExecutionStepView } from "@/lib/execution/types";
import type { Workflow } from "@/lib/workflow/types";

const actor = defaultActor();

let server: Server;
let port = 0;
let hookCalls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      hookCalls += 1;
      /* Two transient failures, then success — the retry path. */
      if (hookCalls <= 2) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, seen: hookCalls }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
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

type TestNode = Workflow["nodes"][number];
type TestEdge = Workflow["edges"][number];

type RetryRecord = { attempt: number; nextAttempt: number; delayMs: number; code?: string };
type CallRecord = {
  provider: string;
  method: string;
  url: string;
  status: number | null;
  ok: boolean;
  error?: string;
};

function node(id: string, type: string, config: Record<string, unknown> = {}): TestNode {
  return { id, type, position: { x: 0, y: 0 }, data: { ref: id, config } };
}

function edge(source: string, target: string): TestEdge {
  return { id: `e_${source}_${target}`, source, target };
}

function workflow(id: string, nodes: TestNode[], edges: TestEdge[]): Workflow {
  return {
    id,
    name: `Test ${id}`,
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

function stepFor(execution: ExecutionStepView[] | ExecutionDetail, ref: string): ExecutionStepView {
  const steps = Array.isArray(execution) ? execution : execution.steps;
  const found = steps.find((candidate) => candidate.ref === ref);
  if (!found) {
    throw new Error(`no step "${ref}" in ${steps.map((step) => step.ref).join(", ") || "(none)"}`);
  }
  return found;
}

async function settle(executionId: string): Promise<ExecutionDetail> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = queryOne<{ status: string }>(
      "SELECT status FROM executions WHERE id = ?",
      executionId,
    );
    if (row && ["completed", "failed", "cancelled"].includes(row.status)) {
      return getExecutionDetailFor(actor, executionId);
    }
    if (Date.now() > deadline) throw new Error(`execution ${executionId} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Watch a live run for a transient state before it disappears. */
async function waitForStepStatus(
  executionId: string,
  ref: string,
  wanted: string,
  timeoutMs = 8_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = queryOne<{ status: string }>(
      `SELECT status FROM execution_steps WHERE execution_id = ? AND ref = ?`,
      executionId,
      ref,
    );
    if (row?.status === wanted) return true;
    const run = queryOne<{ status: string }>(
      "SELECT status FROM executions WHERE id = ?",
      executionId,
    );
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) return false;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The row appears before the queue picks it up, so a live run can be watched
    from the moment it is written — even if the caller is still awaiting. */
async function findLatestExecution(workflowId: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = queryOne<{ id: string }>(
      "SELECT id FROM executions WHERE workflow_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      workflowId,
    );
    if (row) return row.id;
    if (Date.now() > deadline) throw new Error(`no execution written for ${workflowId}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function eventsOfType(executionId: string, type: string): Array<Record<string, unknown>> {
  return queryAll<{ data: string }>(
    "SELECT data FROM execution_events WHERE execution_id = ? AND type = ? ORDER BY at, rowid",
    executionId,
    type,
  ).map((row) => JSON.parse(row.data) as Record<string, unknown>);
}

/* ------------------------------------------------------------------ */
/* Retries + telemetry                                                 */
/* ------------------------------------------------------------------ */

describe("retry trail and provider telemetry", () => {
  it("keeps the failed attempts, the backoff and the calls it made", async () => {
    hookCalls = 0;
    const definition = workflow(
      "wf_retry",
      [
        node("t", "trigger.manual"),
        node("http1", "action.http", {
          method: "POST",
          url: `http://127.0.0.1:${port}/hook?api_key=super-secret`,
        }),
      ],
      [edge("t", "http1")],
    );

    const started = await startWorkflowRun(actor, {
      definition,
      input: { authorization: "Bearer top-secret-token", author: "Ada" },
      source: "manual",
      options: { maxAttempts: 3 },
    });
    const finished = await settle(started.id);

    expect(finished.status).toBe("completed");
    expect(hookCalls).toBe(3);

    const step = stepFor(finished, "http1");
    expect(step.status).toBe("completed");
    expect(step.attempt).toBe(3);
    expect(step.error).toBeUndefined();

    const metadata = (step.metadata ?? {}) as {
      retries?: RetryRecord[];
      providerCalls?: CallRecord[];
      providerCallCount?: number;
    };
    const retries = metadata.retries ?? [];
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ attempt: 1, nextAttempt: 2, code: "HTTP_STATUS" });
    expect(retries[1]).toMatchObject({ attempt: 2, nextAttempt: 3, code: "HTTP_STATUS" });
    expect(retries[0]!.delayMs).toBeGreaterThan(0);

    const calls = metadata.providerCalls ?? [];
    expect(metadata.providerCallCount).toBe(3);
    expect(calls.map((call) => call.status)).toEqual([500, 500, 200]);
    expect(calls[0]).toMatchObject({ provider: "http", method: "POST", ok: false, error: "HTTP_500" });
    /* The URL arrives scrubbed — no secret query value, no raw token. */
    expect(calls[0]!.url).not.toContain("super-secret");
    expect(calls[0]!.url).toContain("api_key=");
    expect(calls[0]!.url).toContain("%E2%80%A2");

    const retryEvents = eventsOfType(started.id, "execution.node.retrying");
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0]).toMatchObject({ nodeId: "http1", attempt: 1, nextAttempt: 2 });
    expect(retryEvents[0]!.error).toMatchObject({ code: "HTTP_STATUS" });

    /* Run input is scrubbed on the way in, and again on the way out. */
    expect(finished.input).toMatchObject({ authorization: "••••", author: "Ada" });
    expect(JSON.stringify(finished.input)).not.toContain("top-secret-token");
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Waiting                                                             */
/* ------------------------------------------------------------------ */

describe("waiting", () => {
  it("reports the park and the resume while a delay is running", async () => {
    const definition = workflow(
      "wf_wait",
      [
        node("t", "trigger.manual"),
        node("delay1", "logic.delay", { duration: "custom", custom: 600 }),
        node("log1", "action.log", { message: "done" }),
      ],
      [edge("t", "delay1"), edge("delay1", "log1")],
    );

    /* Kick the run off without awaiting: the window we are asserting on
       only exists while the engine is inside the delay. */
    const pending = startWorkflowRun(actor, { definition, source: "manual" });
    const startedId = await findLatestExecution("wf_wait");
    const observed = await waitForStepStatus(startedId, "delay1", "waiting");
    expect(observed).toBe(true);

    const started = await pending;
    expect(started.id).toBe(startedId);

    const finished = await settle(startedId);
    expect(finished.status).toBe("completed");
    expect(stepFor(finished, "delay1").status).toBe("completed");

    const waitingEvents = eventsOfType(startedId, "execution.node.waiting");
    expect(waitingEvents.map((event) => event.waiting)).toEqual([true, false]);

    const statusEvents = eventsOfType(startedId, "execution.status");
    expect(statusEvents.map((event) => event.status)).toContain("waiting");
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Definition + rerun endpoints                                        */
/* ------------------------------------------------------------------ */

describe("definition endpoint", () => {
  it("serves the pinned graph this run actually used", async () => {
    const definition = workflow(
      "wf_pinned",
      [node("t", "trigger.manual"), node("log1", "action.log", { message: "hi" })],
      [edge("t", "log1")],
    );
    const started = await startWorkflowRun(actor, { definition, source: "manual" });
    await settle(started.id);

    const view = getExecutionDefinitionFor(actor, started.id);
    expect(view.workflowId).toBe("wf_pinned");
    expect(view.workflowVersion).toBe(1);
    expect(view.name).toBe("Test wf_pinned");
    expect(view.nodes.map((item) => item.id)).toEqual(["t", "log1"]);
    expect(view.edges.map((item) => item.id)).toEqual(["e_t_log1"]);
  }, 30_000);

  it("404s for an execution the workspace does not own", () => {
    expect(() => getExecutionDefinitionFor(actor, "ex_missing")).toThrowError(HttpError);
    try {
      getExecutionDefinitionFor(actor, "ex_missing");
    } catch (error) {
      expect((error as HttpError).status).toBe(404);
    }
  });
});

describe("rerun endpoint", () => {
  it("replays the pinned version and input into a new run", async () => {
    const definition = workflow(
      "wf_rerun",
      [node("t", "trigger.manual"), node("log1", "action.log", { message: "second pass" })],
      [edge("t", "log1")],
    );
    const original = await startWorkflowRun(actor, {
      definition,
      input: { note: "first pass", authorization: "Bearer secret" },
      source: "manual",
    });
    const originalFinished = await settle(original.id);

    const clone = await rerunExecutionFor(actor, original.id);

    expect(clone.id).not.toBe(original.id);
    expect(clone.workflowId).toBe(originalFinished.workflowId);
    expect(clone.workflowVersion).toBe(originalFinished.workflowVersion);
    expect(clone.input).toEqual(originalFinished.input);
    expect(clone.trigger).toEqual(originalFinished.trigger);

    const finished = await settle(clone.id);
    expect(finished.status).toBe("completed");

    /* History is append-only: the original record is untouched. */
    const stillThere = getExecutionDetailFor(actor, original.id);
    expect(stillThere.status).toBe("completed");
    expect(stillThere.completedAt).toBe(originalFinished.completedAt);
    expect(stillThere.steps).toHaveLength(originalFinished.steps.length);
  }, 30_000);

  it("refuses to rerun a run it cannot find", async () => {
    await expect(rerunExecutionFor(actor, "ex_missing")).rejects.toThrowError(HttpError);
  });
});

/* ------------------------------------------------------------------ */
/* Steps with no declared reference                                    */
/* ------------------------------------------------------------------ */

/*
 * A graph is allowed to name its nodes (the editor always does), but the
 * server must not care. `ref` is what lands in `execution_steps` and what
 * `{{...}}` looks up, so an unnamed node falls back to its own id — the
 * same thing the browser-side run path already does. Without that, the
 * first INSERT of the step dies with "cannot be bound to SQLite
 * parameter 7" and the whole run reports ENGINE_ERROR.
 */
describe("steps with no data.ref", () => {
  const bare = (id: string, type: string, config: Record<string, unknown> = {}): TestNode =>
    ({ id, type, position: { x: 0, y: 0 }, data: { config } }) as unknown as TestNode;

  it("runs the graph and falls back to the node id as the step ref", async () => {
    const definition = workflow(
      "wf_anon_refs",
      [bare("t", "trigger.manual"), bare("log1", "action.log", { message: "hi" })],
      [edge("t", "log1")],
    );

    const started = await startWorkflowRun(actor, { definition, source: "manual" });
    const finished = await settle(started.id);

    expect(finished.status).toBe("completed");
    expect(finished.steps.map((step) => `${step.nodeId}:${step.ref}`)).toEqual([
      "t:t",
      "log1:log1",
    ]);
  }, 30_000);
});
