import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Integration tests for the execution service + engine against a real
 * (temporary) SQLite database. Every run here goes through the same
 * path the API route uses: validate → version → insert → engine →
 * persist. No mocks, no fakes — the durable store is the assertion
 * surface.
 */

const tmpDir = mkdtempSync(join(tmpdir(), "klyz-test-"));
process.env.KLYZ_DB_PATH = join(tmpDir, "klyz.db");

import { HttpError } from "./http";
import { defaultActor } from "./identity";
import { getDb, queryAll, queryOne } from "./db";
import {
  cancelExecutionFor,
  getExecutionDetailFor,
  listExecutionsFor,
  startExecutionFor,
} from "./execution-service";
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

type TestNode = Workflow["nodes"][number];
type TestEdge = Workflow["edges"][number];

function node(id: string, type: string, config: Record<string, unknown> = {}, ref = id): TestNode {
  return { id, type, position: { x: 0, y: 0 }, data: { ref, config } };
}

function edge(source: string, target: string, branch?: string): TestEdge {
  return {
    id: `e_${source}_${target}_${branch ?? "plain"}`,
    source,
    target,
    data: branch ? { branch } : undefined,
  };
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

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runToCompletion(definition: Workflow): Promise<ExecutionDetail> {
  const started = await startExecutionFor(actor, definition.id, {
    definition,
  });
  await waitFor(() => {
    const status = getExecutionDetailFor(actor, started.id).status;
    return status === "completed" || status === "failed" || status === "cancelled";
  }, `execution ${started.id} to settle`);
  return getExecutionDetailFor(actor, started.id);
}

function stepByNode(execution: ExecutionDetail, nodeId: string) {
  return execution.steps.find((step) => step.nodeId === nodeId);
}

/* ------------------------------------------------------------------ */

describe("linear execution", () => {
  it("runs trigger → set values → log and records every step", async () => {
    const definition = workflow(
      "wf_test_linear",
      [
        node("t", "trigger.manual", {}),
        node("vars", "data.variables", {
          values: [{ id: "1", key: "flag", value: "on" }],
        }),
        node("log", "action.log", { message: "ran {{vars.vars.flag}}" }),
      ],
      [edge("t", "vars"), edge("vars", "log")],
    );

    const execution = await runToCompletion(definition);

    expect(execution.status).toBe("completed");
    expect(execution.error).toBeUndefined();
    expect(execution.steps.map((step) => step.nodeId)).toEqual(["t", "vars", "log"]);
    expect(execution.steps.every((step) => step.status === "completed")).toBe(true);
    expect(execution.stepCount).toBe(3);
    expect(execution.failedStepCount).toBe(0);

    const logStep = stepByNode(execution, "log");
    expect(logStep?.output).toMatchObject({ message: "ran on", level: "info" });
    expect(execution.output).toMatchObject({ message: "ran on" });

    /* Durations and attempts are real, persisted values. */
    expect(execution.durationMs).toBeGreaterThanOrEqual(0);
    expect(logStep?.attempt).toBe(1);
    expect(logStep?.startedAtMs).not.toBeNull();
    expect(logStep?.completedAtMs).not.toBeNull();
  });
});

describe("condition branches", () => {
  const build = (id: string, right: string): Workflow =>
    workflow(
      id,
      [
        node("t", "trigger.manual", {}),
        node("cond", "logic.condition", {
          left: "yes",
          operator: "eq",
          right,
        }),
        node("yes", "action.log", { message: "true path" }),
        node("no", "action.log", { message: "false path" }),
      ],
      [
        edge("t", "cond"),
        edge("cond", "yes", "true"),
        edge("cond", "no", "false"),
      ],
    );

  it("takes the true branch and skips the false one", async () => {
    const execution = await runToCompletion(build("wf_test_branch_true", "yes"));

    expect(execution.status).toBe("completed");
    expect(stepByNode(execution, "cond")?.branch).toBe("true");
    expect(stepByNode(execution, "yes")?.status).toBe("completed");
    expect(stepByNode(execution, "no")?.status).toBe("skipped");
    expect(execution.output).toMatchObject({ message: "true path" });
    expect(execution.metadata).toMatchObject({ completedCount: 3, skippedCount: 1 });
  });

  it("takes the false branch and skips the true one", async () => {
    const execution = await runToCompletion(build("wf_test_branch_false", "no"));

    expect(execution.status).toBe("completed");
    expect(stepByNode(execution, "cond")?.branch).toBe("false");
    expect(stepByNode(execution, "yes")?.status).toBe("skipped");
    expect(stepByNode(execution, "no")?.status).toBe("completed");
    expect(execution.output).toMatchObject({ message: "false path" });
    expect(execution.metadata).toMatchObject({ completedCount: 3, skippedCount: 1 });
  });
});

describe("filter refusal", () => {
  const build = (id: string): Workflow =>
    workflow(
      id,
      [
        node("t", "trigger.manual", {}),
        node("gate", "logic.filter", {
          expression: '{{trigger.payload.keep}} == "yes"',
        }),
        node("after", "action.log", { message: "should not run" }),
      ],
      [edge("t", "gate"), edge("gate", "after")],
    );

  async function runWith(definition: Workflow, keep: string): Promise<ExecutionDetail> {
    const started = await startExecutionFor(actor, definition.id, {
      definition,
      input: { keep },
    });
    await waitFor(() => {
      const status = getExecutionDetailFor(actor, started.id).status;
      return status === "completed" || status === "failed" || status === "cancelled";
    }, `filter execution ${started.id} to settle`);
    return getExecutionDetailFor(actor, started.id);
  }

  it("records a refused step as skipped without writing it twice", async () => {
    const execution = await runWith(build("wf_test_filter_skip"), "no");

    expect(execution.status).toBe("completed");
    expect(execution.error).toBeUndefined();
    expect(stepByNode(execution, "gate")?.status).toBe("skipped");
    expect(stepByNode(execution, "after")?.status).toBe("skipped");
    expect(execution.metadata).toMatchObject({ completedCount: 1, skippedCount: 2 });
    expect(execution.stepCount).toBe(3);
    expect(
      queryAll("SELECT node_id FROM execution_steps WHERE execution_id = ?", execution.id).length,
    ).toBe(3);
    expect(
      queryOne<{ status: string }>(
        "SELECT status FROM execution_steps WHERE execution_id = ? AND node_id = ?",
        execution.id,
        "gate",
      )?.status,
    ).toBe("skipped");
  });

  it("keeps the step complete when the data passes", async () => {
    const execution = await runWith(build("wf_test_filter_pass"), "yes");

    expect(execution.status).toBe("completed");
    expect(stepByNode(execution, "gate")?.status).toBe("completed");
    expect(stepByNode(execution, "after")?.status).toBe("completed");
    expect(execution.metadata).toMatchObject({ completedCount: 3, skippedCount: 0 });
  });
});

describe("failure", () => {
  it("stops at the first failing node and never fakes success", async () => {
    const definition = workflow(
      "wf_test_failure",
      [
        node("t", "trigger.manual", {}),
        /* A registered node that cannot do its job — the engine must
           fail loudly rather than fake a pass. */
        node("parse", "data.json", { mode: "parse", source: "not json" }),
        node("after", "action.log", { message: "never runs" }),
      ],
      [edge("t", "parse"), edge("parse", "after")],
    );

    const execution = await runToCompletion(definition);

    expect(execution.status).toBe("failed");
    expect(execution.error?.code).toBe("CONFIG_INVALID");

    const filterStep = stepByNode(execution, "parse");
    expect(filterStep?.status).toBe("failed");
    expect(filterStep?.error?.code).toBe("CONFIG_INVALID");
    expect(stepByNode(execution, "t")?.status).toBe("completed");

    /* The unstarted downstream node has no step row — not a fake pass. */
    expect(stepByNode(execution, "after")).toBeUndefined();
    expect(execution.stepCount).toBe(2);
    expect(execution.failedStepCount).toBe(1);
    expect(execution.output).toEqual({ payload: {} });
  });
});

describe("cancellation", () => {
  it("aborts a waiting delay and settles the run as cancelled", async () => {
    const definition = workflow(
      "wf_test_cancel",
      [
        node("t", "trigger.manual", {}),
        node("wait", "logic.delay", { duration: "custom", custom: 30_000 }),
        node("after", "action.log", { message: "never runs" }),
      ],
      [edge("t", "wait"), edge("wait", "after")],
    );

    const started = await startExecutionFor(actor, definition.id, { definition });
    await waitFor(
      () => getExecutionDetailFor(actor, started.id).status === "waiting",
      "delay to enter waiting",
    );

    const cancelled = await cancelExecutionFor(actor, started.id);
    expect(cancelled.accepted).toBe(true);

    await waitFor(() => {
      const status = getExecutionDetailFor(actor, started.id).status;
      return status === "cancelled";
    }, "execution to cancel");

    const execution = getExecutionDetailFor(actor, started.id);
    expect(execution.status).toBe("cancelled");
    expect(execution.error?.code).toBe("CANCELLED");
    expect(stepByNode(execution, "wait")?.status).toBe("failed");
    expect(stepByNode(execution, "wait")?.error?.code).toBe("CANCELLED");
    expect(stepByNode(execution, "after")).toBeUndefined();
  });

  it("refuses to cancel an execution that already finished", async () => {
    const definition = workflow(
      "wf_test_cancel_finished",
      [node("t", "trigger.manual", {}), node("log", "action.log", { message: "done" })],
      [edge("t", "log")],
    );
    const execution = await runToCompletion(definition);
    expect(execution.status).toBe("completed");

    try {
      await cancelExecutionFor(actor, execution.id);
      expect.fail("cancelling a finished execution should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(409);
      expect((error as HttpError).code).toBe("ALREADY_FINISHED");
    }
  });
});

describe("workflow versioning", () => {
  it("keeps v1 immutable when the definition changes, then creates v2", async () => {
    const id = "wf_test_versions";
    const v1 = workflow(
      id,
      [node("t", "trigger.manual", {}), node("log", "action.log", { message: "first" })],
      [edge("t", "log")],
    );

    const runOne = await runToCompletion(v1);
    expect(runOne.status).toBe("completed");
    expect(runOne.workflowVersion).toBe(1);

    /* Same definition again → deduped onto the same version. */
    const runTwo = await runToCompletion(v1);
    expect(runTwo.workflowVersion).toBe(1);

    const v2: Workflow = {
      ...v1,
      nodes: [
        node("t", "trigger.manual", {}),
        node("log", "action.log", { message: "second" }),
      ],
    };
    const runThree = await runToCompletion(v2);
    expect(runThree.status).toBe("completed");
    expect(runThree.workflowVersion).toBe(2);

    const versions = queryAll<{ version: number; definition: string }>(
      "SELECT version, definition FROM workflow_versions WHERE workflow_id = ? ORDER BY version",
      id,
    );
    expect(versions).toHaveLength(2);

    const storedV1 = JSON.parse(versions[0]!.definition) as Workflow;
    expect(
      (storedV1.nodes.find((item) => item.id === "log")?.data.config as { message: string })
        .message,
    ).toBe("first");

    const storedV2 = JSON.parse(versions[1]!.definition) as Workflow;
    expect(
      (storedV2.nodes.find((item) => item.id === "log")?.data.config as { message: string })
        .message,
    ).toBe("second");
  });
});

describe("validation gate", () => {
  it("rejects a workflow with no trigger and creates no execution", async () => {
    const definition = workflow(
      "wf_test_invalid",
      [node("log", "action.log", { message: "orphan" })],
      [],
    );

    await expect(startExecutionFor(actor, definition.id, { definition })).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
    });

    const rows = listExecutionsFor(
      actor,
      new URLSearchParams({ workflowId: definition.id }),
    );
    expect(rows.total).toBe(0);
    const versions = queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM workflow_versions WHERE workflow_id = ?",
      definition.id,
    );
    expect(versions?.count).toBe(0);
  });

  it("rejects an empty workflow with a specific error", async () => {
    const definition = workflow("wf_test_empty", [], []);
    await expect(startExecutionFor(actor, definition.id, { definition })).rejects.toBeInstanceOf(
      HttpError,
    );
    await expect(
      startExecutionFor(actor, definition.id, { definition }),
    ).rejects.toMatchObject({ status: 422, code: "EMPTY_WORKFLOW" });
  });
});

