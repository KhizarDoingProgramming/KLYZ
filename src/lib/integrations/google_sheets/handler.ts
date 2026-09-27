import type { NodeHandler, NodeRunContext } from "@/lib/engine/types";
import { SHEETS_ERRORS, REMEDIATION, integrationError } from "../errors";
import { loadConnection } from "../provider/connection";
import type { ProviderConnection } from "../provider/types";
import { appendValues, clearValues, getValues, updateValues } from "./api";
import {
  buildRange,
  columnToLetter,
  entriesFromKeyValue,
  letterToColumn,
  parseColumnSpan,
  parseLimit,
  parseRowNumber,
  parseSpreadsheetId,
  rowScopedRange,
  sheetFromRange,
  valuesFromKeyValue,
  type SheetValueEntry,
} from "./config";
import {
  emptyRow,
  extractHeaders,
  normalizeRows,
  parseUpdatedRow,
  spreadsheetUrl,
  type NormalizedRows,
  type SheetCell,
} from "./normalize";

/**
 * Google Sheets node handlers.
 *
 * Every handler follows the same three steps: read and validate its
 * config (the engine has already interpolated expressions), load a
 * workspace-scoped connection, and translate the values API's response
 * into the flat shape the node declares in `outputs`. Failures are
 * raised as {@link ProviderError} → `EngineError`, so the debugger
 * shows one contract and the attempt loop only retries what is
 * retryable. Nothing here invents data: an unmatched search returns an
 * empty row and lets a Condition decide.
 */

type Config = Record<string, unknown>;

/** How many rows a search will scan before it stops. */
const FIND_ROW_CAP = 5_000;

