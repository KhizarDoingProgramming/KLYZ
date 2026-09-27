import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeHandler, NodeRunContext } from "@/lib/engine/types";
import type { Workflow } from "@/lib/workflow/types";

vi.mock("./api", () => ({
  appendValues: vi.fn(),
  clearValues: vi.fn(),
  getValues: vi.fn(),
  updateValues: vi.fn(),
}));

vi.mock("@/lib/integrations/provider/connection", () => ({
  loadConnection: vi.fn(),
}));

import { loadConnection } from "@/lib/integrations/provider/connection";
import { appendValues, clearValues, getValues, updateValues } from "./api";
import { googleSheetsHandlers } from "./handler";

const loadMock = vi.mocked(loadConnection);
const appendMock = vi.mocked(appendValues);
const clearMock = vi.mocked(clearValues);
const getMock = vi.mocked(getValues);
const updateMock = vi.mocked(updateValues);

const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

const connection = {
  credentialId: "cred_sheets_1",
  provider: "google_sheets",
  workspaceId: "ws_1",
  name: "Google",
  status: "connected",
  account: "ops@northwind.io",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  accessToken: "ya29.not-a-real-token",
  expiresAt: null,
  extra: {},
} as const;

function makeContext(config: Record<string, unknown>): NodeRunContext {
  return {
    executionId: "exec_1",
    workspaceId: "ws_1",
    workflow: {} as Workflow,
    nodeId: "n_sheets",
    nodeType: "action.sheets_append",
    config,
    rawConfig: config,
    scope: {},
    triggerInput: null,
    attempt: 1,
    signal: new AbortController().signal,
    publishStatus: () => undefined,
  };
}

function handlerFor(type: string): NodeHandler {
  const handler = googleSheetsHandlers[type];
  if (!handler) throw new Error(`no handler for ${type}`);
  return handler;
}

async function expectCode(fn: () => unknown, code: string): Promise<void> {
  const error = await Promise.resolve()
    .then(fn)
    .then(
      () => null,
      (failure: unknown) => failure,
    );
  expect(error).toBeTruthy();
  expect((error as { code?: string }).code).toBe(code);
}

beforeEach(() => {
  vi.resetAllMocks();
  loadMock.mockResolvedValue(connection as never);
});

describe("handler registration", () => {
  it("exposes exactly the three sheets nodes", () => {
    expect(Object.keys(googleSheetsHandlers).sort()).toEqual([
      "action.sheets_append",
      "action.sheets_read",
      "action.sheets_write",
    ]);
  });
});

