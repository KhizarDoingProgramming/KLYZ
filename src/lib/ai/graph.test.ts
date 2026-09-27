import { describe, expect, it } from "vitest";
import { parseWorkflowPlan } from "./plan";
import { planToWorkflow } from "./graph";
import type { WorkflowPlan } from "./plan";

/**
 * Plan → workflow conversion: the only way a proposal ever becomes a
 * KLYZ graph. Everything it produces has to satisfy the editor's
 * expectations — stable ids, unique expression refs, layered positions
 * and a real summary — because Apply hands this object straight to the
 * store the editor loads from.
 */

function plan(raw: Partial<WorkflowPlan> & { nodes: WorkflowPlan["nodes"] }): WorkflowPlan {
  return parseWorkflowPlan({
    title: "Test plan",
    description: "A plan used by the tests.",
    edges: [],
    ...raw,
  });
}

describe("planToWorkflow", () => {
  it("converts nodes and edges with ids preserved", () => {
    const workflow = planToWorkflow(
      plan({
        nodes: [
          { id: "n1", type: "trigger.manual", config: {}, why: "Start." },
          {
            id: "n2",
            type: "action.slack_message",
            config: { operation: "send", channel: "#a", message: "m" },
            why: "Post.",
          },
        ],
        edges: [{ id: "e1", source: "n1", target: "n2" }],
      }),
    );

    expect(workflow.nodes.map((node) => node.id)).toEqual(["n1", "n2"]);
    expect(workflow.edges).toEqual([{ id: "e1", source: "n1", target: "n2" }]);
    expect(workflow.nodeCount).toBe(2);
    expect(workflow.status).toBe("draft");
    expect(workflow.triggerType).toBe("trigger.manual");
    expect(workflow.name).toBe("Test plan");
  });

  it("gives every node a unique, legal expression ref", () => {
    /* Built directly: the parser already refuses reserved refs, so this
       exercises the converter's own safety net. */
    const workflow = planToWorkflow({
      title: "Refs",
      description: "",
      summary: "",
      intent: [],
      nodes: [
        { id: "n1", type: "trigger.manual", ref: "trigger", config: {}, why: "a" },
        { id: "n2", type: "trigger.manual", ref: "slack", config: {}, why: "b" },
        { id: "n3", type: "trigger.manual", ref: "slack", config: {}, why: "c" },
        { id: "n4", type: "trigger.manual", ref: "9bad", config: {}, why: "d" },
      ],
      edges: [],
      assumptions: [],
      unresolved: [],
      requiredConnections: [],
      warnings: [],
      sideEffects: [],
    });

    const refs = workflow.nodes.map((node) => node.data.ref);
    expect(new Set(refs).size).toBe(refs.length);
    for (const ref of refs) {
      expect(ref).not.toBe("trigger");
      expect(ref).not.toBe("context");
      expect(ref).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    }
    expect(refs.filter((ref) => ref.startsWith("slack"))).toHaveLength(2);
  });

  it("layers the graph: triggers left of their downstream steps", () => {
    const workflow = planToWorkflow(
      plan({
        nodes: [
          { id: "n1", type: "trigger.manual", config: {}, why: "a" },
          { id: "n2", type: "logic.filter", config: { condition: "true" }, why: "b" },
          {
            id: "n3",
            type: "action.slack_message",
            config: { operation: "send", channel: "#a", message: "m" },
            why: "c",
          },
        ],
        edges: [
          { id: "e1", source: "n1", target: "n2" },
          { id: "e2", source: "n2", target: "n3" },
        ],
      }),
    );

    const x = Object.fromEntries(workflow.nodes.map((node) => [node.id, node.position.x]));
    expect(x.n1!).toBeLessThan(x.n2!);
    expect(x.n2).toBeLessThan(x.n3!);
    /* Stable grid — the canvas should not need to re-layout on load. */
    expect(x.n2! - x.n1!).toBe(x.n3! - x.n2!);
  });

  it("carries branch data onto edges for branching nodes", () => {
    const workflow = planToWorkflow(
      plan({
        nodes: [
          { id: "n1", type: "trigger.manual", config: {}, why: "a" },
          { id: "n2", type: "logic.condition", config: { left: "1" }, why: "b" },
        ],
        edges: [{ id: "e1", source: "n1", target: "n2", branch: "true" }],
      }),
    );
    expect(workflow.edges[0]?.data?.branch).toBe("true");
  });

  it("honours overrides for id, name, description, status and createdAt", () => {
    const workflow = planToWorkflow(plan({ nodes: [{ id: "n1", type: "trigger.manual", config: {}, why: "Start." }] }), {
      workflowId: "wf_existing",
      name: "Existing name",
      description: "Kept description",
      status: "active",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    expect(workflow.id).toBe("wf_existing");
    expect(workflow.name).toBe("Existing name");
    expect(workflow.description).toBe("Kept description");
    expect(workflow.status).toBe("active");
    expect(workflow.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(workflow.executionCount).toBe(0);
    expect(workflow.successRate).toBe(0);
  });

  it("defaults to a draft with a manual trigger when the plan has none", () => {
    const workflow = planToWorkflow(
      plan({ nodes: [{ id: "n1", type: "action.slack_message", config: {}, why: "a" }] }),
    );
    expect(workflow.triggerType).toBe("trigger.manual");
    expect(workflow.status).toBe("draft");
  });
});