function text(config: Config, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

function required(config: Config, key: string, label: string): string {
  const value = text(config, key);
  if (!value) {
    throw integrationError(SHEETS_ERRORS.configInvalid, `This Google Sheets step is missing ${label}.`, {
      hint: `Fill in "${label}" on the node.`,
      remediation: REMEDIATION.inspect,
    });
  }
  return value;
}

function isTruthy(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

async function connect(context: NodeRunContext, config: Config): Promise<ProviderConnection> {
  return loadConnection(
    context.workspaceId,
    required(config, "credential", "a connection"),
    "google_sheets",
  );
}

/** The row a range starts at — `A:D` and `A5:D50` differ, `2:2` is row 2. */
function rangeStartRow(range: string): number {
  const bare = range.includes("!") ? range.slice(range.indexOf("!") + 1) : range;
  const first = bare.split(":")[0] ?? "";
  const row = first.match(/^([A-Za-z]{1,3})?(\d+)$/)?.[2];
  const parsed = row ? Number(row) : 1;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/** What was sent, keyed the way the sheet will read it back. */
function rowObject(entries: SheetValueEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) out[entry.key] = entry.value;
  return out;
}

/* ------------------------------------------------------------------ */
/* Append                                                              */
/* ------------------------------------------------------------------ */

export const sheetsAppendHandler: NodeHandler = async (context) => {
  const config = context.config;
  const spreadsheetId = parseSpreadsheetId(required(config, "spreadsheetId", "a spreadsheet"));
  const range = buildRange(text(config, "sheet"), text(config, "range"));
  const values = valuesFromKeyValue(config.values);
  const entries = entriesFromKeyValue(config.values);

  const connection = await connect(context, config);
  const appended = await appendValues(connection, spreadsheetId, range, [values], context.signal);
  const updates = appended.updates ?? appended;
  const updatedRange = updates.updatedRange ?? "";

  return {
    output: {
      rowNumber: parseUpdatedRow(updatedRange),
      updatedRows: updates.updatedRows ?? 0,
      range: updatedRange || range,
      spreadsheetUrl: spreadsheetUrl(spreadsheetId),
      values: rowObject(entries),
    },
  };
};

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

interface FindConfig {
  column: string;
  needle: string;
  matchType: string;
}

export const sheetsReadHandler: NodeHandler = async (context) => {
  const config = context.config;
  const operation = text(config, "operation") === "find" ? "find" : "get";
  const spreadsheetId = parseSpreadsheetId(required(config, "spreadsheetId", "a spreadsheet"));
  const range = buildRange(text(config, "sheet"), text(config, "range"));
  const headerRow = isTruthy(config.headerRow);
  const limit = parseLimit(config.limit);
  const find: FindConfig | null =
    operation === "find"
      ? {
          column: required(config, "column", "a column"),
          needle: required(config, "match", "a value to find"),
          matchType: text(config, "matchType") || "exact",
        }
      : null;

  const connection = await connect(context, config);
  const response = await getValues(connection, spreadsheetId, range, context.signal);
  const grid = response.values ?? [];
  const resolvedRange = response.range || range;

  const normalized = normalizeRows({
    values: grid,
    startRow: rangeStartRow(range),
    ...(headerRow ? { headers: extractHeaders(grid) } : {}),
  });

  if (find) return { output: findOutput(normalized, find, headerRow, resolvedRange) };

  const rows = normalized.rows.slice(0, limit);
  return {
    output: {
      rows,
      row: rows[0] ?? emptyRow(),
      rowNumber: rows[0]?.rowNumber ?? 0,
      columns: normalized.columns,
      rowCount: rows.length,
      range: resolvedRange,
      operation: "get",
    },
  };
};

function findOutput(
  normalized: NormalizedRows,
  find: FindConfig,
  headerRow: boolean,
  range: string,
): Record<string, unknown> {
  const index = columnIndex(find.column, normalized.columns, headerRow);
  const scanned = normalized.rows.slice(0, FIND_ROW_CAP);
  const matches = scanned.filter((row) => matchesCell(row.cells[index], find.needle, find.matchType));
  const first = matches[0];

  return {
    rows: matches,
    row: first ?? emptyRow(),
    rowNumber: first?.rowNumber ?? 0,
    columns: normalized.columns,
    rowCount: matches.length,
    range,
    operation: "find",
  };
}

/** Headers are matched by name; a headerless sheet only has letters and positions. */
function columnIndex(key: string, columns: string[], headerRow: boolean): number {
  if (headerRow) {
    const needle = key.toLowerCase();
    const found = columns.findIndex((name) => name.toLowerCase() === needle);
    if (found < 0) {
      throw integrationError(
        SHEETS_ERRORS.configInvalid,
        `This spreadsheet has no "${key}" column.`,
        {
          hint: columns.length
            ? `Available columns: ${columns.join(", ")}.`
            : "Turn off “First row is headers”, or address the column by its letter.",
          remediation: REMEDIATION.inspect,
        },
      );
    }
    return found;
  }
  if (/^[A-Za-z]{1,3}$/.test(key)) return letterToColumn(key) - 1;
  if (/^\d+$/.test(key)) return Math.max(0, Number(key) - 1);
  throw integrationError(
    SHEETS_ERRORS.configInvalid,
    `"${key}" is not a column.`,
    {
      hint: "Use a column letter such as B, or its position (1 for the first column).",
      remediation: REMEDIATION.inspect,
    },
  );
}

function matchesCell(cell: SheetCell | undefined, needle: string, matchType: string): boolean {
  if (cell === null || cell === undefined) return false;
  const actual = String(cell).toLowerCase();
  const target = needle.toLowerCase();
  if (matchType === "contains") return actual.includes(target);
  if (matchType === "startsWith") return actual.startsWith(target);
  return actual === target;
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

export const sheetsWriteHandler: NodeHandler = async (context) => {
  const config = context.config;
  const operation = text(config, "operation") === "clear" ? "clear" : "update";
  const spreadsheetId = parseSpreadsheetId(required(config, "spreadsheetId", "a spreadsheet"));
  const sheet = text(config, "sheet");
  const range = text(config, "range");

  if (operation === "clear") {
    if (!isTruthy(config.confirmClear)) {
      throw integrationError(
        SHEETS_ERRORS.clearUnconfirmed,
        "This step is not allowed to clear a range.",
        {
          hint: "Turn on “Confirm clear” — cells in that range are deleted permanently.",
          remediation: REMEDIATION.inspect,
        },
      );
    }
    const target = buildRange(sheet, range);
    if (!target) {
      throw integrationError(SHEETS_ERRORS.rangeInvalid, "This step has no range to clear.", {
        hint: 'Fill in "Range" — e.g. A:D or Leads!A1:F200.',
        remediation: REMEDIATION.inspect,
      });
    }

    const connection = await connect(context, config);
    await clearValues(connection, spreadsheetId, target, context.signal);
    return {
      output: {
        updatedCells: 0,
        updatedRows: 0,
        rowNumber: 0,
        range: target,
        values: {},
        operation: "clear",
      },
    };
  }

  const rowNumber = parseRowNumber(config.row);
  const values = valuesFromKeyValue(config.values);
  const entries = entriesFromKeyValue(config.values);
  const span = parseColumnSpan(range) ?? { start: "A", end: columnToLetter(values.length) };
  const target = rowScopedRange(sheet || sheetFromRange(range), span, rowNumber);

  const connection = await connect(context, config);
  const updated = await updateValues(connection, spreadsheetId, target, [values], context.signal);

  return {
    output: {
      updatedCells: updated.updatedCells ?? 0,
      updatedRows: updated.updatedRows ?? 0,
      rowNumber: parseUpdatedRow(updated.updatedRange ?? "") || rowNumber,
      range: updated.updatedRange ?? target,
      values: rowObject(entries),
      operation: "update",
    },
  };
};

export const googleSheetsHandlers: Record<string, NodeHandler> = {
  "action.sheets_append": sheetsAppendHandler,
  "action.sheets_read": sheetsReadHandler,
  "action.sheets_write": sheetsWriteHandler,
};
