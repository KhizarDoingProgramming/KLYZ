import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { applyEvent, createPlan } from "@/lib/execution/projector";
import type { EngineEvent } from "@/lib/execution/events";
import type { ExecutionPlan, ExecutionPlanEdge, ExecutionStepView } from "@/lib/execution/types";
import type { Workflow } from "@/lib/workflow/types";
import { aiEnabled } from "@/lib/config/env";

/*
 * Engine tests for the run-control nodes: Loop, Filter and JSON.
 *
 * They assert on the recorded steps rather than on logs, because a
 * step row is what the debugger, the API and the canvas all read.
 */

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

function workflow(nodes: TestNode[], edges: TestEdge[]): Workflow {
  return {
    id: "wf_loop",
    name: "Loop test",
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

interface RunOutcome {
  status: "completed" | "failed" | "cancelled";
  output: unknown;
  error?: { code: string; message: string };
  metadata: Record<string, unknown>;
  steps: ExecutionStepView[];
  events: EngineEvent[];
  plan: ExecutionPlan;
}

async function run(definition: Workflow, input?: unknown): Promise<RunOutcome> {
  const events: EngineEvent[] = [];
  let plan = createPlan(edgesOf(definition));
  const result = await executeWorkflow({
    executionId: "exec_test",
    workspaceId: "ws_default",
    workflow: definition,
    workflowVersionId: "ver_1",
    workflowVersion: 1,
    input: input ?? {},
    emit: (event) => {
      events.push(event);
      plan = applyEvent(plan, event);
    },
    signal: new AbortController().signal,
  });
  return { ...result, events, plan };
}

function edgesOf(definition: Workflow): ExecutionPlanEdge[] {
  return definition.edges.map((item) => ({
    id: item.id,
    source: item.source,
    target: item.target,
    branch: item.data?.branch,
  }));
}

function stepsOf(outcome: RunOutcome, nodeId: string): ExecutionStepView[] {
  return outcome.steps.filter((step) => step.nodeId === nodeId);
}

function oneStep(outcome: RunOutcome, nodeId: string): ExecutionStepView {
  const step = outcome.steps.find((item) => item.nodeId === nodeId);
  if (!step) throw new Error(`expected a step for "${nodeId}", found none`);
  return step;
}

/* ------------------------------------------------------------------ */

describe("logic.loop", () => {
  it("runs the body once per item and records a step per iteration", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("loop", "logic.loop", { over: "{{trigger.payload.items}}" }),
          node("set", "data.variables", {
            values: [{ id: "1", key: "seen", value: "{{loop.item}}" }],
          }),
          node("other", "data.variables", {
            values: [{ id: "1", key: "kind", value: "outside" }],
          }),
          node("after", "action.log", { message: "ran {{loop.count}}" }),
        ],
        [
          edge("t", "loop"),
          edge("loop", "set"),
          edge("loop", "after"),
          edge("t", "other"),
          edge("other", "after"),
          edge("set", "after"),
        ],
      ),
      { items: ["alpha", "beta", "gamma"] },
    );

    expect(outcome.status).toBe("completed");

    /* The body is owned by the loop: one recorded step per iteration. */
    const iterations = stepsOf(outcome, "set");
    expect(iterations).toHaveLength(3);
    expect(iterations.map((step) => step.metadata?.iteration)).toEqual(["0", "1", "2"]);
    expect(iterations.map((step) => (step.output as { vars: { seen: unknown } }).vars.seen)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(iterations.every((step) => step.status === "completed")).toBe(true);

    /* A join outside the body runs exactly once, after the loop. */
    expect(stepsOf(outcome, "after")).toHaveLength(1);
    expect(stepsOf(outcome, "other")).toHaveLength(1);

    const loopStep = oneStep(outcome, "loop");
    expect(loopStep.status).toBe("completed");
    expect(loopStep.output).toEqual({
      results: [
        { vars: { seen: "alpha" } },
        { vars: { seen: "beta" } },
        { vars: { seen: "gamma" } },
      ],
      count: 3,
    });

    expect(outcome.metadata).toMatchObject({ nodeCount: 5, stepCount: 7, completedCount: 7 });
  });

  it("keeps every iteration as its own step in the projected plan", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("loop", "logic.loop", { over: "{{trigger.payload.items}}" }),
          node("set", "data.variables", {
            values: [{ id: "1", key: "seen", value: "{{loop.item}}" }],
          }),
        ],
        [edge("t", "loop"), edge("loop", "set")],
      ),
      { items: [1, 2, 3, 4] },
    );

    const projected = outcome.plan.steps.filter((step) => step.nodeId === "set");
    expect(projected).toHaveLength(4);
    expect(new Set(projected.map((step) => step.id)).size).toBe(4);
    expect(projected.every((step) => step.status === "completed")).toBe(true);
    expect(outcome.plan.nodeStates["set"]).toBe("completed");
  });

  it("batches items when the mode says so", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("loop", "logic.loop", {
            over: "{{trigger.payload.items}}",
            mode: "batched",
            batchSize: 2,
          }),
          node("set", "data.variables", {
            values: [{ id: "1", key: "size", value: "{{length(loop.item)}}" }],
          }),
        ],
        [edge("t", "loop"), edge("loop", "set")],
      ),
      { items: [1, 2, 3, 4, 5] },
    );

    expect(outcome.status).toBe("completed");
    const iterations = stepsOf(outcome, "set");
    expect(iterations).toHaveLength(3);
    expect(
      iterations.map((step) => (step.output as { vars: { size: unknown } }).vars.size),
    ).toEqual([2, 2, 1]);
  });

  it("refuses a list longer than the configured cap instead of running forever", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("loop", "logic.loop", {
            over: "{{trigger.payload.items}}",
            maxItems: 3,
          }),
          node("set", "data.variables", {
            values: [{ id: "1", key: "seen", value: "{{loop.item}}" }],
          }),
        ],
        [edge("t", "loop"), edge("loop", "set")],
      ),
      { items: [1, 2, 3, 4] },
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("LOOP_TOO_LARGE");
    expect(oneStep(outcome, "loop").status).toBe("failed");
    expect(stepsOf(outcome, "set")).toHaveLength(0);
  });

  it("settles the loop as failed when a step inside the body fails", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("loop", "logic.loop", { over: "{{trigger.payload.items}}" }),
          node("boom", "action.not_a_real_node", {}),
        ],
        [edge("t", "loop"), edge("loop", "boom")],
      ),
      { items: [1, 2] },
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("NODE_NOT_IMPLEMENTED");
    expect(oneStep(outcome, "loop").status).toBe("failed");
    expect(oneStep(outcome, "boom").status).toBe("failed");
    expect(oneStep(outcome, "boom").metadata?.iteration).toBe("0");
    expect(outcome.metadata).toMatchObject({ completedCount: 1, failedCount: 2 });
  });

  it("runs a nested loop over each slice of the outer list", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("outer", "logic.loop", { over: "{{trigger.payload.groups}}" }),
          node("inner", "logic.loop", { over: "{{outer.item}}" }),
          node("set", "data.variables", {
            values: [{ id: "1", key: "n", value: "{{inner.item}}" }],
          }),
        ],
        [edge("t", "outer"), edge("outer", "inner"), edge("inner", "set")],
      ),
      { groups: [[1, 2], [3]] },
    );

    expect(outcome.status).toBe("completed");
    const iterations = stepsOf(outcome, "set");
    expect(iterations.map((step) => step.metadata?.iteration)).toEqual(["0.0", "0.1", "1.0"]);
    expect(
      iterations.map((step) => (step.output as { vars: { n: unknown } }).vars.n),
    ).toEqual([1, 2, 3]);

    const outer = oneStep(outcome, "outer");
    expect(outer.output).toMatchObject({ count: 2 });
    const inners = stepsOf(outcome, "inner");
    expect(inners).toHaveLength(2);
    /* The inner loop's own row is labelled with the outer pass it ran in. */
    expect(inners.map((step) => step.metadata?.iteration)).toEqual(["0", "1"]);
  });
});

