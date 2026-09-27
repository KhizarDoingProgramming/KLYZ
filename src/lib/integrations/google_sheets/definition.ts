import type { ConfigField, NodeDefinition } from "@/lib/workflow/types";
import { APPEND_RANGE_HELP, SHEET_RANGE_HELP } from "./config";

const str = (key: string, label: string) => ({ key, label, type: "string" as const });
const num = (key: string, label: string) => ({ key, label, type: "number" as const });

const CREDENTIAL_HELP =
  "Connect a Google account on the Integrations page. The token is encrypted and only sent to Google.";

const SPREADSHEET_FIELD: ConfigField = {
  key: "spreadsheetId",
  label: "Spreadsheet",
  kind: "text",
  required: true,
  mono: true,
  placeholder:
    "https://docs.google.com/spreadsheets/d/1BxiMVs…/edit  or  1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
  help: "Paste the spreadsheet URL or its id.",
};

const SHEET_FIELD: ConfigField = {
  key: "sheet",
  label: "Sheet",
  kind: "text",
  mono: true,
  placeholder: "Leads",
  help: "Tab name. Leave empty when the range below already starts with “Tab!”.",
  bindable: false,
};

const RANGE_FIELD: ConfigField = {
  key: "range",
  label: "Range",
  kind: "text",
  mono: true,
  placeholder: "A:D",
  help: SHEET_RANGE_HELP,
};

const APPEND_RANGE_FIELD: ConfigField = { ...RANGE_FIELD, help: APPEND_RANGE_HELP };

const VALUES_FIELD: ConfigField = {
  key: "values",
  label: "Values",
  kind: "keyvalue",
  required: true,
  bindable: true,
  help: "One entry per column, in sheet order. Keys may be column letters (A, B, …).",
};

/** Appends a row after the last one in the range. */
export const sheetsAppendDefinition: NodeDefinition = {
  type: "action.sheets_append",
  category: "action",
  title: "Append row",
  description: "Appends a row to a spreadsheet.",
  icon: "sheet",
  summary: "Appends a row",
  cost: 320,
  credentials: ["google_sheets"],
  tags: ["google sheets"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    SPREADSHEET_FIELD,
    SHEET_FIELD,
    APPEND_RANGE_FIELD,
    VALUES_FIELD,
  ],
  outputs: [
    num("rowNumber", "Row number"),
    num("updatedRows", "Rows appended"),
    str("range", "Range"),
    str("spreadsheetUrl", "Spreadsheet URL"),
    { key: "values", label: "Values", type: "object" },
  ],
};

/** Reads the whole range, or finds the rows whose column matches. */
export const sheetsReadDefinition: NodeDefinition = {
  type: "action.sheets_read",
  category: "action",
  title: "Read rows",
  description: "Reads or finds rows in a spreadsheet.",
  icon: "list",
  summary: "Reads spreadsheet rows",
  cost: 300,
  credentials: ["google_sheets"],
  tags: ["google sheets"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    {
      key: "operation",
      label: "Operation",
      kind: "select",
      required: true,
      options: [
        { value: "get", label: "Get rows" },
        { value: "find", label: "Find row" },
      ],
    },
    SPREADSHEET_FIELD,
    SHEET_FIELD,
    RANGE_FIELD,
    {
      key: "headerRow",
      label: "First row is headers",
      kind: "toggle",
      help: "Treat the first row of the range as column headers — rows are then keyed by those names.",
    },
    {
      key: "limit",
      label: "Max rows",
      kind: "number",
      showWhen: { key: "operation", equals: "get" },
      placeholder: "100",
      help: "Maximum rows returned (1–5000).",
    },
    {
      key: "column",
      label: "Column",
      kind: "text",
      required: true,
      mono: true,
      bindable: true,
      showWhen: { key: "operation", equals: "find" },
      placeholder: "email",
      help: "Column header, or its letter when the sheet has no header row.",
    },
    {
      key: "match",
      label: "Value to find",
      kind: "expression",
      required: true,
      bindable: true,
      showWhen: { key: "operation", equals: "find" },
      placeholder: "{{gmail.fromEmail}}",
      help: "The cell must match this value — a Condition step decides what happens when nothing does.",
    },
    {
      key: "matchType",
      label: "Match",
      kind: "select",
      showWhen: { key: "operation", equals: "find" },
      options: [
        { value: "exact", label: "Exact" },
        { value: "contains", label: "Contains" },
        { value: "startsWith", label: "Starts with" },
      ],
      help: "Exact ignores letter case.",
    },
  ],
  outputs: [
    { key: "rows", label: "Rows", type: "array" },
    { key: "row", label: "Row", type: "object" },
    num("rowNumber", "Row number"),
    { key: "columns", label: "Columns", type: "array" },
    num("rowCount", "Row count"),
    str("range", "Range"),
    str("operation", "Operation"),
  ],
};

/** Writes one row, or clears a range after an explicit confirmation. */
export const sheetsWriteDefinition: NodeDefinition = {
  type: "action.sheets_write",
  category: "action",
  title: "Update row",
  description: "Updates the cells of one row, or clears a range.",
  icon: "file",
  summary: "Writes to a row",
  cost: 300,
  credentials: ["google_sheets"],
  tags: ["google sheets"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    {
      key: "operation",
      label: "Operation",
      kind: "select",
      required: true,
      options: [
        { value: "update", label: "Update row" },
        { value: "clear", label: "Clear range" },
      ],
    },
    SPREADSHEET_FIELD,
    SHEET_FIELD,
    RANGE_FIELD,
    {
      key: "row",
      label: "Row",
      kind: "text",
      required: true,
      mono: true,
      bindable: true,
      showWhen: { key: "operation", equals: "update" },
      placeholder: "{{sheets.rowNumber}}",
      help: "Row number in the sheet, e.g. 14.",
    },
    { ...VALUES_FIELD, showWhen: { key: "operation", equals: "update" } },
    {
      key: "confirmClear",
      label: "Confirm clear",
      kind: "toggle",
      required: true,
      showWhen: { key: "operation", equals: "clear" },
      help: "Clearing deletes the data in that range permanently. Turn this on to allow it.",
    },
  ],
  outputs: [
    num("updatedCells", "Cells updated"),
    num("updatedRows", "Rows updated"),
    num("rowNumber", "Row number"),
    str("range", "Range"),
    { key: "values", label: "Values", type: "object" },
    str("operation", "Operation"),
  ],
};

/** Every definition this module contributes, in palette order. */
export const sheetsDefinitions: NodeDefinition[] = [
  sheetsAppendDefinition,
  sheetsReadDefinition,
  sheetsWriteDefinition,
];
