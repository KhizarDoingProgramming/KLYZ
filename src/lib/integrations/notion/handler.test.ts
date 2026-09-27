import { beforeEach, describe, expect, it, vi } from "vitest";
import { EngineError, type NodeHandler, type NodeRunContext } from "@/lib/engine/types";
import type { Workflow } from "@/lib/workflow/types";
import { loadConnection } from "@/lib/integrations/provider/connection";
import { NOTION_ERRORS } from "../errors";
import { createPage, retrieveDatabase, retrievePage, searchPages, updatePage } from "./api";
import { notionHandlers } from "./handler";

vi.mock("./api", () => ({
  createPage: vi.fn(),
  retrieveDatabase: vi.fn(),
  retrievePage: vi.fn(),
  searchPages: vi.fn(),
  updatePage: vi.fn(),
}));

vi.mock("@/lib/integrations/provider/connection", () => ({
  loadConnection: vi.fn(async () => ({
    credentialId: "cred_notion",
    provider: "notion",
    workspaceId: "ws_test",
    name: "Notion",
    status: "connected",
    account: "klyz",
    scopes: [],
    accessToken: "token",
    expiresAt: null,
    extra: {},
  })),
}));

const PAGE_ID = "8f2a91c0d17b4c2ea1b0c4d5e6f7a8b9";
const PAGE_ID_DASHED = "8f2a91c0-d17b-4c2e-a1b0-c4d5e6f7a8b9";
const DB_ID = "3c7e1ab94f2d4a6b8c0d1e2f3a4b5c6d";
const DB_ID_DASHED = "3c7e1ab9-4f2d-4a6b-8c0d-1e2f3a4b5c6d";

const DATABASE_SCHEMA = {
  id: DB_ID_DASHED,
  object: "database",
  properties: {
    Name: { id: "title", type: "title" },
    Status: { type: "select" },
    Priority: { type: "select" },
    Score: { type: "number" },
  },
};

const CREATED_PAGE = {
  id: PAGE_ID_DASHED,
  object: "page",
  url: `https://www.notion.so/Kickoff-${PAGE_ID}`,
  created_time: "2026-09-26T09:00:00.000Z",
  last_edited_time: "2026-09-26T09:05:00.000Z",
  archived: false,
  icon: { type: "emoji", emoji: "📘" },
  parent: { type: "database_id", database_id: DB_ID_DASHED },
  properties: {
    Name: { title: [{ type: "text", plain_text: "Kickoff" }] },
    Status: { select: { name: "Triage" } },
    Priority: { select: { name: "high" } },
  },
};

const SEARCH_HIT = {
  id: PAGE_ID_DASHED,
  object: "page",
  url: `https://www.notion.so/Roadmap-${PAGE_ID}`,
  created_time: "2026-09-20T09:00:00.000Z",
  last_edited_time: "2026-09-25T09:00:00.000Z",
  archived: false,
  icon: { type: "emoji", emoji: "🗺️" },
  properties: { Name: { title: [{ plain_text: "Roadmap" }] } },
};

const SEARCH_DATABASE = {
  id: DB_ID_DASHED,
  object: "database",
  created_time: "2026-09-01T09:00:00.000Z",
  last_edited_time: "2026-09-24T09:00:00.000Z",
  archived: false,
  title: [{ plain_text: "Issues" }],
};

function makeContext(config: Record<string, unknown>): NodeRunContext {
  return {
    executionId: "ex_notion_test",
    workspaceId: "ws_test",
    workflow: { id: "wf_notion_test", name: "Notion test" } as unknown as Workflow,
    nodeId: "n_notion",
    nodeType: "action.notion_page",
    config,
    rawConfig: config,
    scope: {} as NodeRunContext["scope"],
    triggerInput: null,
    attempt: 1,
    signal: new AbortController().signal,
    publishStatus: () => undefined,
  };
}

function handler(type: string): NodeHandler {
  const found = notionHandlers[type];
  if (!found) throw new Error(`no handler registered for ${type}`);
  return found;
}

function outputOf(result: unknown): Record<string, unknown> {
  return (result as { output: Record<string, unknown> }).output;
}

async function expectAsyncError(run: unknown, code: string): Promise<void> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createPage).mockResolvedValue(CREATED_PAGE);
  vi.mocked(retrieveDatabase).mockResolvedValue(DATABASE_SCHEMA);
  vi.mocked(retrievePage).mockResolvedValue(CREATED_PAGE);
  vi.mocked(updatePage).mockResolvedValue(CREATED_PAGE);
  vi.mocked(searchPages).mockResolvedValue({ results: [SEARCH_HIT, SEARCH_DATABASE] });
});

