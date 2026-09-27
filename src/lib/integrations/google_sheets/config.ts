import { SHEETS_ERRORS, REMEDIATION, integrationError } from "../errors";

/**
 * Google Sheets input validation.
 *
 * A node hands Google three things: a spreadsheet (usually pasted as a
 * URL), an A1 range and a row of values. All three are shaped here, so
 * a mistake fails the step with a hint instead of surfacing as a 400
 * from an endpoint that echoes the offending range back verbatim.
 */

const SPREADSHEET_ID_RE = /^[A-Za-z0-9_-]{10,}$/;
const PASTED_ID_RE = /\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/;
/** Sheet names that need no quoting in A1 notation. */
const PLAIN_SHEET_RE = /^[A-Za-z_]+$/;
/** `A`, `A1`, `A1:D50` — letters, optionally followed by a row number. */
const COLUMN_TOKEN_RE = /^[A-Za-z]{1,3}\d*$/;

export const SHEET_RANGE_HELP =
  "A1 notation without the spreadsheet, e.g. A:D, A1:F200 or 2:2.";

export const APPEND_RANGE_HELP = `${SHEET_RANGE_HELP} Appends land in the first empty row of it.`;

function invalid(code: string, message: string, hint: string): never {
  throw integrationError(code, message, { hint, remediation: REMEDIATION.inspect });
}

/* ------------------------------------------------------------------ */
/* Spreadsheet                                                         */
/* ------------------------------------------------------------------ */

/** Accepts a bare id or a pasted `…/spreadsheets/d/<id>/edit` URL. */
export function parseSpreadsheetId(raw: string): string {
  const value = String(raw ?? "").trim();
  if (value) {
    const pasted = value.match(PASTED_ID_RE);
    const candidate = pasted?.[1] ?? value;
    if (SPREADSHEET_ID_RE.test(candidate)) return candidate;
  }
  return invalid(
    SHEETS_ERRORS.spreadsheetInvalid,
    value ? `"${value.slice(0, 80)}" is not a spreadsheet.` : "This step has no spreadsheet.",
    "Paste the spreadsheet URL or its id — the URL looks like docs.google.com/spreadsheets/d/…/edit.",
  );
}

/* ------------------------------------------------------------------ */
/* Ranges                                                              */
/* ------------------------------------------------------------------ */

/** Quotes a tab name only when A1 notation would misread it. */
export function quoteSheetName(sheet: string): string {
  const name = String(sheet ?? "").trim();
  if (!name) return "";
  if (PLAIN_SHEET_RE.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

/**
 * Joins the tab and the range into one A1 reference. A range that
 * already names its sheet wins; an empty range means the whole tab.
 */
export function buildRange(sheet: string, range: string): string {
  const target = String(range ?? "").trim();
  if (target.includes("!")) return target;
  const tab = quoteSheetName(sheet);
  if (!tab) return target;
  return target ? `${tab}!${target}` : tab;
}

/** The tab a range qualifies itself with, unquoted, or "" when it has none. */
export function sheetFromRange(range: string): string {
  const value = String(range ?? "").trim();
  const separator = value.indexOf("!");
  if (separator <= 0) return "";
  const tab = value.slice(0, separator).trim();
  if (tab.length > 1 && tab.startsWith("'") && tab.endsWith("'")) {
    return tab.slice(1, -1).replace(/''/g, "'");
  }
  return tab;
}

/** 1-based column number → letters (`1 → A`, `27 → AA`). */
export function columnToLetter(n: number): string {
  if (!Number.isFinite(n) || n < 1) return "";
  let value = Math.floor(n);
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

/** Letters → 1-based column number (`A → 1`, `AA → 27`); 0 when unusable. */
export function letterToColumn(letter: string): number {
  const text = String(letter ?? "").trim().toUpperCase();
  if (!text) return 0;
  let value = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) return 0;
    value = value * 26 + (code - 64);
  }
  return value;
}

function columnToken(token: string | undefined): string | null {
  const value = String(token ?? "").trim();
  if (!COLUMN_TOKEN_RE.test(value)) return null;
  return (value.match(/^[A-Za-z]{1,3}/)?.[0] ?? "").toUpperCase();
}

/** The columns a range covers (`A:D`, `A1:D50`, `A`), or null when it has none. */
export function parseColumnSpan(range: string): { start: string; end: string } | null {
  const value = String(range ?? "").trim();
  if (!value) return null;
  const bare = value.includes("!") ? value.slice(value.indexOf("!") + 1) : value;
  const parts = bare.split(":");
  const start = columnToken(parts[0]);
  if (!start) return null;
  return { start, end: columnToken(parts[1]) ?? start };
}

/** One row of a column span, e.g. `Leads!A5:D5`. */
export function rowScopedRange(
  sheet: string,
  columnSpan: { start: string; end: string },
  rowNumber: number,
): string {
  const cells = `${columnSpan.start}${rowNumber}:${columnSpan.end}${rowNumber}`;
  const tab = quoteSheetName(sheet);
  return tab ? `${tab}!${cells}` : cells;
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

export interface SheetValueEntry {
  key: string;
  value: string;
}

/**
 * The `keyvalue` field in the order its values belong in the sheet.
 *
 * Demo workflows label their columns `A`, `B`, `C` … — every key being
 * a single letter means the editor list can be shuffled and still land
 * in the right cells, so those are sorted by column. Any other key
 * (`Name`, `email`) is a label the user arranged deliberately and keeps
 * its order. Values arrive already interpolated by the engine.
 */
export function entriesFromKeyValue(raw: unknown): SheetValueEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: SheetValueEntry[] = [];
  for (const item of raw) {
    const record = (item ?? {}) as { key?: unknown; value?: unknown };
    const key = String(record.key ?? "").trim();
    if (!key) continue;
    const value = record.value === null || record.value === undefined ? "" : String(record.value);
    entries.push({ key, value });
  }
  if (entries.length === 0) return [];
  const columnKeys = entries.every((entry) => /^[A-Za-z]$/.test(entry.key));
  if (!columnKeys) return entries;
  return [...entries].sort((a, b) => letterToColumn(a.key) - letterToColumn(b.key));
}

/** Row cells in sheet order; empty input is a configuration mistake. */
export function valuesFromKeyValue(raw: unknown): string[] {
  const entries = entriesFromKeyValue(raw);
  if (entries.length === 0) {
    throw integrationError(SHEETS_ERRORS.configInvalid, "This step has no values to write.", {
      hint: "Add at least one column value before running the step.",
      remediation: REMEDIATION.inspect,
    });
  }
  return entries.map((entry) => entry.value);
}

/** Row reads are capped 1..5000; anything unusable means the default. */
export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 100;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 100;
  return Math.min(5000, Math.max(1, Math.floor(value)));
}

/** Row numbers are positive integers — `{{sheets.rowNumber}}` and `14` both work. */
export function parseRowNumber(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isInteger(value) || value < 1) {
    return invalid(
      SHEETS_ERRORS.rangeInvalid,
      `"${String(raw ?? "").trim() || "…"}" is not a row number.`,
      "Pass a row such as 14 — the Read rows step exposes the matched one as {{sheets.rowNumber}}.",
    );
  }
  return value;
}
