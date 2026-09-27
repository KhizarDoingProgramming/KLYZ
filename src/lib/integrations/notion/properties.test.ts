import { describe, expect, it } from "vitest";
import { EngineError } from "@/lib/engine/types";
import { NOTION_ERRORS } from "../errors";
import {
  SUPPORTED_PROPERTY_TYPES,
  buildProperties,
  normalizeProperties,
  textToBlocks,
  type PropertySchema,
  type PropertyType,
} from "./properties";

function expectError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

function buildOne(value: unknown, type: string): unknown {
  const built = buildProperties({
    values: { Field: value },
    types: { Field: type as PropertyType },
  });
  return built.Field;
}

describe("value coercion", () => {
  it("builds title and rich text with capped content", () => {
    expect(buildOne("Hello", "title")).toEqual({
      title: [{ type: "text", text: { content: "Hello" } }],
    });
    expect(buildOne("Hello", "rich_text")).toEqual({
      rich_text: [{ type: "text", text: { content: "Hello" } }],
    });

    const long = buildOne("x".repeat(2500), "rich_text") as {
      rich_text: Array<{ text: { content: string } }>;
    };
    expect(long.rich_text[0]?.text.content).toHaveLength(2000);
  });

  it("parses numbers and clears on an empty value", () => {
    expect(buildOne("42", "number")).toEqual({ number: 42 });
    expect(buildOne(7, "number")).toEqual({ number: 7 });
    expect(buildOne("3.5", "number")).toEqual({ number: 3.5 });
    expect(buildOne("", "number")).toEqual({ number: null });
    expect(buildOne(null, "number")).toEqual({ number: null });
  });

  it("refuses a non-numeric number", () => {
    expectError(() => buildOne("many", "number"), NOTION_ERRORS.configInvalid);
    expectError(() => buildOne({}, "number"), NOTION_ERRORS.configInvalid);
  });

  it("reads checkbox truthiness", () => {
    for (const truthy of ["true", "TRUE", " yes ", "1", "on", true]) {
      expect(buildOne(truthy, "checkbox")).toEqual({ checkbox: true });
    }
    for (const falsy of ["false", "no", "0", "", false, null]) {
      expect(buildOne(falsy, "checkbox")).toEqual({ checkbox: false });
    }
  });

  it("wraps select and status as option names", () => {
    expect(buildOne("Triage", "select")).toEqual({ select: { name: "Triage" } });
    expect(buildOne("Done", "status")).toEqual({ status: { name: "Done" } });
    expect(buildOne("", "select")).toEqual({ select: null });
  });

  it("splits multi_select on commas and drops empties", () => {
    expect(buildOne("bug, needs-triage ,, urgent", "multi_select")).toEqual({
      multi_select: [{ name: "bug" }, { name: "needs-triage" }, { name: "urgent" }],
    });
    expect(buildOne("", "multi_select")).toEqual({ multi_select: [] });
    expect(buildOne(["a", " b "], "multi_select")).toEqual({
      multi_select: [{ name: "a" }, { name: "b" }],
    });
  });

  it("passes url, email and date through", () => {
    expect(buildOne("https://klyz.dev", "url")).toEqual({ url: "https://klyz.dev" });
    expect(buildOne("", "url")).toEqual({ url: "" });
    expect(buildOne("ops@klyz.dev", "email")).toEqual({ email: "ops@klyz.dev" });
    expect(buildOne("2026-09-26", "date")).toEqual({ date: { start: "2026-09-26" } });
    expect(buildOne("", "date")).toEqual({ date: null });
  });

  it("refuses property types it cannot write", () => {
    expectError(() => buildOne("x", "people"), NOTION_ERRORS.propertyUnsupported);
    expectError(() => buildOne("x", "relation"), NOTION_ERRORS.propertyUnsupported);
    try {
      buildOne("x", "formula");
    } catch (error) {
      expect((error as EngineError).hint).toContain("rich_text");
      expect((error as EngineError).hint).toContain("multi_select");
    }
    for (const type of SUPPORTED_PROPERTY_TYPES) {
      expect(() => buildOne("1", type)).not.toThrow();
    }
  });
});

