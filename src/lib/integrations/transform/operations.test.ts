import { describe, expect, it } from "vitest";
import { resolveValue } from "@/lib/engine/resolve";
import { applyOperation, type OperationRuntime } from "./operations";

const ITEMS = [
  { id: 1, status: "new", score: 8, profile: { name: "Ada" }, tags: ["a", "b"] },
  { id: 2, status: "done", score: 3, profile: { name: "Bo" }, tags: ["b"] },
  { id: 3, status: "new", score: 12, profile: { name: "Cy" }, tags: [] },
  { id: 4, status: "new", score: 8, profile: { name: "Di" }, tags: ["a"] },
];

function runtime(scope: Record<string, unknown> = {}): OperationRuntime {
  return {
    resolveItem: (raw, item, index) => resolveValue(raw, { ...scope, item, index }),
    scope,
  };
}

function run(
  operation: string,
  config: Record<string, unknown>,
  input: unknown,
  options: { rawConfig?: Record<string, unknown>; scope?: Record<string, unknown> } = {},
) {
  const rawConfig = options.rawConfig ?? config;
  return applyOperation(operation, config, rawConfig, input, runtime(options.scope));
}

describe("filter", () => {
  it("keeps items matching a plain path against a literal", () => {
    const result = run(
      "filter",
      { left: "status", operator: "eq", value: "new" },
      ITEMS,
      { rawConfig: { left: "status", operator: "eq", value: "new" } },
    );
    expect(result.count).toBe(3);
    expect((result.value as { id: number }[]).map((item) => item.id)).toEqual([1, 3, 4]);
  });

  it("accepts expressions on both sides, resolved per item", () => {
    const result = run(
      "filter",
      { operator: "gt", value: null },
      ITEMS,
      {
        rawConfig: { left: "{{item.score}}", operator: "gt", value: "{{item.id}}" },
      },
    );
    /* score > id: item1 8>1 ✓, item2 3>2 ✓, item3 12>3 ✓, item4 8>4 ✓ */
    expect(result.count).toBe(4);
  });

  it("compares against values resolved from the run scope", () => {
    const result = run(
      "filter",
      { operator: "gte", value: 8 },
      ITEMS,
      {
        rawConfig: { left: "{{item.score}}", operator: "gte", value: "{{threshold}}" },
        scope: { threshold: 12 },
      },
    );
    expect(result.count).toBe(1);
  });

  it("falls back to the run scope when the path is not on the item", () => {
    const result = run(
      "filter",
      { left: "flag", operator: "eq", value: "on" },
      ITEMS,
      { rawConfig: { left: "flag", operator: "eq", value: "on" }, scope: { flag: "on" } },
    );
    expect(result.count).toBe(4);
  });

  it("rejects non-array input with a clear code", () => {
    expect(() =>
      run("filter", { left: "a", operator: "eq", value: 1 }, { nope: true }),
    ).toThrowError(/list/);
    try {
      run("filter", { left: "a", operator: "eq", value: 1 }, "text");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("TRANSFORM_INVALID_CONFIG");
    }
  });
});

describe("map / pick / rename", () => {
  it("builds new objects from expressions and literals", () => {
    const result = run(
      "map",
      { fields: [] },
      ITEMS,
      {
        rawConfig: {
          fields: [
            { key: "email", value: "{{item.profile.name}}@example.com" },
            { key: "id", value: "{{item.id}}" },
            { key: "source", value: "signup" },
          ],
        },
      },
    );
    expect(result.value).toEqual([
      { email: "Ada@example.com", id: 1, source: "signup" },
      { email: "Bo@example.com", id: 2, source: "signup" },
      { email: "Cy@example.com", id: 3, source: "signup" },
      { email: "Di@example.com", id: 4, source: "signup" },
    ]);
  });

  it("picks nested paths and nulls missing ones", () => {
    const result = run("pick", { keys: "id, profile.name, missing" }, ITEMS);
    expect((result.value as Record<string, unknown>[])[0]).toEqual({
      id: 1,
      "profile.name": "Ada",
      missing: null,
    });
  });

  it("renames keys and keeps the rest", () => {
    const result = run(
      "rename",
      { mappings: [{ key: "name", value: "profile" }] },
      [{ profile: "Ada", keep: 1 }],
    );
    expect(result.value).toEqual([{ name: "Ada", keep: 1 }]);
  });
});