describe("action.sheets_append", () => {
  const config = {
    credential: "cred_sheets_1",
    spreadsheetId: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
    range: "Leads!A:D",
    values: [
      { id: "k1", key: "D", value: "2026-09-26" },
      { id: "k2", key: "A", value: "Dana" },
      { id: "k3", key: "B", value: "dana@northwind.io" },
      { id: "k4", key: "C", value: "demo" },
    ],
  };

  it("appends the row in column order and reports where it landed", async () => {
    appendMock.mockResolvedValue({
      updates: { updatedRange: "Leads!A100:D100", updatedRows: 1, updatedCells: 4 },
    });

    const result = await handlerFor("action.sheets_append")(makeContext(config));

    expect(loadMock).toHaveBeenCalledWith("ws_1", "cred_sheets_1", "google_sheets");
    expect(appendMock).toHaveBeenCalledWith(
      connection,
      ID,
      "Leads!A:D",
      [["Dana", "dana@northwind.io", "demo", "2026-09-26"]],
      expect.any(AbortSignal),
    );
    expect(result.output).toEqual({
      rowNumber: 100,
      updatedRows: 1,
      range: "Leads!A100:D100",
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${ID}/edit`,
      values: {
        A: "Dana",
        B: "dana@northwind.io",
        C: "demo",
        D: "2026-09-26",
      },
    });
  });

  it("refuses a spreadsheet it cannot read an id from", async () => {
    await expectCode(
      () => handlerFor("action.sheets_append")(makeContext({ ...config, spreadsheetId: "nope" })),
      "SHEETS_SPREADSHEET_INVALID",
    );
    expect(loadMock).not.toHaveBeenCalled();
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("refuses to append nothing", async () => {
    await expectCode(
      () =>
        handlerFor("action.sheets_append")(
          makeContext({ ...config, values: [{ id: "k1", key: "", value: "" }] }),
        ),
      "SHEETS_CONFIG_INVALID",
    );
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("asks for a connection when the credential is missing", async () => {
    await expectCode(
      () => handlerFor("action.sheets_append")(makeContext({ ...config, credential: " " })),
      "SHEETS_CONFIG_INVALID",
    );
    expect(loadMock).not.toHaveBeenCalled();
  });
});

describe("action.sheets_read", () => {
  const values = [
    ["Email", "Name"],
    ["dana@northwind.io", "Dana"],
    ["sam@acme.io", "Sam"],
    ["lee@acme.io", "Lee"],
  ];

  it("returns header-keyed rows limited to the configured maximum", async () => {
    getMock.mockResolvedValue({ range: "Leads!A1:B", values });

    const result = await handlerFor("action.sheets_read")(
      makeContext({
        credential: "cred_sheets_1",
        spreadsheetId: ID,
        sheet: "Leads",
        range: "A:B",
        operation: "get",
        headerRow: true,
        limit: 2,
      }),
    );

    expect(getMock).toHaveBeenCalledWith(
      connection,
      ID,
      "Leads!A:B",
      expect.any(AbortSignal),
    );
    expect(result.output.rowCount).toBe(2);
    expect(result.output.columns).toEqual(["Email", "Name"]);
    expect(result.output.row).toEqual({
      rowNumber: 2,
      values: { Email: "dana@northwind.io", Name: "Dana" },
      cells: ["dana@northwind.io", "Dana"],
    });
    expect(result.output.rowNumber).toBe(2);
    expect(result.output.range).toBe("Leads!A1:B");
    expect(result.output.operation).toBe("get");
    expect((result.output.rows as unknown[]).length).toBe(2);
  });

  it("reads a headerless range into column letters", async () => {
    getMock.mockResolvedValue({ values: [["Dana", "dana@northwind.io"]] });

    const result = await handlerFor("action.sheets_read")(
      makeContext({
        credential: "cred_sheets_1",
        spreadsheetId: ID,
        range: "A:D",
        operation: "get",
      }),
    );

    expect(result.output.columns).toEqual(["A", "B"]);
    expect(result.output.row).toMatchObject({
      rowNumber: 1,
      values: { A: "Dana", B: "dana@northwind.io" },
    });
  });

  it("finds the rows whose column matches", async () => {
    getMock.mockResolvedValue({ range: "Leads!A1:B", values });

    const result = await handlerFor("action.sheets_read")(
      makeContext({
        credential: "cred_sheets_1",
        spreadsheetId: ID,
        range: "Leads!A:B",
        operation: "find",
        headerRow: true,
        column: "EMAIL",
        match: "sam@acme.io",
        matchType: "exact",
      }),
    );

    expect(result.output.rowCount).toBe(1);
    expect(result.output.rowNumber).toBe(3);
    expect(result.output.row).toMatchObject({
      rowNumber: 3,
      values: { Email: "sam@acme.io", Name: "Sam" },
    });
    expect(result.output.operation).toBe("find");
  });

  it("returns an empty row instead of failing when nothing matches", async () => {
    getMock.mockResolvedValue({ range: "Leads!A1:B", values });

    const result = await handlerFor("action.sheets_read")(
      makeContext({
        credential: "cred_sheets_1",
        spreadsheetId: ID,
        range: "Leads!A:B",
        operation: "find",
        headerRow: true,
        column: "email",
        match: "nobody@nowhere.io",
      }),
    );

    expect(result.output.rowCount).toBe(0);
    expect(result.output.rowNumber).toBe(0);
    expect(result.output.rows).toEqual([]);
    expect(result.output.row).toEqual({ rowNumber: 0, values: {}, cells: [] });
  });

  it("rejects a column that is neither a header nor a letter", async () => {
    getMock.mockResolvedValue({ values: [["Dana", "dana@northwind.io"]] });

    await expectCode(
      () =>
        handlerFor("action.sheets_read")(
          makeContext({
            credential: "cred_sheets_1",
            spreadsheetId: ID,
            range: "A:B",
            operation: "find",
            column: "email",
            match: "dana@northwind.io",
          }),
        ),
      "SHEETS_CONFIG_INVALID",
    );
  });
});

describe("action.sheets_write", () => {
  it("pins the configured row to the columns of the range", async () => {
    updateMock.mockResolvedValue({
      updatedRange: "Leads!A14:D14",
      updatedRows: 1,
      updatedCells: 4,
    });

    const result = await handlerFor("action.sheets_write")(
      makeContext({
        credential: "cred_sheets_1",
        spreadsheetId: ID,
        sheet: "Leads",
        range: "A:D",
        operation: "update",
        row: "14",
        values: [
          { id: "k1", key: "A", value: "Dana Reyes" },
          { id: "k2", key: "B", value: "dana@northwind.io" },
          { id: "k3", key: "C", value: "customer" },
          { id: "k4", key: "D", value: "2026-09-26" },
        ],
      }),
    );

    expect(updateMock).toHaveBeenCalledWith(
      connection,
      ID,
      "Leads!A14:D14",
      [["Dana Reyes", "dana@northwind.io", "customer", "2026-09-26"]],
      expect.any(AbortSignal),
    );
    expect(result.output).toEqual({
      updatedCells: 4,
      updatedRows: 1,
      rowNumber: 14,
      range: "Leads!A14:D14",
      values: {
        A: "Dana Reyes",
        B: "dana@northwind.io",
        C: "customer",
        D: "2026-09-26",
      },
      operation: "update",
    });
  });

  it("refuses a row that is not a positive integer", async () => {
    for (const row of ["abc", 0, "-3", ""]) {
      await expectCode(
        () =>
          handlerFor("action.sheets_write")(
            makeContext({
              credential: "cred_sheets_1",
              spreadsheetId: ID,
              range: "A:D",
              operation: "update",
              row,
              values: [{ id: "k1", key: "A", value: "x" }],
            }),
          ),
        "SHEETS_RANGE_INVALID",
      );
    }
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("clears a range only after it was confirmed", async () => {
    await expectCode(
      () =>
        handlerFor("action.sheets_write")(
          makeContext({
            credential: "cred_sheets_1",
            spreadsheetId: ID,
            sheet: "Leads",
            range: "A:D",
            operation: "clear",
            confirmClear: false,
          }),
        ),
      "SHEETS_CLEAR_UNCONFIRMED",
    );
    expect(clearMock).not.toHaveBeenCalled();

    const result = await handlerFor("action.sheets_write")(
      makeContext({
        credential: "cred_sheets_1",
        spreadsheetId: ID,
        sheet: "Leads",
        range: "A:D",
        operation: "clear",
        confirmClear: true,
      }),
    );

    expect(clearMock).toHaveBeenCalledWith(connection, ID, "Leads!A:D", expect.any(AbortSignal));
    expect(result.output).toEqual({
      updatedCells: 0,
      updatedRows: 0,
      rowNumber: 0,
      range: "Leads!A:D",
      values: {},
      operation: "clear",
    });
  });

  it("refuses to clear a range that was never named", async () => {
    await expectCode(
      () =>
        handlerFor("action.sheets_write")(
          makeContext({
            credential: "cred_sheets_1",
            spreadsheetId: ID,
            range: "   ",
            operation: "clear",
            confirmClear: true,
          }),
        ),
      "SHEETS_RANGE_INVALID",
    );
    expect(clearMock).not.toHaveBeenCalled();
  });
});