describe("logic.filter", () => {
  it("stops the branch silently when the expression is not truthy", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("keep", "logic.filter", {
            expression: '{{trigger.payload.keep}} == "yes"',
          }),
          node("after", "action.log", { message: "should not run" }),
        ],
        [edge("t", "keep"), edge("keep", "after")],
      ),
      { keep: "no" },
    );

    expect(outcome.status).toBe("completed");
    expect(oneStep(outcome, "keep").status).toBe("skipped");
    expect(oneStep(outcome, "after").status).toBe("skipped");
    expect(oneStep(outcome, "after").output).toBeNull();
    expect(outcome.metadata).toMatchObject({ skippedCount: 2, completedCount: 1 });
    expect(outcome.plan.nodeStates["after"]).toBe("skipped");
  });

  it("lets the branch through when the expression holds", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("keep", "logic.filter", {
            expression: '{{trigger.payload.keep}} == "yes"',
          }),
          node("after", "action.log", { message: "ran" }),
        ],
        [edge("t", "keep"), edge("keep", "after")],
      ),
      { keep: "yes" },
    );

    expect(outcome.status).toBe("completed");
    expect(oneStep(outcome, "keep").status).toBe("completed");
    expect(stepsOf(outcome, "after")).toHaveLength(1);
    expect(outcome.metadata).toMatchObject({ skippedCount: 0, completedCount: 3 });
  });

  it("ends the whole run when configured to stop instead of skip", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("keep", "logic.filter", {
            expression: '{{trigger.payload.keep}} == "yes"',
            onSkip: "stop",
          }),
          node("after", "action.log", { message: "should not run" }),
        ],
        [edge("t", "keep"), edge("keep", "after")],
      ),
      { keep: "no" },
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.output).toEqual({ passed: false });
    expect(stepsOf(outcome, "after")).toHaveLength(0);
  });

  it("fails loudly on an expression that cannot be evaluated", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("keep", "logic.filter", { expression: "leftover(" }),
        ],
        [edge("t", "keep")],
      ),
      {},
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("CONDITION_INVALID");
  });
});

