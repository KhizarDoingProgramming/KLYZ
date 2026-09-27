import { describe, expect, it } from "vitest";
import { EngineError } from "@/lib/engine/types";
import {
  buildRange,
  columnToLetter,
  entriesFromKeyValue,
  letterToColumn,
  parseColumnSpan,
  parseLimit,
  parseRowNumber,
  parseSpreadsheetId,
  quoteSheetName,
  rowScopedRange,
  sheetFromRange,
  valuesFromKeyValue,
} from "./config";

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

const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

describe("parseSpreadsheetId", () => {
  it("accepts a bare id", () => {
    expect(parseSpreadsheetId(ID)).toBe(ID);
    expect(parseSpreadsheetId(`  ${ID}  `)).toBe(ID);
  });

  it("extracts the id from a pasted URL, hash and all", () => {
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toBe(ID);
    expect(parseSpreadsheetId(`http://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`)).toBe(
      ID,
    );
    expect(
      parseSpreadsheetId(`https://docs.google.com/spreadsheets/u/0/d/${ID}/edit#gid=7`),
    ).toBe(ID);
  });

  it("refuses anything that is not a spreadsheet", () => {
    for (const bad of [
      "",
      "   ",
      "short",
      "https://docs.google.com/spreadsheets/d/abc/edit",
      "https://example.com/spreadsheets/d/notanid/edit",
      "1BxiMVs0XRA5nFMdKvBdBZjgmUUqpt lbs74OgvE2upms",
      "sheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
    ]) {
      expectError(() => parseSpreadsheetId(bad), "SHEETS_SPREADSHEET_INVALID");
    }
  });
});

describe("buildRange", () => {
  it("uses a bare range as it is", () => {
    expect(buildRange("", "A:D")).toBe("A:D");
    expect(buildRange("", "A1:F200")).toBe("A1:F200");
    expect(buildRange("Leads", "Leads!A:D")).toBe("Leads!A:D");
  });

  it("prefixes the sheet when the range does not name one", () => {
    expect(buildRange("Leads", "A:D")).toBe("Leads!A:D");
    expect(buildRange("Leads", "")).toBe("Leads");
    expect(buildRange("", "")).toBe("");
  });

  it("quotes a sheet name A1 would misread, doubling any quote inside it", () => {
    expect(buildRange("Sales 2026", "A:D")).toBe("'Sales 2026'!A:D");
    expect(buildRange("O'Brien", "A1")).toBe("'O''Brien'!A1");
    expect(quoteSheetName("Leads")).toBe("Leads");
    expect(quoteSheetName("Lead's")).toBe("'Lead''s'");
    expect(quoteSheetName("")).toBe("");
  });

  it("reads the tab back out of a qualified range", () => {
    expect(sheetFromRange("Leads!A:D")).toBe("Leads");
    expect(sheetFromRange("'Sales 2026'!A:D")).toBe("Sales 2026");
    expect(sheetFromRange("'O''Brien'!A1")).toBe("O'Brien");
    expect(sheetFromRange("A:D")).toBe("");
  });
});

describe("column letters", () => {
  it("converts both ways", () => {
    expect(columnToLetter(1)).toBe("A");
    expect(columnToLetter(26)).toBe("Z");
    expect(columnToLetter(27)).toBe("AA");
    expect(columnToLetter(702)).toBe("ZZ");
    expect(columnToLetter(703)).toBe("AAA");
    expect(letterToColumn("A")).toBe(1);
    expect(letterToColumn("Z")).toBe(26);
    expect(letterToColumn("AA")).toBe(27);
    expect(letterToColumn(" a ")).toBe(1);
    expect(letterToColumn("")).toBe(0);
    expect(letterToColumn("1")).toBe(0);
  });
});

