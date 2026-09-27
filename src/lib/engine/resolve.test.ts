import { describe, expect, it } from "vitest";
import type { DataScope } from "@/lib/workflow/expressions";
import { ParseError, parseJsonLike, resolveConfig, resolveValue } from "./resolve";

const scope: DataScope = {
  setup: { vars: { flag: "yes", count: 3 } },
  trigger: { payload: { ticket: "KLYZ-104" } },
};

describe("resolveValue", () => {
  it("returns the raw value for a full-expression match", () => {
    expect(resolveValue("{{setup.vars.count}}", scope)).toBe(3);
    expect(resolveValue("{{setup.vars}}", scope)).toEqual({ flag: "yes", count: 3 });
  });

  it("maps a missing reference to null instead of undefined", () => {
    expect(resolveValue("{{nope.missing}}", scope)).toBeNull();
  });

  it("interpolates embedded references as text", () => {
    expect(resolveValue("ticket {{trigger.payload.ticket}}!", scope)).toBe(
      "ticket KLYZ-104!",
    );
  });

  it("resolves inside arrays and objects, leaving other values alone", () => {
    expect(resolveValue(["{{setup.vars.flag}}", 7], scope)).toEqual(["yes", 7]);
    expect(resolveValue({ a: "{{setup.vars.flag}}", b: true }, scope)).toEqual({
      a: "yes",
      b: true,
    });
    expect(resolveValue(42, scope)).toBe(42);
    expect(resolveValue(null, scope)).toBeNull();
  });

  it("resolves whole configs", () => {
    expect(resolveConfig({ left: "{{setup.vars.flag}}", operator: "eq" }, scope)).toEqual({
      left: "yes",
      operator: "eq",
    });
  });
});

describe("parseJsonLike", () => {
  it("parses strict JSON", () => {
    expect(parseJsonLike('{"a": 1}')).toEqual({ a: 1 });
  });

  it("accepts unquoted keys and bare expression values", () => {
    expect(parseJsonLike("{ email: {{user.email}} }")).toEqual({
      email: "{{user.email}}",
    });
  });

  it("accepts expressions at the top of arrays", () => {
    expect(parseJsonLike("[ {{a}}, {{b}} ]")).toEqual(["{{a}}", "{{b}}"]);
  });

  it("throws ParseError on garbage", () => {
    expect(() => parseJsonLike("{ nope")).toThrow(ParseError);
  });
});
