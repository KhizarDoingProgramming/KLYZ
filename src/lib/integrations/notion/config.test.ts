import { describe, expect, it } from "vitest";
import { EngineError } from "@/lib/engine/types";
import { NOTION_ERRORS } from "../errors";
import { dashed, parseNotionId, parseParentType, plainText } from "./config";

const CANONICAL = "8f2a91c0d17b4c2ea1b0c4d5e6f7a8b9";
const DASHED = "8f2a91c0-d17b-4c2e-a1b0-c4d5e6f7a8b9";

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

describe("parseNotionId", () => {
  it("accepts the bare 32-character id and lowercases it", () => {
    expect(parseNotionId(CANONICAL)).toBe(CANONICAL);
    expect(parseNotionId("8F2A91C0D17B4C2EA1B0C4D5E6F7A8B9")).toBe(CANONICAL);
    expect(parseNotionId(`  ${CANONICAL}  `)).toBe(CANONICAL);
  });

  it("accepts the dashed UUID form", () => {
    expect(parseNotionId(DASHED)).toBe(CANONICAL);
    expect(parseNotionId("8F2A91C0-D17B-4C2E-A1B0-C4D5E6F7A8B9")).toBe(CANONICAL);
  });

  it("accepts a notion.so URL with a workspace slug", () => {
    expect(parseNotionId(`https://www.notion.so/Acme-Board-${CANONICAL}`)).toBe(CANONICAL);
    expect(parseNotionId(`https://notion.so/Acme-Board-${CANONICAL}?pvs=4`)).toBe(CANONICAL);
    expect(parseNotionId(`http://www.notion.so/${CANONICAL}`)).toBe(CANONICAL);
  });

  it("takes the resource id, not the view id, from a database URL", () => {
    expect(parseNotionId(`https://www.notion.so/d/${DASHED}?v=${"3c7e1ab94f2d4a6b8c0d1e2f3a4b5c6d"}`)).toBe(
      CANONICAL,
    );
    expect(
      parseNotionId(`https://www.notion.so/Acme-Board/${CANONICAL}?v=3c7e1ab94f2d4a6b8c0d1e2f3a4b5c6d`),
    ).toBe(CANONICAL);
    expect(parseNotionId(`https://www.notion.so/${DASHED}?pvs=4`)).toBe(CANONICAL);
  });

  it("refuses anything that is not an id or a Notion URL", () => {
    const garbage = [
      "",
      "   ",
      "not-a-page",
      "8f2a91c0d17b4c2ea1b0c4d5e6f7a8b",
      "8f2a91c0d17b4c2ea1b0c4d5e6f7a8b99",
      "zzzza1b2c3d4e5f6a7b8c9d0e1f2a3b4",
      "https://example.com/nothing-here",
      "Kickoff page",
      null as unknown as string,
      undefined as unknown as string,
    ];
    for (const bad of garbage) {
      expectError(() => parseNotionId(bad), NOTION_ERRORS.pageIdInvalid);
    }
  });
});

describe("dashed", () => {
  it("formats the canonical id as a UUID", () => {
    expect(dashed(CANONICAL)).toBe(DASHED);
    expect(dashed(DASHED)).toBe(DASHED);
    expect(dashed(CANONICAL.toUpperCase())).toBe(DASHED);
  });

  it("refuses input that is not an id", () => {
    expectError(() => dashed("not-an-id"), NOTION_ERRORS.pageIdInvalid);
    expectError(() => dashed(""), NOTION_ERRORS.pageIdInvalid);
  });
});

describe("parseParentType", () => {
  it("defaults to a database parent", () => {
    expect(parseParentType(undefined)).toBe("database");
    expect(parseParentType("")).toBe("database");
    expect(parseParentType("database")).toBe("database");
    expect(parseParentType(" Database ")).toBe("database");
    expect(parseParentType("page")).toBe("page");
    expect(parseParentType("PAGE")).toBe("page");
  });

  it("refuses anything else", () => {
    for (const bad of ["workspace", "folder", "database_id", 42]) {
      expectError(() => parseParentType(bad), NOTION_ERRORS.parentInvalid);
    }
  });
});

describe("plainText", () => {
  it("trims strings and stringifies the rest", () => {
    expect(plainText("  hello  ")).toBe("hello");
    expect(plainText(42)).toBe("42");
    expect(plainText(null)).toBe("");
    expect(plainText(undefined)).toBe("");
  });
});