describe("data.json", () => {
  it("parses text into a value", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("parse", "data.json", {
            mode: "parse",
            source: "{{trigger.payload.text}}",
          }),
        ],
        [edge("t", "parse")],
      ),
      { text: '{"a":1}' },
    );

    expect(outcome.status).toBe("completed");
    expect(oneStep(outcome, "parse").output).toEqual({ value: { a: 1 } });
  });

  it("serialises a value back to text", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("vars", "data.variables", {
            values: [{ id: "1", key: "obj", value: "{{trigger.payload.obj}}" }],
          }),
          node("stringify", "data.json", {
            mode: "stringify",
            source: "{{vars.vars.obj}}",
          }),
        ],
        [edge("t", "vars"), edge("vars", "stringify")],
      ),
      { obj: { a: 1 } },
    );

    expect(outcome.status).toBe("completed");
    expect(oneStep(outcome, "stringify").output).toEqual({ value: '{"a":1}' });
  });

  it("fails loudly when the text is not JSON", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("parse", "data.json", { mode: "parse", source: "{{trigger.payload.text}}" }),
        ],
        [edge("t", "parse")],
      ),
      { text: "not json" },
    );

    expect(outcome.status).toBe("failed");
    expect(oneStep(outcome, "parse").error?.code).toBe("CONFIG_INVALID");
  });
});

describe("AI steps", () => {
  it("never fakes a result when no provider key is configured", async () => {
    const outcome = await run(
      workflow(
        [
          node("t", "trigger.manual", {}),
          node("sum", "ai.summarize", { input: "{{trigger.payload.text}}", length: "short" }),
        ],
        [edge("t", "sum")],
      ),
      { text: "a very long article" },
    );

    if (aiEnabled()) {
      /* A key is present in this environment — the step must not be
         asserted against, only that it never silently passes. */
      expect(["completed", "failed"]).toContain(outcome.status);
      return;
    }
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("AI_NOT_CONFIGURED");
    expect(oneStep(outcome, "sum").error?.code).toBe("AI_NOT_CONFIGURED");
  });
});
