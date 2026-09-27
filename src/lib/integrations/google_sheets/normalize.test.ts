import { describe, expect, it } from "vitest";
import {
  extractHeaders,
  headerKey,
  normalizeRows,
  parseUpdatedRow,
  spreadsheetUrl,
} from "./normalize";

describe("extractHeaders", () => {
  it("reads the first row as text and trims it", () => {
    expect(extractHeaders([[" Email ", "Name", 1]])).toEqual(["Email", "Name", "1"]);
    expect(extractHeaders([[]])).toEqual([]);
    expect(extractHeaders([])).toEqual([]);
    expect(extractHeaders(undefined)).toEqual([]);
    expect(extractHeaders([["", null, "Intent"]])).toEqual(["", "", "Intent"]);
  });
});

describe("headerKey", () => {
  it("de-duplicates repeated headers", () => {
    const seen = new Map<string, number>();
    expect(headerKey("Email", seen)).toBe("Email");
    expect(headerKey("Email", seen)).toBe("Email (2)");
    expect(headerKey("email", seen)).toBe("email");
    expect(headerKey("Email", seen)).toBe("Email (3)");
  });

  it("falls back to the column letter when the header is blank", () => {
    const seen = new Map<string, number>();
    expect(headerKey("", seen, "C")).toBe("C");
    expect(headerKey("   ", seen, "D")).toBe("D");
    expect(headerKey("", seen)).toBe("");
  });
});

describe("normalizeRows without headers", () => {
  it("keys rows by column letter and numbers them from the range start", () => {
    const { rows, columns, rowCount } = normalizeRows({
      values: [
        ["Dana", "dana@northwind.io"],
        ["Sam", "sam@acme.io"],
      ],
      startRow: 5,
    });
    expect(columns).toEqual(["A", "B"]);
    expect(rowCount).toBe(2);
    expect(rows[0]).toEqual({
      rowNumber: 5,
      values: { A: "Dana", B: "dana@northwind.io" },
      cells: ["Dana", "dana@northwind.io"],
    });
    expect(rows[1]?.rowNumber).toBe(6);
  });

  it("keeps text, numbers and booleans as they came back", () => {
    const { rows } = normalizeRows({ values: [[1_000, true, "draft"]], startRow: 1 });
    expect(rows[0]?.cells).toEqual([1_000, true, "draft"]);
    expect(rows[0]?.values).toEqual({ A: 1_000, B: true, C: "draft" });
  });

  it("returns nothing for an empty range", () => {
    expect(normalizeRows({ values: [], startRow: 1 })).toEqual({
      rows: [],
      columns: [],
      rowCount: 0,
    });
    expect(normalizeRows({ values: undefined, startRow: 1 }).rowCount).toBe(0);
  });
});

describe("normalizeRows with headers", () => {
  it("consumes the first row as headers and numbers data rows absolutely", () => {
    const values = [
      ["Email", "Name"],
      ["dana@northwind.io", "Dana"],
      ["sam@acme.io", "Sam"],
    ];
    const { rows, columns, rowCount } = normalizeRows({
      values,
      startRow: 5,
      headers: extractHeaders(values),
    });
    expect(columns).toEqual(["Email", "Name"]);
    expect(rowCount).toBe(2);
    expect(rows[0]).toEqual({
      rowNumber: 6,
      values: { Email: "dana@northwind.io", Name: "Dana" },
      cells: ["dana@northwind.io", "Dana"],
    });
    expect(rows[1]?.rowNumber).toBe(7);
  });

  it("falls back to letters for blank headers and suffixes duplicates", () => {
    const values = [["Email", "", "Email", null], ["a", "b", "c", "d"]];
    const { rows, columns } = normalizeRows({
      values,
      startRow: 1,
      headers: extractHeaders(values),
    });
    expect(columns).toEqual(["Email", "B", "Email (2)", "D"]);
    expect(rows[0]?.values).toEqual({ Email: "a", B: "b", "Email (2)": "c", D: "d" });
  });
});

describe("positional cells", () => {
  it("pads the cells Sheets trimmed with null instead of dropping them", () => {
    const values = [["Email", "Name", "Intent"], ["dana@northwind.io"]];
    const { rows } = normalizeRows({
      values,
      startRow: 1,
      headers: extractHeaders(values),
    });
    expect(rows[0]?.cells).toEqual(["dana@northwind.io", null, null]);
    expect(rows[0]?.values).toEqual({
      Email: "dana@northwind.io",
      Name: null,
      Intent: null,
    });
  });

  it("keeps cells past the last header", () => {
    const values = [["Email"], ["dana@northwind.io", "extra", 7]];
    const { rows, columns } = normalizeRows({
      values,
      startRow: 1,
      headers: extractHeaders(values),
    });
    expect(columns).toEqual(["Email"]);
    expect(rows[0]?.cells).toEqual(["dana@northwind.io", "extra", 7]);
    expect(rows[0]?.values).toEqual({ Email: "dana@northwind.io", B: "extra", C: 7 });
  });
});

describe("parseUpdatedRow", () => {
  it("reads the row out of an updated range", () => {
    expect(parseUpdatedRow("Leads!A100:D100")).toBe(100);
    expect(parseUpdatedRow("A1")).toBe(1);
    expect(parseUpdatedRow("Leads!B7")).toBe(7);
    expect(parseUpdatedRow("'Sales 2026'!A12:D12")).toBe(12);
  });

  it("returns 0 when the range carries no row", () => {
    expect(parseUpdatedRow("")).toBe(0);
    expect(parseUpdatedRow("Leads!A:D")).toBe(0);
    expect(parseUpdatedRow("2:2")).toBe(0);
  });
});

describe("spreadsheetUrl", () => {
  it("links to the sheet a node wrote to", () => {
    expect(spreadsheetUrl("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms")).toBe(
      "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
    );
  });
});
