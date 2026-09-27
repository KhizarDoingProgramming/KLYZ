import { describe, expect, it } from "vitest";
import {
  ConditionError,
  evaluateCondition,
  evaluateGroup,
  singleConditionGroup,
} from "./conditions";

describe("evaluateCondition", () => {
  it("compares equality loosely across strings and numbers", () => {
    expect(evaluateCondition({ left: "5", operator: "eq", right: 5 })).toBe(true);
    expect(evaluateCondition({ left: "a", operator: "eq", right: "b" })).toBe(false);
    expect(evaluateCondition({ left: null, operator: "eq", right: null })).toBe(true);
  });

  it("honours case sensitivity", () => {
    expect(evaluateCondition({ left: "Hello", operator: "eq", right: "hello" })).toBe(true);
    expect(
      evaluateCondition({
        left: "Hello",
        operator: "eq",
        right: "hello",
        caseSensitive: true,
      }),
    ).toBe(false);
  });

  it("handles string operators", () => {
    expect(evaluateCondition({ left: "KLYZ-104", operator: "startsWith", right: "KLYZ" })).toBe(true);
    expect(evaluateCondition({ left: "KLYZ-104", operator: "endsWith", right: "104" })).toBe(true);
    expect(evaluateCondition({ left: "triage this", operator: "contains", right: "triage" })).toBe(true);
    expect(evaluateCondition({ left: "triage this", operator: "notContains", right: "ship" })).toBe(true);
  });

  it("checks membership in arrays and objects", () => {
    expect(evaluateCondition({ left: ["bug", "feature"], operator: "contains", right: "bug" })).toBe(true);
    expect(evaluateCondition({ left: { a: 1 }, operator: "contains", right: "a" })).toBe(true);
    expect(evaluateCondition({ left: { a: 1 }, operator: "notContains", right: "b" })).toBe(true);
  });

  it("compares numbers and falls back to lexicographic strings", () => {
    expect(evaluateCondition({ left: 10, operator: "gt", right: 9 })).toBe(true);
    expect(evaluateCondition({ left: 9, operator: "gte", right: 9 })).toBe(true);
    expect(evaluateCondition({ left: 9, operator: "lt", right: 10 })).toBe(true);
    expect(evaluateCondition({ left: 10, operator: "lte", right: 9 })).toBe(false);
    expect(evaluateCondition({ left: "b", operator: "gt", right: "a" })).toBe(true);
    expect(evaluateCondition({ left: "not-a-number", operator: "gt", right: 1 })).toBe(false);
  });

  it("checks existence", () => {
    expect(evaluateCondition({ left: 0, operator: "exists" })).toBe(true);
    expect(evaluateCondition({ left: null, operator: "exists" })).toBe(false);
    expect(evaluateCondition({ left: undefined, operator: "notExists" })).toBe(true);
  });

  it("matches regular expressions and rejects bad or long patterns", () => {
    expect(evaluateCondition({ left: "KLYZ-104", operator: "matches", right: "^KLYZ-\\d+$" })).toBe(true);
    expect(evaluateCondition({ left: "nope", operator: "matches", right: "^KLYZ-" })).toBe(false);
    expect(() =>
      evaluateCondition({ left: "x", operator: "matches", right: "(" }),
    ).toThrow(ConditionError);
    expect(() =>
      evaluateCondition({ left: "x", operator: "matches", right: "a".repeat(201) }),
    ).toThrow(ConditionError);
  });

  it("rejects unknown operators", () => {
    expect(() =>
      evaluateCondition({ left: 1, operator: "teleports", right: 1 }),
    ).toThrow(ConditionError);
  });
});

describe("evaluateGroup", () => {
  const yes = { left: 1, operator: "eq", right: 1 } as const;
  const no = { left: 1, operator: "eq", right: 2 } as const;

  it("requires every condition for all", () => {
    expect(evaluateGroup({ combinator: "all", conditions: [yes, yes] })).toBe(true);
    expect(evaluateGroup({ combinator: "all", conditions: [yes, no] })).toBe(false);
  });

  it("requires one condition for any", () => {
    expect(evaluateGroup({ combinator: "any", conditions: [no, yes] })).toBe(true);
    expect(evaluateGroup({ combinator: "any", conditions: [no] })).toBe(false);
  });

  it("treats a bare condition as an all-group of one", () => {
    const group = singleConditionGroup({ left: "a", operator: "eq", right: "a" });
    expect(group.combinator).toBe("all");
    expect(evaluateGroup(group)).toBe(true);
  });
});
