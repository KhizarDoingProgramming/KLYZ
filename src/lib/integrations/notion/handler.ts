import type { NodeHandler, NodeRunContext } from "@/lib/engine/types";
import { NOTION_ERRORS, REMEDIATION, integrationError } from "../errors";
import { loadConnection } from "../provider/connection";
import type { ProviderConnection } from "../provider/types";
import { createPage, retrieveDatabase, retrievePage, searchPages, updatePage } from "./api";
import { parseNotionId, parseParentType, plainText } from "./config";
import { normalizePage, normalizeSearchResult, type NotionPage } from "./normalize";
import {
  buildProperties,
  normalizeProperties,
  textToBlocks,
  type PropertySchema,
  type PropertyType,
} from "./properties";

/**
 * Notion node handlers.
 *
 * Every handler reads and validates its config (expressions are already
 * resolved), loads the workspace-scoped connection and translates the
 * provider's response into the flat shape declared in `outputs`. The
 * one extra round trip — reading the database schema before a create —
 * is what lets a workflow set `Status: Triage` without knowing whether
 * the property is a select, a status or a rich text.
 */

type Config = Record<string, unknown>;

function text(config: Config, key: string): string {
  return plainText(config[key]);
}

function required(config: Config, key: string, label: string): string {
  const value = text(config, key);
  if (!value) {
    throw integrationError(NOTION_ERRORS.configInvalid, `This Notion step is missing ${label}.`, {
      hint: `Fill in "${label}" on the node.`,
      remediation: REMEDIATION.inspect,
    });
  }
  return value;
}

async function connect(context: NodeRunContext, config: Config): Promise<ProviderConnection> {
  return loadConnection(context.workspaceId, required(config, "credential", "a connection"), "notion");
}

/** The `propertyTypes` key/value rows, validated later by type name. */
function propertyTypes(config: Config): Record<string, PropertyType> {
  const raw = normalizeProperties(config.propertyTypes);
  const types: Record<string, PropertyType> = {};
  for (const [name, value] of Object.entries(raw)) types[name] = String(value) as PropertyType;
  return types;
}

function pageOutput(operation: string, page: NotionPage): Record<string, unknown> {
  return {
    page,
    pageId: page.id,
    url: page.url,
    title: page.title,
    operation,
  };
}

/** A database's `properties` map as a schema this step can build from. */
function databaseSchema(database: Record<string, unknown>): PropertySchema[] {
  const properties = database.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.entries(properties as Record<string, unknown>).flatMap(
    (entry): PropertySchema[] => {
      const [name, value] = entry;
      if (!value || typeof value !== "object") return [];
      const type = (value as { type?: unknown }).type;
      if (typeof type !== "string") return [];
      /* Notion's type vocabulary is wider than this step supports;
         buildProperties reports NOTION_PROPERTY_UNSUPPORTED for the
         ones a workflow actually maps. */
      return [{ name, type: type as PropertyType }];
    },
  );
}

export const notionPageHandler: NodeHandler = async (context) => {
  const config = context.config;
  const operation = text(config, "operation") || "create";
  const connection = await connect(context, config);

  if (operation === "create") return { output: await runCreate(context, connection, config) };
  if (operation === "update") return { output: await runUpdate(context, connection, config) };
  if (operation === "get") return { output: await runGet(context, connection, config) };

  throw integrationError(
    NOTION_ERRORS.configInvalid,
    `"${operation}" is not a Notion page operation.`,
    {
      hint: 'Choose "Create page", "Update page" or "Get page" on the node.',
      remediation: REMEDIATION.inspect,
    },
  );
};

