import { describe, expect, it } from "vitest";
import { diffWorkflow } from "./diff";
import { parseWorkflowPlan } from "./plan";
import { planToWorkflow } from "./graph";
import type { Workflow } from "@/lib/workflow/types";

/**
 * The approval diff: what pressing Apply actually changes. If this is
 * wrong, a human signs off on the wrong graph.
 */

function workflowWith(nodes: Workflow["nodes"], edges: Workflow["edges"] = []): Workflow {
  return {
    id: "wf_base",
    name: "Base",
    description: "",
    status: "draft",
    tags: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
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

const triggerNode: Workflow["nodes"][number] = {
  id: "t1",
  type: "trigger.manual",
  position: { x: 0, y: 0 },
  data: { ref: "manual", config: {} },
};

function slackNode(id: string, message: string): Workflow["nodes"][number] {
  return {
    id,
    type: "action.slack_message",
    position: { x: 300, y: 0 },
    data: {
      ref: id,
      label: `Post ${message}`,
      config: { operation: "send", channel: "#general", message },
    },
  };
}

describe("diffWorkflow", () => {
  it("reports an identical graph as unchanged", () => {
    const current = workflowWith([triggerNode, slackNode("s1", "hi")]);
    const diff = diffWorkflow(current, structuredClone(current));
    expect(diff.empty).toBe(true);
    expect(diff.unchangedCount).toBe(2);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("lists added and removed nodes with their labels", () => {
    const current = workflowWith([triggerNode, slackNode("s1", "hi")]);
    const proposed = workflowWith([triggerNode, slackNode("s2", "new")]);
    const diff = diffWorkflow(current, proposed);

    expect(diff.added.map((entry) => entry.id)).toEqual(["s2"]);
    expect(diff.removed.map((entry) => entry.id)).toEqual(["s1"]);
    expect(diff.added[0]?.label).toContain("Post new");
    expect(diff.unchangedCount).toBe(1);
    expect(diff.empty).toBe(false);
  });

  it("shows exactly which config keys changed", () => {
    const current = workflowWith([triggerNode, slackNode("s1", "hi")]);
    const proposed = structuredClone(current);
    const node = proposed.nodes.find((item) => item.id === "s1")!;
    (node.data.config as Record<string, unknown>).message = "updated";
    (node.data.config as Record<string, unknown>).channel = "#support";

    const diff = diffWorkflow(current, proposed);
    const entry = diff.changed.find((item) => item.id === "s1");
    expect(entry).toBeDefined();
    const changes = Object.fromEntries(entry!.changes.map((change) => [change.key, change]));
    expect(changes.message).toMatchObject({ before: "hi", after: "updated" });
    expect(changes.channel).toMatchObject({ before: "#general", after: "#support" });
  });

  it("counts connection changes", () => {
    const current = workflowWith([triggerNode, slackNode("s1", "a"), slackNode("s2", "b")], [
      { id: "e1", source: "t1", target: "s1" },
    ]);
    const proposed = workflowWith([triggerNode, slackNode("s1", "a"), slackNode("s2", "b")], [
      { id: "e1", source: "t1", target: "s1" },
      { id: "e2", source: "s1", target: "s2" },
    ]);

    const diff = diffWorkflow(current, proposed);
    expect(diff.edgesAdded).toHaveLength(1);
    expect(diff.edgesRemoved).toEqual([]);
    expect(diff.empty).toBe(false);
  });

  it("treats a brand new AI plan (no shared ids) as all additions", () => {
    const current = workflowWith([triggerNode, slackNode("s1", "hi")]);
    const proposed = planToWorkflow(
      parseWorkflowPlan({
        title: "AI plan",
        nodes: [
          { id: "n1", type: "trigger.manual", config: {}, why: "start" },
          { id: "n2", type: "action.slack_message", config: { operation: "send", channel: "#x", message: "m" }, why: "post" },
        ],
        edges: [{ id: "e1", source: "n1", target: "n2" }],
      }),
    );

    const diff = diffWorkflow(current, proposed);
    expect(diff.added.map((entry) => entry.id)).toEqual(["n1", "n2"]);
    expect(diff.removed.map((entry) => entry.id)).toEqual(["t1", "s1"]);
    expect(diff.unchangedCount).toBe(0);
  });
});