describe("action.notion_page — create", () => {
  it("creates in a database, typing properties from the fetched schema", async () => {
    const context = makeContext({
      credential: "cred_notion",
      parentId: DB_ID_DASHED,
      title: "Kickoff",
      properties: [
        { id: "kv_1", key: "Status", value: "Triage" },
        { id: "kv_2", key: "Priority", value: "high" },
      ],
      content: "Line one\nLine two",
    });

    const output = outputOf(await handler("action.notion_page")(context));

    expect(loadConnection).toHaveBeenCalledWith("ws_test", "cred_notion", "notion");
    expect(retrieveDatabase).toHaveBeenCalledTimes(1);
    expect(retrieveDatabase).toHaveBeenCalledWith(expect.anything(), DB_ID, context.signal);
    expect(createPage).toHaveBeenCalledTimes(1);

    const body = vi.mocked(createPage).mock.calls[0]?.[1];
    expect(body).toEqual({
      parent: { database_id: DB_ID },
      properties: {
        Name: { title: [{ type: "text", text: { content: "Kickoff" } }] },
        Status: { select: { name: "Triage" } },
        Priority: { select: { name: "high" } },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "Line one" } }] },
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "Line two" } }] },
        },
      ],
    });

    expect(output.operation).toBe("create");
    expect(output.pageId).toBe(PAGE_ID);
    expect(output.title).toBe("Kickoff");
    expect(output.url).toBe(CREATED_PAGE.url);
    expect((output.page as { properties: Record<string, unknown> }).properties).toMatchObject({
      Name: "Kickoff",
      Status: "Triage",
      Priority: "high",
    });
  });

  it("creates inside a page without touching a database", async () => {
    const context = makeContext({
      credential: "cred_notion",
      parentType: "page",
      parentId: PAGE_ID_DASHED,
      title: "Child page",
      properties: [{ id: "kv_1", key: "Score", value: "42" }],
      propertyTypes: [{ id: "kv_2", key: "Score", value: "number" }],
    });
    vi.mocked(createPage).mockResolvedValue({
      ...CREATED_PAGE,
      parent: { type: "page_id", page_id: PAGE_ID_DASHED },
      properties: { title: { type: "title", title: [{ type: "text", plain_text: "Child page" }] } },
    });

    const output = outputOf(await handler("action.notion_page")(context));

    expect(retrieveDatabase).not.toHaveBeenCalled();
    const body = vi.mocked(createPage).mock.calls[0]?.[1];
    expect(body).toEqual({
      parent: { page_id: PAGE_ID },
      properties: {
        title: { title: [{ type: "text", text: { content: "Child page" } }] },
        Score: { number: 42 },
      },
    });
    expect(output.operation).toBe("create");
    expect(output.title).toBe("Child page");
  });

  it("rejects a missing parent id", async () => {
    const context = makeContext({ credential: "cred_notion", title: "Kickoff" });
    await expectAsyncError(handler("action.notion_page")(context), NOTION_ERRORS.configInvalid);
    expect(retrieveDatabase).not.toHaveBeenCalled();
    expect(createPage).not.toHaveBeenCalled();
  });

  it("rejects an unsupported property type", async () => {
    const context = makeContext({
      credential: "cred_notion",
      parentType: "page",
      parentId: PAGE_ID_DASHED,
      title: "Kickoff",
      properties: [{ id: "kv_1", key: "Owner", value: "Dana" }],
      propertyTypes: [{ id: "kv_2", key: "Owner", value: "people" }],
    });
    await expectAsyncError(
      handler("action.notion_page")(context),
      NOTION_ERRORS.propertyUnsupported,
    );
    expect(createPage).not.toHaveBeenCalled();
  });
});

