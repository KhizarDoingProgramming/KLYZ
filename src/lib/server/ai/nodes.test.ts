import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeWorkflow } from "@/lib/engine/executor";
import { applyEvent, createPlan } from "@/lib/execution/projector";
import type { EngineEvent } from "@/lib/execution/events";
import type { ExecutionPlanEdge, ExecutionStepView } from "@/lib/execution/types";
import type { Workflow } from "@/lib/workflow/types";

/*
 * The four AI steps, run through the real engine against the
 * deterministic local provider (`KLYZ_AI_PROVIDER=mock`).
 *
 * Everything except the network round-trip is production code: config
 * resolution, prompt assembly, reply parsing, output validation and the
 * error mapping. The assertions below are on the shapes the registry
 * advertises, so a regression in any of those layers fails here.
 */

type TestNode = Workflow["nodes"][number];
type TestEdge = Workflow["edges"][number];

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

type Outcome = Awaited<ReturnType<typeof executeWorkflow>> & {
  events: EngineEvent[];
};

async function run(
  definition: Workflow,
  input: Record<string, unknown>,
): Promise<Outcome> {
  const events: EngineEvent[] = [];
  let plan: ReturnType<typeof createPlan> = createPlan(
    definition.edges.map((item) => ({
      id: item.id,
      source: item.source,
      target: item.target,
      branch: item.data?.branch,
    })) as ExecutionPlanEdge[],
  );
  const result = await executeWorkflow({
    executionId: "exec_ai",
    workspaceId: "ws_default",
    workflow: definition,
    workflowVersionId: "ver_1",
    workflowVersion: 1,
    input,
    emit: (event) => {
      events.push(event);
      plan = applyEvent(plan, event);
    },
    signal: new AbortController().signal,
  });
  return { ...result, events };
}

function step(outcome: Outcome, nodeId: string): ExecutionStepView {
  const found = outcome.steps.find((item) => item.nodeId === nodeId);
  if (!found) throw new Error(`no step recorded for "${nodeId}"`);
  return found;
}

function outputOf(outcome: Outcome, nodeId: string): Record<string, unknown> {
  return (step(outcome, nodeId).output ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("KLYZ_AI_PROVIDER", "mock");
  vi.stubEnv("KLYZ_AI_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ai.extract", () => {
  it("returns one value per declared field and never invents one", async () => {
    const definition = workflow(
      "wf_ai_extract",
      [
        node("t", "trigger.manual", {}),
        node("extract", "ai.extract", {
          input: "{{trigger.payload.text}}",
          schema: [
            { id: "1", key: "title", value: "string" },
            { id: "2", key: "count", value: "number" },
            { id: "3", key: "tags", value: "array" },
            { id: "4", key: "note", value: "string" },
          ],
        }),
      ],
      [edge("t", "extract")],
    );

    const outcome = await run(definition, { text: "Alpha release notes\n12 items queued" });

    expect(outcome.status).toBe("completed");
    expect(outcome.error).toBeUndefined();

    const fields = outputOf(outcome, "extract").fields as Record<string, unknown>;
    expect(Object.keys(fields)).toEqual(["title", "count", "tags", "note"]);
    expect(fields.title).toBe("Alpha release notes");
    expect(fields.count).toBe(12);
    expect(Array.isArray(fields.tags)).toBe(true);
    /* Every declared key is present — the model never drops a field. */
    expect(fields.note).toBe("Alpha release notes");
    expect(typeof outputOf(outcome, "extract").tokens).toBe("number");
  });
});

describe("ai.summarize", () => {
  it("condenses the content into the advertised summary field", async () => {
    const definition = workflow(
      "wf_ai_summarize",
      [
        node("t", "trigger.manual", {}),
        node("sum", "ai.summarize", {
          input: "{{trigger.payload.text}}",
          length: "one_liner",
        }),
      ],
      [edge("t", "sum")],
    );

    const outcome = await run(definition, {
      text: "Checkout is failing for EU cards. Payments retry three times then give up.",
    });

    expect(outcome.status).toBe("completed");
    const output = outputOf(outcome, "sum");
    expect(typeof output.summary).toBe("string");
    expect(output.summary).toBe("Checkout is failing for EU cards.");
    expect(output.tokens).toBeGreaterThan(0);
  });
});

describe("ai.classify", () => {
  it("picks a label from the caller's list and scores every one", async () => {
    const definition = workflow(
      "wf_ai_classify",
      [
        node("t", "trigger.manual", {}),
        node("cls", "ai.classify", {
          input: "{{trigger.payload.text}}",
          labels: "bug, feature, question",
        }),
      ],
      [edge("t", "cls")],
    );

    const outcome = await run(definition, { text: "Feature request: dark mode" });

    expect(outcome.status).toBe("completed");
    const output = outputOf(outcome, "cls");
    expect(["bug", "feature", "question"]).toContain(output.label);
    expect(output.label).toBe("feature");

    const scores = output.scores as Record<string, number>;
    expect(Object.keys(scores).sort()).toEqual(["bug", "feature", "question"]);
    expect(Object.values(scores).every((value) => value >= 0 && value <= 1)).toBe(true);
  });
});

describe("ai.generate", () => {
  it("answers with text built from the prompt and its context", async () => {
    const definition = workflow(
      "wf_ai_generate",
      [
        node("t", "trigger.manual", {}),
        node("gen", "ai.generate", {
          prompt: "Write a triage note for {{trigger.payload.title}}",
          context: "{{trigger.payload.body}}",
        }),
      ],
      [edge("t", "gen")],
    );

    const outcome = await run(definition, {
      title: "EU checkout outage",
      body: "Payments retried three times then gave up.",
    });

    expect(outcome.status).toBe("completed");
    const text = String(outputOf(outcome, "gen").text);
    expect(text).toContain("triage note for EU checkout outage");
    expect(text.startsWith("Mock:")).toBe(true);
  });
});

describe("ai steps without a provider", () => {
  it("fails the step instead of fabricating output", async () => {
    vi.stubEnv("KLYZ_AI_PROVIDER", "openai");
    vi.stubEnv("KLYZ_AI_API_KEY", "");

    const definition = workflow(
      "wf_ai_unconfigured",
      [
        node("t", "trigger.manual", {}),
        node("gen", "ai.generate", { prompt: "say hello" }),
      ],
      [edge("t", "gen")],
    );

    const outcome = await run(definition, {});

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("AI_NOT_CONFIGURED");
    expect(step(outcome, "gen").status).toBe("failed");
  });
});