describe("sort / dedupe / flatten / slice", () => {
  it("sorts by a path with stable ties", () => {
    const asc = run("sort", { by: "score", direction: "asc" }, ITEMS);
    expect((asc.value as { id: number }[]).map((item) => item.id)).toEqual([2, 1, 4, 3]);
    const desc = run("sort", { by: "score", direction: "desc" }, ITEMS);
    expect((desc.value as { id: number }[]).map((item) => item.id)).toEqual([3, 1, 4, 2]);
  });

  it("de-duplicates by a field and by the whole item", () => {
    const byScore = run("dedupe", { by: "score" }, ITEMS);
    expect(byScore.count).toBe(3);
    const whole = run("dedupe", { by: "" }, [
      { id: 1 },
      { id: 1 },
      { id: 2 },
    ]);
    expect(whole.count).toBe(2);
  });

  it("flattens nested arrays to the requested depth", () => {
    const input = [[1, [2, [3]]], [4]];
    expect(run("flatten", { depth: 1 }, input).value).toEqual([1, [2, [3]], 4]);
    expect(run("flatten", { depth: 2 }, input).value).toEqual([1, 2, [3], 4]);
    expect(run("flatten", { depth: 0 }, input).value).toEqual(input);
  });

  it("slices with offset and limit", () => {
    const result = run("slice", { offset: 1, limit: 2 }, ITEMS);
    expect((result.value as { id: number }[]).map((item) => item.id)).toEqual([2, 3]);
  });

  it("returns null for first/last on an empty list", () => {
    expect(run("first", {}, []).value).toBeNull();
    expect(run("last", {}, []).value).toBeNull();
    expect(run("first", {}, ITEMS).value).toMatchObject({ id: 1 });
    expect(run("last", {}, ITEMS).value).toMatchObject({ id: 4 });
  });
});

describe("aggregate / get / json", () => {
  it("aggregates numeric values and ignores non-numeric ones", () => {
    const rows = [{ amount: 10 }, { amount: "20" }, { amount: "x" }, { amount: 30 }];
    expect(run("aggregate", { fn: "sum", path: "amount" }, rows).value).toBe(60);
    expect(run("aggregate", { fn: "avg", path: "amount" }, rows).value).toBe(20);
    expect(run("aggregate", { fn: "min", path: "amount" }, rows).value).toBe(10);
    expect(run("aggregate", { fn: "max", path: "amount" }, rows).value).toBe(30);
    expect(run("aggregate", { fn: "count", path: "" }, rows).value).toBe(4);
  });

  it("requires a path for value aggregates", () => {
    expect(() => run("aggregate", { fn: "sum", path: "" }, ITEMS)).toThrowError(/path/i);
  });

  it("gets a path, falling back to the run scope", () => {
    expect(run("get", { path: "profile.name" }, ITEMS[0]).value).toBe("Ada");
    expect(run("get", { path: "now" }, null, { scope: { now: "2026-01-01" } }).value).toBe(
      "2026-01-01",
    );
    expect(run("get", { path: "nope" }, ITEMS[0]).value).toBeNull();
  });

  it("round-trips JSON and reports bad JSON honestly", () => {
    const text = run("to_json", {}, { a: 1 });
    expect(text.value).toBe('{"a":1}');
    const parsed = run("from_json", {}, '{"a":1}');
    expect(parsed.value).toEqual({ a: 1 });
    try {
      run("from_json", {}, "{oops");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("TRANSFORM_INVALID_EXPRESSION");
    }
  });

  it("rejects unknown operations", () => {
    expect(() => run("teleport", {}, [])).toThrowError(/Unknown transform operation/);
  });
});
