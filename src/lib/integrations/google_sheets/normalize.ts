import { columnToLetter } from "./config";

/**
 * Spreadsheet row normalisation.
 *
 * The values API returns a bare grid — no headers, no row numbers, and
 * trailing empty cells trimmed off every row. A workflow needs named
 * columns and absolute positions, so rows are rebuilt here: `cells`
 * keeps the grid exactly as it came back, `values` adds the names a
 * later step can reference, and `rowNumber` is the real row in the
 * sheet so a write can target it again.
 */

/** What a cell holds with `UNFORMATTED_VALUE`: text, number, boolean — or nothing. */
export type SheetCell = string | number | boolean | null;

export interface SheetRow {
  /** Absolute 1-based row in the sheet. */
  rowNumber: number;
  /** Keyed by header when headers are on, else by column letter (A, B, …). */
  values: Record<string, SheetCell>;
  /** Positional — never loses structure, `null` for the cells Sheets trimmed. */
  cells: SheetCell[];
}

export interface NormalizedRows {
  rows: SheetRow[];
  columns: string[];
  rowCount: number;
}

/**
 * `headers` present means the first row of `values` *is* the header row
 * and is consumed as such — data rows start on the next line.
 */
export function normalizeRows(params: {
  values: unknown[][] | undefined;
  startRow: number;
  headers?: string[];
}): NormalizedRows {
  const grid = params.values ?? [];
  const startRow = Number.isFinite(params.startRow)
    ? Math.max(1, Math.floor(params.startRow))
    : 1;

  if (params.headers) {
    const seen = new Map<string, number>();
    const columns = params.headers.map((header, index) =>
      headerKey(header, seen, columnToLetter(index + 1)),
    );
    const rows = grid.slice(1).map((cells, index) => buildRow(cells, columns, startRow + 1 + index));
    return { rows, columns, rowCount: rows.length };
  }

  const width = grid.reduce((max, cells) => Math.max(max, Array.isArray(cells) ? cells.length : 0), 0);
  const columns = Array.from({ length: width }, (_, index) => columnToLetter(index + 1));
  const rows = grid.map((cells, index) => buildRow(cells, columns, startRow + index));
  return { rows, columns, rowCount: rows.length };
}

/** The first row of a grid, trimmed to text — empty when there is none. */
export function extractHeaders(values: unknown[][] | undefined): string[] {
  const first = values?.[0];
  if (!Array.isArray(first)) return [];
  return first.map((cell) =>
    cell === null || cell === undefined ? "" : String(cell).trim(),
  );
}

/**
 * One usable column name. Repeats become `Email`, `Email (2)` so a
 * `values` object never silently drops a column, and a blank header
 * falls back to the letter the caller passes for it.
 */
export function headerKey(header: string, seen: Map<string, number>, letter = ""): string {
  const base = String(header ?? "").trim() || letter;
  if (!base) return "";
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base} (${count})`;
}

/** `Leads!A100:D100` → 100; 0 when the range carries no row number. */
export function parseUpdatedRow(range: string): number {
  const value = String(range ?? "").trim();
  if (!value) return 0;
  const bare = value.includes("!") ? value.slice(value.indexOf("!") + 1) : value;
  const first = bare.split(":")[0] ?? "";
  const row = first.match(/^[A-Za-z]{1,3}(\d+)/)?.[1];
  return row ? Number(row) : 0;
}

/** `https://docs.google.com/spreadsheets/d/<id>/edit` */
export function spreadsheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

/** A row with nothing in it — what a step returns instead of `undefined`. */
export function emptyRow(rowNumber = 0): SheetRow {
  return { rowNumber, values: {}, cells: [] };
}

function buildRow(source: unknown, columns: string[], rowNumber: number): SheetRow {
  const raw = Array.isArray(source) ? source : [];
  const width = Math.max(columns.length, raw.length);
  const cells: SheetCell[] = Array.from({ length: width }, (_, index) =>
    coerceCell(raw[index]),
  );
  const values: Record<string, SheetCell> = {};
  for (let index = 0; index < width; index++) {
    const key = columns[index] ?? columnToLetter(index + 1);
    if (!(key in values)) values[key] = cells[index] ?? null;
  }
  return { rowNumber, values, cells };
}

function coerceCell(value: unknown): SheetCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}