async function runCreate(
  context: NodeRunContext,
  connection: ProviderConnection,
  config: Config,
): Promise<Record<string, unknown>> {
  const parentType = parseParentType(config.parentType);
  const parentId = parseNotionId(required(config, "parentId", "a parent id"));
  const title = required(config, "title", "a title");
  const values = normalizeProperties(config.properties);
  const types = propertyTypes(config);

  /* The database schema is the only source of truth for the title
     property's real name and for every other property's type — one
     extra call, and the mapping cannot be silently wrong. */
  const schema =
    parentType === "database"
      ? databaseSchema(await retrieveDatabase(connection, parentId, context.signal))
      : undefined;

  const body: Record<string, unknown> = {
    parent: parentType === "database" ? { database_id: parentId } : { page_id: parentId },
    properties: buildProperties({ values, types, schema, title }),
  };
  const children = textToBlocks(text(config, "content"));
  if (children.length > 0) body.children = children;

  const created = await createPage(connection, body, context.signal);
  return pageOutput("create", normalizePage(created));
}

async function runUpdate(
  context: NodeRunContext,
  connection: ProviderConnection,
  config: Config,
): Promise<Record<string, unknown>> {
  const pageId = parseNotionId(required(config, "pageId", "a page id"));
  const values = normalizeProperties(config.properties);
  const types = propertyTypes(config);

  const patch: Record<string, unknown> = {};
  if (Object.keys(values).length > 0) {
    /* Without an explicit type every property needs its schema; finding
       out which parent the page has means reading the page first. */
    const needsSchema = Object.keys(values).some((name) => types[name] === undefined);
    patch.properties = buildProperties({
      values,
      types,
      schema: needsSchema ? await schemaForPage(connection, pageId, context.signal) : undefined,
    });
  }

  const archived = config.archived;
  if (typeof archived === "boolean" || (typeof archived === "string" && archived.trim() !== "")) {
    patch.archived =
      typeof archived === "boolean" ? archived : archived.trim().toLowerCase() === "true";
  }

  if (Object.keys(patch).length === 0) {
    throw integrationError(NOTION_ERRORS.configInvalid, "This update has nothing to change.", {
      hint: "Set at least one property, or turn on “Archive page”.",
      remediation: REMEDIATION.inspect,
    });
  }

  const updated = await updatePage(connection, pageId, patch, context.signal);
  return pageOutput("update", normalizePage(updated));
}

/** Schema of the database a page lives in, or none for a page parent. */
async function schemaForPage(
  connection: ProviderConnection,
  pageId: string,
  signal: AbortSignal,
): Promise<PropertySchema[] | undefined> {
  const page = await retrievePage(connection, pageId, signal);
  const parent = page.parent;
  const databaseId =
    parent && typeof parent === "object"
      ? (parent as Record<string, unknown>).database_id
      : undefined;
  if (typeof databaseId !== "string" || !databaseId) return undefined;
  return databaseSchema(await retrieveDatabase(connection, parseNotionId(databaseId), signal));
}

async function runGet(
  context: NodeRunContext,
  connection: ProviderConnection,
  config: Config,
): Promise<Record<string, unknown>> {
  const pageId = parseNotionId(required(config, "pageId", "a page id"));
  const page = await retrievePage(connection, pageId, context.signal);
  return pageOutput("get", normalizePage(page));
}

export const notionSearchHandler: NodeHandler = async (context) => {
  const config = context.config;
  const connection = await connect(context, config);

  const query = text(config, "query");
  const kind = text(config, "kind") || "all";
  const limitText = text(config, "limit");
  const limitRaw = Number(limitText);
  const limit = limitText && Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 50)) : 20;

  const body: Record<string, unknown> = {
    query,
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: limit,
  };
  if (kind === "page" || kind === "database") {
    body.filter = { property: "object", value: kind };
  }

  const response = await searchPages(connection, body, context.signal);
  const results = (Array.isArray(response.results) ? response.results : []).map(
    normalizeSearchResult,
  );

  return {
    output: {
      results,
      result: results[0] ?? {},
      count: results.length,
      query,
    },
  };
};

export const notionHandlers: Record<string, NodeHandler> = {
  "action.notion_page": notionPageHandler,
  "action.notion_search": notionSearchHandler,
};
