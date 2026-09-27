import { defineIntegration } from "../types";
import { sheetsAppendDefinition, sheetsReadDefinition, sheetsWriteDefinition } from "./definition";
import { googleSheetsHandlers } from "./handler";

/**
 * Google Sheets integration.
 *
 * Owns the append, read and write nodes and their handlers. Registered
 * in `../registry.ts`; the pure bundle in `../definitions.ts` imports
 * only `./definition`, which touches nothing but field shapes.
 */
export const googleSheetsIntegration = defineIntegration({
  id: "google_sheets",
  label: "Google Sheets",
  definitions: [sheetsAppendDefinition, sheetsReadDefinition, sheetsWriteDefinition],
  handlers: googleSheetsHandlers,
});

export {
  sheetsAppendDefinition,
  sheetsReadDefinition,
  sheetsWriteDefinition,
  sheetsDefinitions,
} from "./definition";
export { googleSheetsHandlers, sheetsAppendHandler, sheetsReadHandler, sheetsWriteHandler } from "./handler";
export {
  APPEND_RANGE_HELP,
  SHEET_RANGE_HELP,
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
  type SheetValueEntry,
} from "./config";
export {
  emptyRow,
  extractHeaders,
  headerKey,
  normalizeRows,
  parseUpdatedRow,
  spreadsheetUrl,
  type NormalizedRows,
  type SheetCell,
  type SheetRow,
} from "./normalize";