describe("workspace ownership", () => {
  it("hides executions from other workspaces", async () => {
    const definition = workflow(
      "wf_test_owned",
      [node("t", "trigger.manual", {}), node("log", "action.log", { message: "mine" })],
      [edge("t", "log")],
    );
    const execution = await runToCompletion(definition);

    const intruder = { userId: "u_default", workspaceId: "ws_other" };
    try {
      getExecutionDetailFor(intruder, execution.id);
      expect.fail("another workspace should not see this execution");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(404);
    }

    const foreignList = listExecutionsFor(
      intruder,
      new URLSearchParams({ workflowId: definition.id }),
    );
    expect(foreignList.total).toBe(0);
  });
});

describe("seed honesty", () => {
  it("marks every seeded execution as development data", async () => {
    const seeds = listExecutionsFor(actor, new URLSearchParams({ source: "seed", limit: "5" }));
    expect(seeds.total).toBeGreaterThan(0);

    const detail = getExecutionDetailFor(actor, seeds.executions[0]!.id);
    expect(detail.source).toBe("seed");
    expect(detail.metadata.seed).toBe(true);
  });

  it("never marks engine-written executions as seed", async () => {
    const manual = listExecutionsFor(actor, new URLSearchParams({ source: "manual" }));
    expect(manual.executions.every((row) => row.source === "manual")).toBe(true);
    expect(manual.total).toBeGreaterThanOrEqual(4);
  });
});

