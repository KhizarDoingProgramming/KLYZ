import { describe, expect, it } from "vitest";
import {
  applyEvent,
  createPlan,
  deriveStates,
  isTerminal,
  planFromExecution,
} from "./projector";
import type { EngineEvent } from "./events";
import { stepVisualState } from "./debugger";
import type { ExecutionDetail, ExecutionStepView } from "./types";

function step(nodeId: string, overrides: Partial<ExecutionStepView> = {}): ExecutionStepView {
  return {
    id: `st_${nodeId}`,
    nodeId,
    nodeType: "action.log",
    nodeLabel: `Step ${nodeId}`,
    ref: nodeId,
    status: "pending",
    attempt: 0,
    startedAtMs: null,
    completedAtMs: null,
    durationMs: 0,
    input: null,
    output: null,
    ...overrides,
  };
}

const started = (nodeId: string): EngineEvent => ({
  type: "execution.node.started",
  executionId: "ex_1",
  step: step(nodeId, { status: "running", attempt: 1, startedAtMs: 10 }),
  at: 10,
});

const completed = (nodeId: string, branch: string | null = null): EngineEvent => ({
  type: "execution.node.completed",
  executionId: "ex_1",
  stepId: `st_${nodeId}`,
  nodeId,
  nodeType: "action.log",
  nodeLabel: `Step ${nodeId}`,
  ref: nodeId,
  durationMs: 5,
  output: { ok: true },
  branch,
  attempt: 1,
  at: 15,
});

describe("createPlan", () => {
  it("copies the skeleton and starts queued", () => {
    const skeleton = [step("a"), step("b")];
    const plan = createPlan([{ id: "e1", source: "a", target: "b" }], skeleton);
    expect(plan.status).toBe("queued");
    expect(plan.revealed).toBe(0);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).not.toBe(skeleton[0]);
  });
});

describe("applyEvent", () => {
  it("folds started → completed into step records", () => {
    let plan = createPlan([], [step("a")]);
    plan = applyEvent(plan, { type: "execution.started", executionId: "ex_1" } as EngineEvent);
    expect(plan.status).toBe("running");

    plan = applyEvent(plan, started("a"));
    expect(plan.steps[0]?.status).toBe("running");

    plan = applyEvent(plan, completed("a"));
    expect(plan.steps[0]?.status).toBe("completed");
    expect(plan.steps[0]?.durationMs).toBe(5);
    expect(plan.revealed).toBe(1);
  });

  it("appends steps that were never in the plan (snapshot-less consumers)", () => {
    let plan = createPlan([], []);
    plan = applyEvent(plan, started("late"));
    expect(plan.steps).toHaveLength(1);
    plan = applyEvent(plan, completed("late"));
    expect(plan.steps[0]?.status).toBe("completed");

    plan = applyEvent(plan, {
      type: "execution.node.skipped",
      executionId: "ex_1",
      stepId: "st_skipped",
      nodeId: "branch",
      nodeType: "action.log",
      nodeLabel: "Branch step",
      ref: "branch",
      at: 20,
    } satisfies EngineEvent);
    expect(plan.steps.map((item) => item.nodeId)).toEqual(["late", "branch"]);
    expect(plan.steps[1]?.status).toBe("skipped");
  });

  it("marks failures and stamps terminal timing", () => {
    let plan = createPlan([], [step("a")]);
    plan = applyEvent(plan, started("a"));
    plan = applyEvent(plan, {
      type: "execution.node.failed",
      executionId: "ex_1",
      stepId: "st_a",
      nodeId: "a",
      nodeType: "action.log",
      nodeLabel: "Step a",
      ref: "a",
      durationMs: 7,
      error: { code: "STEP_FAILED", message: "boom" },
      attempt: 1,
      at: 17,
    } satisfies EngineEvent);
    expect(plan.steps[0]?.status).toBe("failed");

    plan = applyEvent(plan, {
      type: "execution.failed",
      executionId: "ex_1",
      status: "failed",
      durationMs: 42,
      output: null,
      error: { code: "STEP_FAILED", message: "boom" },
      metadata: {},
      completedAt: new Date(0).toISOString(),
      at: 42,
    } satisfies EngineEvent);
    expect(plan.status).toBe("failed");
    expect(plan.durationMs).toBe(42);
    expect(isTerminal(plan.status)).toBe(true);
  });
});

