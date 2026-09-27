import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_INPUT, parseRunInput } from "./run-input";

describe("parseRunInput", () => {
  it("accepts an object payload", () => {
    expect(parseRunInput('{"items": ["alpha"], "n": 2}')).toEqual({
      ok: true,
      input: { items: ["alpha"], n: 2 },
    });
  });

  it("treats empty input as an empty payload", () => {
    expect(parseRunInput("   \n  ")).toEqual({ ok: true, input: {} });
  });

  it("has a default payload that parses", () => {
    const parsed = parseRunInput(DEFAULT_RUN_INPUT);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.input.items).toEqual(["alpha", "beta", "gamma"]);
  });

  it("rejects invalid JSON before anything runs", () => {
    const parsed = parseRunInput('{"items": ["alpha"');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("not valid JSON");
      expect(parsed.error).toContain("Nothing was started");
    }
  });

  it("rejects JSON that is not an object", () => {
    for (const source of ['[1, 2, 3]', '"just a string"', "42", "null", "true"]) {
      const parsed = parseRunInput(source);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("must be a JSON object");
    }
  });

  it("accepts an empty object", () => {
    expect(parseRunInput("{}")).toEqual({ ok: true, input: {} });
  });
});