describe("action.notion_page — update", () => {
  it("archives with a single field and reads no schema", async () => {
    const context = makeContext({
      credential: "cred_notion",
      operation: "update",
      pageId: PAGE_ID_DASHED,
      archived: true,
    });

    const output = outputOf(await handler("action.notion_page")(context));

    expect(retrievePage).not.toHaveBeenCalled();
    expect(retrieveDatabase).not.toHaveBeenCalled();
    expect(updatePage).toHaveBeenCalledWith(
      expect.anything(),
      PAGE_ID,
      { archived: true },
      context.signal,
    );
    expect(output.operation).toBe("update");
    expect(output.pageId).toBe(PAGE_ID);
  });

  it("builds properties against the schema of the page's database", async () => {
    const context = makeContext({
      credential: "cred_notion",
      operation: "update",
      pageId: PAGE_ID_DASHED,
      properties: [{ id: "kv_1", key: "Status", value: "Done" }],
    });

    const output = outputOf(await handler("action.notion_page")(context));

    expect(retrievePage).toHaveBeenCalledWith(expect.anything(), PAGE_ID, context.signal);
    expect(retrieveDatabase).toHaveBeenCalledWith(expect.anything(), DB_ID, context.signal);
    expect(updatePage).toHaveBeenCalledWith(
      expect.anything(),
      PAGE_ID,
      { properties: { Status: { select: { name: "Done" } } } },
      context.signal,
    );
    expect(output.operation).toBe("update");
  });

  it("rejects a page id that is not an id", async () => {
    const context = makeContext({
      credential: "cred_notion",
      operation: "update",
      pageId: "not-a-page-id",
      archived: true,
    });
    await expectAsyncError(
      handler("action.notion_page")(context),
      NOTION_ERRORS.pageIdInvalid,
    );
    expect(updatePage).not.toHaveBeenCalled();
  });

  it("rejects an update with nothing to change", async () => {
    const context = makeContext({
      credential: "cred_notion",
      operation: "update",
      pageId: PAGE_ID_DASHED,
    });
    await expectAsyncError(
      handler("action.notion_page")(context),
      NOTION_ERRORS.configInvalid,
    );
    expect(updatePage).not.toHaveBeenCalled();
  });
});

describe("action.notion_page — get", () => {
  it("reads one page and normalises it", async () => {
    const context = makeContext({
      credential: "cred_notion",
      operation: "get",
      pageId: PAGE_ID_DASHED,
    });

    const output = outputOf(await handler("action.notion_page")(context));

    expect(retrievePage).toHaveBeenCalledWith(expect.anything(), PAGE_ID, context.signal);
    expect(createPage).not.toHaveBeenCalled();
    expect(updatePage).not.toHaveBeenCalled();
    expect(output.operation).toBe("get");
    expect(output.pageId).toBe(PAGE_ID);
    expect(output.title).toBe("Kickoff");
    expect(output.url).toBe(CREATED_PAGE.url);
  });

  it("rejects a missing page id", async () => {
    const context = makeContext({ credential: "cred_notion", operation: "get" });
    await expectAsyncError(
      handler("action.notion_page")(context),
      NOTION_ERRORS.configInvalid,
    );
  });
});

describe("action.notion_search", () => {
  it("searches pages with a filter and a clamped limit", async () => {
    const context = makeContext({
      credential: "cred_notion",
      query: "roadmap",
      kind: "page",
      limit: "5",
    });

    const output = outputOf(await handler("action.notion_search")(context));

    expect(searchPages).toHaveBeenCalledWith(
      expect.anything(),
      {
        query: "roadmap",
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 5,
        filter: { property: "object", value: "page" },
      },
      context.signal,
    );
    expect(output.query).toBe("roadmap");
    expect(output.count).toBe(2);
    expect((output.results as unknown[]).length).toBe(2);
    expect(output.result).toMatchObject({ id: PAGE_ID, title: "Roadmap", type: "page" });
  });

  it("lists everything with defaults when no query or kind is set", async () => {
    const context = makeContext({ credential: "cred_notion" });

    const output = outputOf(await handler("action.notion_search")(context));

    expect(searchPages).toHaveBeenCalledWith(
      expect.anything(),
      {
        query: "",
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 20,
      },
      context.signal,
    );
    expect(output.query).toBe("");
    expect((output.results as Array<{ type: string }>)[1]?.type).toBe("database");
  });

  it("returns an empty first hit when nothing matched", async () => {
    vi.mocked(searchPages).mockResolvedValue({ results: [] });
    const output = outputOf(
      await handler("action.notion_search")(
        makeContext({ credential: "cred_notion", query: "nothing" }),
      ),
    );
    expect(output.result).toEqual({});
    expect(output.count).toBe(0);
    expect(output.results).toEqual([]);
  });

  it("requires a connection", async () => {
    await expectAsyncError(
      handler("action.notion_search")(makeContext({})),
      NOTION_ERRORS.configInvalid,
    );
    expect(searchPages).not.toHaveBeenCalled();
  });
});
