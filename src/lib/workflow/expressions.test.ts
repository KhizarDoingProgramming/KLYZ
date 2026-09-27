import { describe, it, expect } from "vitest";
import { resolveValue } from "@/lib/engine/resolve";

describe("Expression Evaluator", () => {
  it("evaluates literals", () => {
    expect(resolveValue("{{ 42 }}", {})).toBe(42);
    expect(resolveValue('{{ "hello" }}', {})).toBe("hello");
    expect(resolveValue("{{ true }}", {})).toBe(true);
    expect(resolveValue("{{ false }}", {})).toBe(false);
    expect(resolveValue("{{ null }}", {})).toBe(null);
  });

  it("evaluates paths", () => {
    const scope = { user: { name: "Alice", age: 30 } };
    expect(resolveValue("{{ user.name }}", scope)).toBe("Alice");
    expect(resolveValue("{{ user.age }}", scope)).toBe(30);
  });

  it("evaluates arithmetic", () => {
    const scope = { a: 10, b: 5 };
    expect(resolveValue("{{ a + b }}", scope)).toBe(15);
    expect(resolveValue("{{ a - b }}", scope)).toBe(5);
    expect(resolveValue("{{ a * b }}", scope)).toBe(50);
    expect(resolveValue("{{ a / b }}", scope)).toBe(2);
    expect(resolveValue("{{ a % 3 }}", scope)).toBe(1);
    expect(resolveValue("{{ (a + b) * 2 }}", scope)).toBe(30);
  });

  it("evaluates string operations", () => {
    const scope = { text: "  Hello World  " };
    expect(resolveValue("{{ trim(text) }}", scope)).toBe("Hello World");
    expect(resolveValue("{{ lowercase(trim(text)) }}", scope)).toBe("hello world");
    expect(resolveValue("{{ uppercase(trim(text)) }}", scope)).toBe("HELLO WORLD");
    expect(resolveValue('{{ length("hello") }}', scope)).toBe(5);
    expect(resolveValue('{{ concatenate("a", "b", "c") }}', scope)).toBe("abc");
  });

  it("evaluates logic", () => {
    expect(resolveValue("{{ true && false }}", {})).toBe(false);
    expect(resolveValue("{{ true || false }}", {})).toBe(true);
    expect(resolveValue("{{ !true }}", {})).toBe(false);
    expect(resolveValue("{{ 10 > 5 && 5 < 10 }}", {})).toBe(true);
    expect(resolveValue("{{ 10 >= 10 }}", {})).toBe(true);
    expect(resolveValue("{{ 10 <= 10 }}", {})).toBe(true);
    expect(resolveValue("{{ 10 == 10 }}", {})).toBe(true);
    expect(resolveValue("{{ 10 != 5 }}", {})).toBe(true);
  });

  it("evaluates arrays and functions", () => {
    const scope = { arr: [1, 2, 3] };
    expect(resolveValue("{{ length(arr) }}", scope)).toBe(3);
    expect(resolveValue("{{ first(arr) }}", scope)).toBe(1);
    expect(resolveValue("{{ last(arr) }}", scope)).toBe(3);
    expect(resolveValue("{{ contains(arr, 2) }}", scope)).toBe(true);
    expect(resolveValue("{{ contains(arr, 4) }}", scope)).toBe(false);
    expect(resolveValue("{{ empty(arr) }}", scope)).toBe(false);
  });
});
