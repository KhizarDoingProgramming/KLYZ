import { describe, expect, it } from "vitest";
import {
  attemptsOf,
  failedStepOf,
  formatOffset,
  isLiveState,
  nodeStatusOf,
  sideEffectsFor,
  sideEffectsOfWorkflow,
  stepOffset,
  stepVisualState,
  waitingStepOf,
} from "./debugger";
import type { ExecutionStepView } from "./types";
import type { Workflow } from "@/lib/workflow/types";

function step(overrides: Partial<ExecutionStepView> = {}): ExecutionStepView {
  return {
    id: "st_1",
    nodeId: "n1",
    nodeType: "action.log",
    nodeLabel: "Step 1",
    ref: "n1",
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

const cancelledError = { code: "CANCELLED", message: "Stopped by the operator" } as const;
const retryError = { code: "HTTP_500", message: "Upstream returned 500" } as const;

describe("stepVisualState", () => {
  it("collapses the two states the engine reports in a disguised form", () => {
    expect(stepVisualState(step({ status: "failed", error: cancelledError }))).toBe("cancelled");
    expect(stepVisualState(step({ status: "running", error: retryError, attempt: 2 }))).toBe(
      "retrying",
    );
  });

  it("passes every honest state straight through", () => {
    expect(stepVisualState(step({ status: "running" }))).toBe("running");
    expect(stepVisualState(step({ status: "waiting" }))).toBe("waiting");
    expect(stepVisualState(step({ status: "completed" }))).toBe("completed");
    expect(stepVisualState(step({ status: "failed", error: retryError }))).toBe("failed");
    expect(stepVisualState(step({ status: "skipped" }))).toBe("skipped");
    expect(stepVisualState(undefined)).toBe("idle");
  });

  it("treats retrying, running and waiting as live", () => {
    expect(isLiveState("running")).toBe(true);
    expect(isLiveState("retrying")).toBe(true);
    expect(isLiveState("waiting")).toBe(true);
    expect(isLiveState("completed")).toBe(false);
    expect(isLiveState("idle")).toBe(false);
  });
});

describe("nodeStatusOf", () => {
  it("maps debugger-only states onto the shared node vocabulary", () => {
    expect(nodeStatusOf("retrying")).toBe("running");
    expect(nodeStatusOf("cancelled")).toBe("failed");
    expect(nodeStatusOf("waiting")).toBe("waiting");
    expect(nodeStatusOf("completed")).toBe("completed");
  });
});

describe("formatOffset", () => {
  it("renders a stable MM:SS.mmm column", () => {
    expect(formatOffset(0)).toBe("00:00.000");
    expect(formatOffset(5)).toBe("00:00.005");
    expect(formatOffset(65_432)).toBe("01:05.432");
    expect(formatOffset(3_600_000)).toBe("60:00.000");
  });

  it("never prints a negative offset", () => {
    expect(formatOffset(-10)).toBe("00:00.000");
  });
});

describe("stepOffset", () => {
  it("is null until both clocks are known", () => {
    expect(stepOffset(step(), 1_000)).toBeNull();
    expect(stepOffset(step({ startedAtMs: 2_000 }), null)).toBeNull();
  });

  it("measures from the run start and clamps to zero", () => {
    expect(stepOffset(step({ startedAtMs: 4_500 }), 3_000)).toBe(1_500);
    expect(stepOffset(step({ startedAtMs: 1_000 }), 3_000)).toBe(0);
  });
});

describe("step lookups", () => {
  it("finds the failure first, then whatever is parked", () => {
    const steps = [
      step({ nodeId: "a", status: "waiting" }),
      step({ nodeId: "b", status: "failed" }),
      step({ nodeId: "c", status: "running" }),
    ];
    expect(failedStepOf(steps)?.nodeId).toBe("b");
    expect(waitingStepOf(steps)?.nodeId).toBe("a");
    expect(failedStepOf([])).toBeNull();
    expect(waitingStepOf([])).toBeNull();
  });
});

describe("attemptsOf", () => {
  it("returns a single row for a first-attempt failure", () => {
    const rows = attemptsOf(
      step({ status: "failed", attempt: 1, error: retryError, durationMs: 42 }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attempt: 1,
      outcome: "failed",
      code: "HTTP_500",
      durationMs: 42,
    });
  });

  it("replays the stored retry trail in order and closes it out", () => {
    const rows = attemptsOf(
      step({
        status: "completed",
        attempt: 3,
        durationMs: 120,
        metadata: {
          retries: [
            { attempt: 1, nextAttempt: 2, delayMs: 250, code: "HTTP_500", message: "boom" },
            { attempt: 2, nextAttempt: 3, delayMs: 500, code: "HTTP_503" },
          ],
        },
      }),
    );
    expect(rows.map((row) => [row.attempt, row.outcome])).toEqual([
      [1, "retrying"],
      [2, "retrying"],
      [3, "completed"],
    ]);
    expect(rows[0]!.delayMs).toBe(250);
    expect(rows[0]!.code).toBe("HTTP_500");
  });

  it("still counts as retrying while backoff is running", () => {
    const rows = attemptsOf(
      step({
        status: "running",
        attempt: 2,
        error: retryError,
        metadata: { retries: [{ attempt: 1, nextAttempt: 2, delayMs: 100 }] },
      }),
    );
    expect(rows.map((row) => row.outcome)).toEqual(["retrying", "retrying"]);
    expect(rows[1]!.code).toBe("HTTP_500");
  });

  it("ignores malformed metadata instead of throwing", () => {
    expect(attemptsOf(step({ status: "failed", metadata: { retries: "nope" } }))).toHaveLength(1);
    expect(attemptsOf(step({ status: "failed", metadata: null }))).toHaveLength(1);
    expect(attemptsOf(null)).toEqual([]);
  });
});

describe("sideEffectsFor", () => {
  const nodes = [
    { id: "n1", type: "action.slack_message", data: { label: "Notify the team" } },
    { id: "n2", type: "action.log", data: { label: "Trace" } },
    { id: "n3", type: "action.http", data: { config: { method: "POST" } } },
    { id: "n4", type: "action.http", data: { config: { method: "GET" } } },
    { id: "n5", type: "trigger.manual" },
    { id: "n6", type: "action.github_issue" },
  ];

  it("names only the steps that change something outside KLYZ", () => {
    const effects = sideEffectsFor(nodes);
    expect(effects.map((effect) => effect.nodeId)).toEqual(["n1", "n3", "n6"]);
    expect(effects[0]!).toEqual({
      nodeId: "n1",
      label: "Notify the team",
      reason: "Posts a message to Slack",
    });
  });

  it("falls back to the node type when the step has no label", () => {
    const [effect] = sideEffectsFor([{ id: "n6", type: "action.github_issue" }]);
    expect(effect!.label).toBe("action.github_issue");
  });

  it("reads a stored definition the same way", () => {
    const definition = {
      id: "wf_1",
      nodes: [{ id: "n1", type: "action.gmail_send", position: { x: 0, y: 0 }, data: { ref: "n1", config: {} } }],
      edges: [],
    } as unknown as Workflow;
    expect(sideEffectsOfWorkflow(definition)).toEqual([
      { nodeId: "n1", label: "action.gmail_send", reason: "Sends an email" },
    ]);
  });
});