describe("manual run payload", () => {
  const definition = workflow(
    "wf_test_payload",
    [
      node("t", "trigger.manual", {}),
      node("loop", "logic.loop", { over: "{{trigger.payload.items}}" }),
      node("log", "action.log", { message: "item {{loop.item}}" }),
    ],
    [edge("t", "loop"), edge("loop", "log")],
  );

  it("stores the payload on the execution and hands it to the loop", async () => {
    const started = await startExecutionFor(actor, definition.id, {
      definition,
      input: { items: ["alpha", "beta"] },
    });
    await waitFor(() => {
      const status = getExecutionDetailFor(actor, started.id).status;
      return status === "completed" || status === "failed" || status === "cancelled";
    }, "payload execution to settle");

    const execution = getExecutionDetailFor(actor, started.id);
    expect(execution.status).toBe("completed");
    expect(execution.input).toEqual({ items: ["alpha", "beta"] });

    const loop = stepByNode(execution, "loop");
    expect(loop?.output).toMatchObject({ count: 2 });
    expect((loop?.output as { results: unknown[] }).results).toHaveLength(2);

    const logs = execution.steps.filter((step) => step.nodeId === "log");
    expect(logs.map((step) => step.output)).toHaveLength(2);
    expect(logs.map((step) => (step.output as { message: string }).message)).toEqual([
      "item alpha",
      "item beta",
    ]);
  });

  it("runs with an empty payload when none is supplied", async () => {
    const started = await startExecutionFor(actor, definition.id, { definition });
    await waitFor(() => {
      const status = getExecutionDetailFor(actor, started.id).status;
      return status === "completed" || status === "failed" || status === "cancelled";
    }, "no-payload execution to settle");

    const execution = getExecutionDetailFor(actor, started.id);
    expect(execution.status).toBe("completed");
    /* No payload supplied → the row keeps `null`, the scope gets `{}`. */
    expect(execution.input ?? {}).toEqual({});
    expect(stepByNode(execution, "loop")?.output).toMatchObject({ count: 0 });
  });
});

describe("run history listing", () => {
  it("returns a full page when no limit parameter is supplied", async () => {
    const definition = workflow(
      "wf_test_list_page",
      [node("t", "trigger.manual", {}), node("log", "action.log", { message: "page" })],
      [edge("t", "log")],
    );
    await runToCompletion(definition);
    await runToCompletion(definition);

    const page = listExecutionsFor(
      actor,
      new URLSearchParams({ workflowId: definition.id }),
    );
    expect(page.total).toBe(2);
    expect(page.executions).toHaveLength(2);

    const capped = listExecutionsFor(
      actor,
      new URLSearchParams({ workflowId: definition.id, limit: "1" }),
    );
    expect(capped.total).toBe(2);
    expect(capped.executions).toHaveLength(1);
  });
});