describe("buildProperties", () => {
  const schema: PropertySchema[] = [
    { name: "Name", type: "title" },
    { name: "Status", type: "select" },
    { name: "Score", type: "number" },
  ];

  it("types from the schema and places the title in the title property", () => {
    expect(
      buildProperties({
        values: { Status: "Triage", Score: "3" },
        schema,
        title: "Kickoff",
      }),
    ).toEqual({
      Name: { title: [{ type: "text", text: { content: "Kickoff" } }] },
      Status: { select: { name: "Triage" } },
      Score: { number: 3 },
    });
  });

  it("defaults unknown properties to rich_text without a schema", () => {
    expect(buildProperties({ values: { Notes: "hello" }, title: "Child" })).toEqual({
      title: { title: [{ type: "text", text: { content: "Child" } }] },
      Notes: { rich_text: [{ type: "text", text: { content: "hello" } }] },
    });
  });

  it("lets explicit types override the schema", () => {
    expect(
      buildProperties({ values: { Status: "Triage" }, types: { Status: "rich_text" }, schema }),
    ).toEqual({ Status: { rich_text: [{ type: "text", text: { content: "Triage" } }] } });
  });

  it("rejects a property the database does not have", () => {
    try {
      buildProperties({ values: { Priority: "high" }, schema });
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).code).toBe(NOTION_ERRORS.configInvalid);
      expect((error as EngineError).message).toContain("Priority");
      return;
    }
    throw new Error("expected a config error for the unknown property");
  });

  it("uses the configured title property name from explicit types", () => {
    expect(
      buildProperties({ values: {}, types: { Heading: "title" }, title: "Page" }),
    ).toEqual({ Heading: { title: [{ type: "text", text: { content: "Page" } }] } });
  });
});

describe("normalizeProperties", () => {
  it("reads key/value rows and plain records", () => {
    expect(
      normalizeProperties([
        { id: "kv_1", key: "Name", value: "Ada" },
        { id: "kv_2", key: " Score ", value: "7" },
        { id: "kv_3", key: " ", value: "ignored" },
      ]),
    ).toEqual({ Name: "Ada", " Score ": "7" });
    expect(normalizeProperties(undefined)).toEqual({});
    expect(normalizeProperties(null)).toEqual({});
    expect(normalizeProperties("nope")).toEqual({});
    expect(normalizeProperties({ Ready: true, Count: 3 })).toEqual({ Ready: true, Count: 3 });
  });

  it("flattens a Notion property payload back to plain values", () => {
    expect(
      normalizeProperties({
        Name: { title: [{ plain_text: "Kickoff" }] },
        Notes: { rich_text: [{ plain_text: "one" }, { plain_text: " two" }] },
        Score: { number: 7 },
        Done: { checkbox: true },
        Status: { status: { name: "Doing" } },
        Tags: { multi_select: [{ name: "a" }, { name: "b" }] },
        Link: { url: "https://klyz.dev" },
        Mail: { email: "ops@klyz.dev" },
        When: { date: { start: "2026-09-26" } },
        Cleared: { date: null },
      }),
    ).toEqual({
      Name: "Kickoff",
      Notes: "one two",
      Score: 7,
      Done: true,
      Status: "Doing",
      Tags: ["a", "b"],
      Link: "https://klyz.dev",
      Mail: "ops@klyz.dev",
      When: "2026-09-26",
      Cleared: null,
    });
  });

  it("round-trips what buildProperties produces", () => {
    const values = {
      Heading: "Hello",
      Tags: "a,b",
      When: "2026-09-26",
      Done: "yes",
      Count: 7,
      Link: "https://klyz.dev",
    };
    const types = {
      Heading: "title",
      Tags: "multi_select",
      When: "date",
      Done: "checkbox",
      Count: "number",
      Link: "url",
    } as Record<string, PropertyType>;

    const built = buildProperties({ values, types });
    expect(normalizeProperties(built)).toEqual({
      Heading: "Hello",
      Tags: ["a", "b"],
      When: "2026-09-26",
      Done: true,
      Count: 7,
      Link: "https://klyz.dev",
    });
  });
});

describe("textToBlocks", () => {
  it("makes one paragraph per non-empty line", () => {
    expect(textToBlocks("first\nsecond")).toEqual([
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: "first" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: "second" } }] },
      },
    ]);
    expect(textToBlocks("only")).toHaveLength(1);
  });

  it("skips blank and whitespace-only lines", () => {
    expect(textToBlocks("")).toEqual([]);
    expect(textToBlocks("\n \n\t\n")).toEqual([]);
    expect(textToBlocks("a\n\n \nb")).toHaveLength(2);
    expect(textToBlocks("a\r\nb")).toHaveLength(2);
  });

  it("caps each line at 2000 characters", () => {
    const blocks = textToBlocks("x".repeat(2500)) as Array<{
      paragraph: { rich_text: Array<{ text: { content: string } }> };
    }>;
    expect(blocks[0]?.paragraph.rich_text[0]?.text.content).toHaveLength(2000);
  });
});
