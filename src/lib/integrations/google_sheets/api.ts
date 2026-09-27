import { ProviderError } from "@/lib/integrations/provider/errors";
import { providerFetch } from "@/lib/integrations/provider/http";
import type { ProviderConnection } from "@/lib/integrations/provider/types";

/**
 * Google Sheets REST client.
 *
 * One entry point stands between a node and `sheets.googleapis.com`: it
 * pins the host, attaches the connection's bearer token, keeps every
 * range inside a single encoded path segment (A1 notation is full of
 * `!` and `:`), and maps failures onto {@link ProviderError} with the
 * connection context a generic error cannot know.
 */

export const SHEETS_API = "https://sheets.googleapis.com/v4";

export interface SheetsRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function sheetsRequest<T = unknown>(
  connection: ProviderConnection,
  operation: string,
  path: string,
  options: SheetsRequestOptions = {},
): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${SHEETS_API}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  try {
    const result = await providerFetch<T>({
      provider: "google_sheets",
      operation,
      url: url.toString(),
      method: options.method ?? "GET",
      headers: { authorization: `Bearer ${connection.accessToken}` },
      json: options.body,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    return result.data;
  } catch (error) {
    if (error instanceof ProviderError) throw decorate(connection, operation, error);
    throw error;
  }
}

/**
 * Adds the connection context behind an auth failure: *which* account
 * was rejected and what it was granted. The token itself is never
 * included — only the credential id and the scopes.
 */
function decorate(
  connection: ProviderConnection,
  operation: string,
  error: ProviderError,
): ProviderError {
  if (error.category === "authentication") {
    return new ProviderError("google_sheets", "Google rejected the connection's access token.", {
      operation,
      category: "authentication",
      status: error.statusCode,
      requestId: error.requestId,
      providerMessage: error.providerMessage,
      detail: `credential=${connection.credentialId}${connection.account ? ` account=${connection.account}` : ""}`,
      cause: error,
    });
  }
  if (error.category === "authorization") {
    return new ProviderError(
      "google_sheets",
      "Google refused this action — the connection's scopes do not cover it.",
      {
        operation,
        category: "authorization",
        status: error.statusCode,
        requestId: error.requestId,
        providerMessage: error.providerMessage,
        detail: `granted=${connection.scopes.join(" ") || "none"}`,
        cause: error,
      },
    );
  }
  return error;
}

/* ------------------------------------------------------------------ */
/* Typed helpers                                                       */
/* ------------------------------------------------------------------ */

function pathFor(spreadsheetId: string, suffix = ""): string {
  const base = `/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  return suffix ? `${base}/${suffix}` : base;
}

/** One range as a path segment — `Leads!A:D` must not become two segments. */
function rangePath(spreadsheetId: string, range: string, suffix = ""): string {
  return pathFor(spreadsheetId, `values/${encodeURIComponent(range)}${suffix}`);
}

export interface SheetsSheet {
  sheetId?: number;
  title?: string;
  index?: number;
  hidden?: boolean;
  gridProperties?: { rowCount?: number; columnCount?: number };
}

export interface SheetsSpreadsheetMeta {
  spreadsheetId?: string;
  properties?: { title?: string };
  sheets?: SheetsSheet[];
  namedRanges?: Array<{ name?: string; range?: string }>;
}

export interface SheetsValueRange {
  range?: string;
  majorDimension?: string;
  values?: unknown[][];
}

export interface SheetsUpdateResponse {
  spreadsheetId?: string;
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
  values?: unknown[][];
}

/**
 * Append answers with `updates`; the top level repeats the same fields
 * for callers that only care where the row landed.
 */
export interface SheetsAppendResponse extends SheetsUpdateResponse {
  tableRange?: string;
  updates?: SheetsUpdateResponse;
}

export async function getSpreadsheetMeta(
  connection: ProviderConnection,
  spreadsheetId: string,
  signal?: AbortSignal,
): Promise<SheetsSpreadsheetMeta> {
  return sheetsRequest<SheetsSpreadsheetMeta>(
    connection,
    "spreadsheets.get",
    pathFor(spreadsheetId),
    {
      query: {
        fields:
          "spreadsheetId,properties.title,sheets.properties(sheetId,title,index,hidden,gridProperties),namedRanges",
      },
      signal,
    },
  );
}

export async function getValues(
  connection: ProviderConnection,
  spreadsheetId: string,
  range: string,
  signal?: AbortSignal,
): Promise<SheetsValueRange> {
  return sheetsRequest<SheetsValueRange>(connection, "values.get", rangePath(spreadsheetId, range), {
    query: {
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    },
    signal,
  });
}

export async function appendValues(
  connection: ProviderConnection,
  spreadsheetId: string,
  range: string,
  values: unknown[][],
  signal?: AbortSignal,
): Promise<SheetsAppendResponse> {
  return sheetsRequest<SheetsAppendResponse>(
    connection,
    "values.append",
    rangePath(spreadsheetId, range, ":append"),
    {
      method: "POST",
      query: {
        includeValuesInResponse: "true",
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
      },
      body: { range, majorDimension: "ROWS", values },
      signal,
    },
  );
}

export async function updateValues(
  connection: ProviderConnection,
  spreadsheetId: string,
  range: string,
  values: unknown[][],
  signal?: AbortSignal,
): Promise<SheetsUpdateResponse> {
  return sheetsRequest<SheetsUpdateResponse>(connection, "values.update", rangePath(spreadsheetId, range), {
    method: "PUT",
    query: { includeValuesInResponse: "true", valueInputOption: "USER_ENTERED" },
    body: { range, majorDimension: "ROWS", values },
    signal,
  });
}

/** Google clears whatever the path names; the body is deliberately empty. */
export async function clearValues(
  connection: ProviderConnection,
  spreadsheetId: string,
  range: string,
  signal?: AbortSignal,
): Promise<{ clearedRange?: string }> {
  return sheetsRequest<{ clearedRange?: string }>(
    connection,
    "values.clear",
    rangePath(spreadsheetId, range, ":clear"),
    { method: "POST", body: {}, signal },
  );
}
