import { describe, expect, it } from "vitest";
import { parseWorkflowPlan } from "./plan";
import { validatePlan } from "./validate";
import type { WorkflowPlan } from "./plan";

/**
 * Plan validation — the model is never trusted.
 *
 * The two behaviours worth pinning down: unknown capabilities can never
 * become graph nodes silently, and a missing credential is a connection
 * to make (non-blocking), not a broken graph.
 */

function build(raw: Record<string, unknown>): WorkflowPlan {
  return parseWorkflowPlan({ title: "T", edges: [], ...raw });
}

const TRIGGER = { id: "t1", type: "trigger.manual", config: {}, why: "Start." };
const SLACK = {
  id: "s1",
  type: "action.slack_message",
  config: { operation: "send", channel: "#general", message: "hello" },
  why: "Post.",
};

function slackNode(id: string, overrides: Record<string, unknown> = {}) {
  return { ...SLACK, id, config: { ...SLACK.config, ...overrides } };
}

describe("validatePlan", () => {
  it("passes a complete plan with only a connection to resolve", () => {
    const result = validatePlan(build({ nodes: [TRIGGER, SLACK], edges: [{ id: "e1", source: "t1", target: "s1" }] }));

    expect(result.ok).toBe(true);
    expect(result.applyable).toBe(true);
    expect(result.blocking).toEqual([]);
    expect(result.workflow?.nodes).toHaveLength(2);
    expect(result.connections).toEqual([
      {
        credential: "slack",
        label: "Slack message connection required",
        reason: expect.stringContaining("slack"),
        nodeId: "s1",
      },
    ]);
    /* The credential gap is not reported as a graph error. */
    expect(result.issues.filter((issue) => issue.id.includes("missing_"))).toEqual([]);
  });

  it("reports missing configuration without blocking the editor hand-off", () => {
    const result = validatePlan(
      build({
        nodes: [TRIGGER, slackNode("s1", { channel: "" })],
        edges: [{ id: "e1", source: "t1", target: "s1" }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.applyable).toBe(true);
    expect(result.blocking).toEqual([]);
    const issue = result.issues.find((item) => item.id === "missing_s1_channel");
    expect(issue?.severity).toBe("error");
  });

  it("rejects an unknown capability instead of letting it into the graph silently", () => {
    const result = validatePlan(
      build({
        nodes: [TRIGGER, { id: "x1", type: "action.teleport", config: {}, why: "?" }],
        edges: [{ id: "e1", source: "t1", target: "x1" }],
      }),
    );

    const capability = result.issues.find((issue) => issue.id === "capability_x1");
    expect(capability?.severity).toBe("error");
    expect(capability?.message).toContain("action.teleport");
    expect(result.blocking.map((issue) => issue.id)).toContain("capability_x1");
    expect(result.applyable).toBe(false);
    /* Exactly one unknown-type report per node — no duplicate from the
       editor's generic path. */
    expect(result.issues.filter((issue) => issue.nodeId === "x1" && issue.severity === "error")).toHaveLength(1);
  });

  it("blocks cyclic graphs", () => {
    const result = validatePlan(
      build({
        nodes: [TRIGGER, slackNode("s1"), slackNode("s2")],
        edges: [
          { id: "e1", source: "t1", target: "s1" },
          { id: "e2", source: "s1", target: "s2" },
          { id: "e3", source: "s2", target: "s1" },
        ],
      }),
    );
    expect(result.blocking.some((issue) => issue.id === "graph_cycle")).toBe(true);
    expect(result.applyable).toBe(false);
  });

  it("blocks unconnected non-trigger steps", () => {
    const result = validatePlan(build({ nodes: [TRIGGER, SLACK] }));
    expect(result.blocking.some((issue) => issue.id.startsWith("orphan_"))).toBe(true);
    expect(result.applyable).toBe(false);
  });

  it("blocks edges that point at nodes the plan never declared", () => {
    const result = validatePlan(
      build({
        nodes: [TRIGGER],
        edges: [{ id: "e1", source: "t1", target: "ghost" }],
      }),
    );
    expect(result.blocking.some((issue) => issue.id === "edge_missing_e1")).toBe(true);
    expect(result.applyable).toBe(false);
  });

  it("keeps broken expression refs as fixable, non-blocking errors", () => {
    const result = validatePlan(
      build({
        nodes: [TRIGGER, slackNode("s1", { message: "{{nowhere.body}}" })],
        edges: [{ id: "e1", source: "t1", target: "s1" }],
      }),
    );
    expect(result.issues.some((issue) => issue.id.startsWith("ref_s1_message_"))).toBe(true);
    expect(result.applyable).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("unions model-declared connections with the graph's own", () => {
    const result = validatePlan(
      build({
        nodes: [TRIGGER, SLACK],
        edges: [{ id: "e1", source: "t1", target: "s1" }],
        requiredConnections: [
          { credential: "google_sheets", label: "Sheets", reason: "Wrote rows.", nodeId: "s1" },
        ],
      }),
    );
    expect(result.connections.map((item) => item.credential).sort()).toEqual([
      "google_sheets",
      "slack",
    ]);
  });

  it("stamps the workflow id when one is supplied", () => {
    const result = validatePlan(
      build({ nodes: [TRIGGER] }),
      { workflowId: "wf_123" },
    );
    expect(result.workflow?.id).toBe("wf_123");
  });
});
