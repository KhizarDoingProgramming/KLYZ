import { describe, expect, it } from "vitest";
import { PLAN_LIMITS, PlanParseError, parseWorkflowPlan } from "./plan";
import type { WorkflowPlan } from "./plan";

/**
 * The contract the model's JSON has to satisfy before anything else in
 * the AI layer touches it. Parsing is deliberately unforgiving: unknown
 * fields, wrong shapes and over-limit values are all failures with
 * reasons, so the UI can show them instead of retrying forever.
 */

interface PlanFixture {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function validPlan(): PlanFixture {
  return {
    title: "Slack digest",
    description: "Post a daily digest.",
    summary: "Collect items and post them to Slack.",
    intent: [{ stage: "trigger", label: "Start on a schedule" }],
    nodes: [
      { id: "n1", type: "trigger.manual", ref: "manual", config: {}, why: "Starts it." },
      {
        id: "n2",
        type: "action.slack_message",
        ref: "slack",
        config: { operation: "send", channel: "#general", message: "hi" },
        why: "Posts the digest.",
      },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2" }],
    assumptions: ["There is a #general channel."],
    unresolved: [{ label: "Which channel?", reason: "Not stated.", severity: "missing" }],
    requiredConnections: [
      { credential: "slack", label: "Slack", reason: "Posts messages.", nodeId: "n2" },
    ],
    warnings: [],
    sideEffects: [{ label: "Posts to Slack", reason: "Visible to the workspace.", nodeId: "n2" }],
  };
}

function parse(raw: unknown): WorkflowPlan {
  return parseWorkflowPlan(raw);
}

describe("parseWorkflowPlan", () => {
  it("accepts a well-formed plan and keeps every documented field", () => {
    const plan = parse(validPlan());
    expect(plan.title).toBe("Slack digest");
    expect(plan.nodes).toHaveLength(2);
    expect(plan.edges[0]).toEqual({ id: "e1", source: "n1", target: "n2" });
    expect(plan.intent[0]).toEqual({ stage: "trigger", label: "Start on a schedule" });
    expect(plan.requiredConnections[0]?.credential).toBe("slack");
    expect(plan.sideEffects[0]?.label).toBe("Posts to Slack");
    expect(plan.assumptions[0]).toContain("#general");
    expect(plan.unresolved[0]?.severity).toBe("missing");
  });

  it("fills optional text fields with defaults instead of failing", () => {
    const plan = parse({ title: "T", nodes: [{ id: "a", type: "trigger.manual", config: {} }], edges: [] });
    expect(plan.summary).toBe("");
    expect(plan.assumptions).toEqual([]);
    expect(plan.requiredConnections).toEqual([]);
    expect(plan.nodes[0]?.why).toBeTruthy();
  });

  it("rejects non-objects and missing structure", () => {
    expect(() => parse(null)).toThrow(PlanParseError);
    expect(() => parse("a plan")).toThrow(PlanParseError);
    expect(() => parse({})).toThrow(PlanParseError);
    expect(() => parse({ title: "T", nodes: [], edges: [] })).toThrow(PlanParseError);
    expect(() => parse({ title: "T", nodes: "no", edges: [] })).toThrow(PlanParseError);
  });

  it("reports unknown fields at plan, node and edge level", () => {
    const cases: Array<Record<string, unknown>> = [
      { ...validPlan(), publish: true },
      { ...validPlan(), nodes: [{ ...validPlan().nodes[0], credential: "sk-secret" }] },
      { ...validPlan(), edges: [{ id: "e1", source: "n1", target: "n2", weight: 3 }] },
    ];
    for (const raw of cases) {
      let issues: string[] = [];
      try {
        parse(raw);
      } catch (error) {
        expect(error).toBeInstanceOf(PlanParseError);
        issues = (error as PlanParseError).issues;
      }
      expect(issues.some((issue) => issue.includes("unknown field"))).toBe(true);
    }
  });

  it("rejects duplicate node ids and makes duplicate edge ids unique", () => {
    const duplicateNode = validPlan();
    duplicateNode.nodes = [validPlan().nodes[0]!, validPlan().nodes[0]!];
    expect(() => parse(duplicateNode)).toThrow(/duplicated/);

    const duplicateEdge = validPlan();
    duplicateEdge.edges = [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e1", source: "n1", target: "n2" },
    ];
    const plan = parse(duplicateEdge);
    const ids = plan.edges.map((edge) => edge.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("e1");
  });

  it("rejects credential kinds outside the known union", () => {
    const raw = validPlan();
    raw.requiredConnections = [{ credential: "stripe", label: "Stripe", reason: "Charges." }];
    expect(() => parse(raw)).toThrow(/credential must be one of/);
  });

  it("rejects reserved and malformed refs", () => {
    for (const ref of ["trigger", "context", "1bad", "has-dash"]) {
      const raw = validPlan();
      raw.nodes = [{ id: "n1", type: "trigger.manual", ref, config: {} }];
      expect(() => parse(raw)).toThrow(PlanParseError);
    }
  });

  it("enforces node and edge ceilings", () => {
    const raw = validPlan();
    raw.nodes = Array.from({ length: PLAN_LIMITS.nodes + 1 }, (_, index) => ({
      id: `n${index}`,
      type: "trigger.manual",
      config: {},
    }));
    expect(() => parse(raw)).toThrow(/node limit/);

    const edges = validPlan();
    edges.edges = Array.from({ length: PLAN_LIMITS.edges + 1 }, (_, index) => ({
      id: `e${index}`,
      source: "n1",
      target: "n2",
    }));
    expect(() => parse(edges)).toThrow(/edge limit/);
  });

  it("clips over-long config strings instead of failing", () => {
    const raw = validPlan();
    raw.nodes = [
      {
        id: "n1",
        type: "trigger.manual",
        config: { blob: "x".repeat(PLAN_LIMITS.configString + 500) },
      },
    ];
    const plan = parse(raw);
    const blob = String((plan.nodes[0]!.config as Record<string, unknown>).blob);
    expect(blob.length).toBeLessThanOrEqual(PLAN_LIMITS.configString);
    expect(blob.endsWith("…")).toBe(true);
  });

  it("refuses config that is too deep or too long", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < PLAN_LIMITS.configDepth + 4; index += 1) {
      deep = { nested: deep };
    }
    const tooDeep = validPlan();
    tooDeep.nodes = [{ id: "n1", type: "trigger.manual", config: { deep } }];
    expect(() => parse(tooDeep)).toThrow(/nested too deeply/);

    const tooLong = validPlan();
    tooLong.nodes = [
      {
        id: "n1",
        type: "trigger.manual",
        config: { items: Array.from({ length: PLAN_LIMITS.configItems + 10 }, (_, index) => index) },
      },
    ];
    expect(() => parse(tooLong)).toThrow(/more than .* items/);
  });

  it("collects every reason instead of stopping at the first", () => {
    const raw = validPlan();
    raw.title = "";
    raw.nodes = [{ id: "", type: "Trigger Manual", config: "no" }];
    let issues: string[] = [];
    try {
      parse(raw);
    } catch (error) {
      issues = (error as PlanParseError).issues;
    }
    expect(issues.length).toBeGreaterThan(1);
  });
});