describe("parseColumnSpan", () => {
  it("reads the columns of a range", () => {
    expect(parseColumnSpan("A:D")).toEqual({ start: "A", end: "D" });
    expect(parseColumnSpan("A1:D50")).toEqual({ start: "A", end: "D" });
    expect(parseColumnSpan("A")).toEqual({ start: "A", end: "A" });
    expect(parseColumnSpan("b2")).toEqual({ start: "B", end: "B" });
    expect(parseColumnSpan("Leads!A1:D50")).toEqual({ start: "A", end: "D" });
    expect(parseColumnSpan("'Sales 2026'!C:G")).toEqual({ start: "C", end: "G" });
  });

  it("returns null when the range carries no columns", () => {
    expect(parseColumnSpan("")).toBeNull();
    expect(parseColumnSpan("2:2")).toBeNull();
    expect(parseColumnSpan("Leads!")).toBeNull();
  });
});

describe("rowScopedRange", () => {
  it("pins one row to the columns of the range", () => {
    expect(rowScopedRange("Leads", { start: "A", end: "D" }, 5)).toBe("Leads!A5:D5");
    expect(rowScopedRange("", { start: "A", end: "E" }, 14)).toBe("A14:E14");
    expect(rowScopedRange("Sales 2026", { start: "B", end: "B" }, 2)).toBe("'Sales 2026'!B2:B2");
  });
});

describe("valuesFromKeyValue", () => {
  it("orders letter keys by column", () => {
    const entries = [
      { id: "k1", key: "D", value: "4" },
      { id: "k2", key: "A", value: "1" },
      { id: "k3", key: "C", value: "3" },
      { id: "k4", key: "B", value: "2" },
    ];
    expect(valuesFromKeyValue(entries)).toEqual(["1", "2", "3", "4"]);
    expect(entriesFromKeyValue(entries).map((entry) => entry.key)).toEqual(["A", "B", "C", "D"]);
  });

  it("keeps plain keys in the order they were arranged", () => {
    const entries = [
      { key: "Email", value: "dana@northwind.io" },
      { key: "Name", value: "Dana" },
      { key: "Intent", value: "demo" },
    ];
    expect(valuesFromKeyValue(entries)).toEqual(["dana@northwind.io", "Dana", "demo"]);
    expect(entriesFromKeyValue(entries)).toEqual(entries);
  });

  it("accepts values that are not text", () => {
    expect(valuesFromKeyValue([{ key: "A", value: 42 }])).toEqual(["42"]);
    expect(valuesFromKeyValue([{ key: "A", value: null }])).toEqual([""]);
    expect(valuesFromKeyValue([{ key: "A" }])).toEqual([""]);
  });

  it("refuses an empty result", () => {
    for (const bad of [
      [],
      undefined,
      null,
      "A=B",
      [{ key: "  ", value: "x" }],
      [{ value: "orphan" }],
    ]) {
      expectError(() => valuesFromKeyValue(bad), "SHEETS_CONFIG_INVALID");
    }
    expect(entriesFromKeyValue(undefined)).toEqual([]);
  });
});

describe("parseLimit", () => {
  it("defaults to 100 and clamps to 1..5000", () => {
    expect(parseLimit(undefined)).toBe(100);
    expect(parseLimit(null)).toBe(100);
    expect(parseLimit("")).toBe(100);
    expect(parseLimit("not a number")).toBe(100);
    expect(parseLimit(250)).toBe(250);
    expect(parseLimit("250")).toBe(250);
    expect(parseLimit(3.7)).toBe(3);
    expect(parseLimit(0)).toBe(1);
    expect(parseLimit(-20)).toBe(1);
    expect(parseLimit(99_999)).toBe(5000);
  });
});

describe("parseRowNumber", () => {
  it("accepts positive integers however they arrive", () => {
    expect(parseRowNumber(14)).toBe(14);
    expect(parseRowNumber("14")).toBe(14);
    expect(parseRowNumber("  14 ")).toBe(14);
    expect(parseRowNumber(1)).toBe(1);
  });

  it("rejects zero, negatives, fractions and text", () => {
    for (const bad of [0, -1, 1.5, "abc", "", null, undefined, {}, " "]) {
      expectError(() => parseRowNumber(bad), "SHEETS_RANGE_INVALID");
    }
  });
});