describe("deriveStates", () => {
  it("derives edge state from target progress", () => {
    const states = deriveStates(
      [
        step("a", { status: "completed" }),
        step("b", { status: "running" }),
        step("c", { status: "pending" }),
      ],
      [
        { id: "ab", source: "a", target: "b" },
        { id: "ac", source: "a", target: "c" },
      ],
    );
    expect(states.edgeStates.ab).toBe("active");
    expect(states.edgeStates.ac).toBe("completed");
    expect(states.nodeStates.b).toBe("running");
    expect(states.revealed).toBe(1);
  });

  it("marks only the matching condition branch as taken", () => {
    const states = deriveStates(
      [
        step("cond", { status: "completed", branch: "true" }),
        step("yes", { status: "pending" }),
        step("no", { status: "pending" }),
      ],
      [
        { id: "c-yes", source: "cond", target: "yes", branch: "true" },
        { id: "c-no", source: "cond", target: "no", branch: "false" },
      ],
    );
    expect(states.edgeStates["c-yes"]).toBe("completed");
    expect(states.edgeStates["c-no"]).toBe("skipped");
  });

  it("marks edges out of failed and skipped sources", () => {
    const states = deriveStates(
      [step("f", { status: "failed" }), step("s", { status: "skipped" }), step("t", { status: "pending" })],
      [
        { id: "ft", source: "f", target: "t" },
        { id: "st", source: "s", target: "t" },
      ],
    );
    expect(states.edgeStates.ft).toBe("failed");
    expect(states.edgeStates.st).toBe("skipped");
  });
});

describe("planFromExecution", () => {
  it("seeds a plan from a persisted execution", () => {
    const execution: ExecutionDetail = {
      id: "ex_1",
      workflowId: "wf_1",
      workflowName: "Demo",
      status: "completed",
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(5).toISOString(),
      durationMs: 5,
      trigger: { type: "trigger.manual", label: "Manual run" },
      source: "manual",
      stepCount: 1,
      failedStepCount: 0,
      input: null,
      output: { ok: true },
      workflowVersion: 1,
      metadata: {},
      steps: [step("a", { status: "completed", durationMs: 5 })],
    };
    const plan = planFromExecution(execution);
    expect(plan.status).toBe("completed");
    expect(plan.durationMs).toBe(5);
    expect(plan.revealed).toBe(1);
    expect(plan.edges).toEqual([]);
  });
});

describe("applyEvent — states the engine cannot store directly", () => {
  const live = () =>
    createPlan([], [
      step("a", { status: "running", attempt: 1, startedAtMs: 10, nodeLabel: "Call API" }),
    ]);

  it("keeps a retrying step running with the failed attempt still visible", () => {
    const next = applyEvent(live(), {
      type: "execution.node.retrying",
      executionId: "ex_1",
      stepId: "st_a",
      nodeId: "a",
      nodeType: "action.http",
      nodeLabel: "Call API",
      ref: "a",
      attempt: 1,
      nextAttempt: 2,
      delayMs: 250,
      error: { code: "HTTP_500", message: "Upstream returned 500" },
      at: 20,
    });

    const retried = next.steps[0];
    expect(retried?.status).toBe("running");
    expect(retried?.attempt).toBe(2);
    expect(retried?.error?.code).toBe("HTTP_500");
    expect(stepVisualState(retried)).toBe("retrying");
  });

  it("moves a step between parked and live on the waiting events", () => {
    const park = applyEvent(live(), {
      type: "execution.node.waiting",
      executionId: "ex_1",
      stepId: "st_a",
      nodeId: "a",
      nodeType: "action.http",
      nodeLabel: "Call API",
      ref: "a",
      waiting: true,
      at: 30,
    });
    expect(park.steps[0]?.status).toBe("waiting");

    const resume = applyEvent(park, {
      type: "execution.node.waiting",
      executionId: "ex_1",
      stepId: "st_a",
      nodeId: "a",
      nodeType: "action.http",
      nodeLabel: "Call API",
      ref: "a",
      waiting: false,
      at: 40,
    });
    expect(resume.steps[0]?.status).toBe("running");
  });

  it("carries provider telemetry from the settle event onto the step", () => {
    const metadata = {
      providerCalls: [
        { provider: "slack", operation: "post_message", method: "POST", url: "https://x", status: 200 },
      ],
      providerCallCount: 1,
    };
    const next = applyEvent(live(), {
      type: "execution.node.completed",
      executionId: "ex_1",
      stepId: "st_a",
      nodeId: "a",
      nodeType: "action.http",
      nodeLabel: "Call API",
      ref: "a",
      durationMs: 12,
      output: { ok: true },
      branch: null,
      attempt: 2,
      at: 30,
      metadata,
    });

    expect(next.steps[0]?.metadata).toEqual(metadata);
    expect(isTerminal(next.status)).toBe(false);
  });
});

describe("isTerminal", () => {
  it("recognises only run-ending statuses", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("waiting")).toBe(false);
  });
});
