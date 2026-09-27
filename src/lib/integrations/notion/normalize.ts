import { dashed } from "./config";
import { normalizeProperties, richTextToPlain, type PropertyValue } from "./properties";

/**
 * Notion → KLYZ normalisation.
 *
 * The untouched payload stays under `raw` for advanced mapping, while
 * everything a workflow normally references is flat and stable: ids are
 * canonicalised, titles are lifted out of whichever property holds
 * them, and Notion's typed property values become the plain values
 * expressions read.
 */

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  properties: Record<string, PropertyValue>;
  parent: Record<string, unknown> | null;
  icon: string | null;
  raw: Record<string, unknown>;
}

export interface NotionSearchResult {
  id: string;
  title: string;
  url: string;
  type: "page" | "database";
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  icon: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Canonical id, or "" when the payload carried something else. */
function canonicalId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim().toLowerCase().replace(/-/g, "");
  return /^[0-9a-f]{32}$/.test(value) ? value : "";
}

function iconText(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.emoji === "string") return raw.emoji;
  if (isRecord(raw.external) && typeof raw.external.url === "string") return raw.external.url;
  if (isRecord(raw.file) && typeof raw.file.url === "string") return raw.file.url;
  return null;
}

export function normalizePage(page: unknown): NotionPage {
  const raw = isRecord(page) ? page : {};
  const id = canonicalId(raw.id);
  const url = typeof raw.url === "string" && raw.url ? raw.url : pageUrl(id);
  return {
    id,
    title: extractTitle(raw),
    url,
    createdAt: typeof raw.created_time === "string" ? raw.created_time : "",
    updatedAt: typeof raw.last_edited_time === "string" ? raw.last_edited_time : "",
    archived: raw.archived === true || raw.in_trash === true,
    properties: normalizeProperties(raw.properties),
    parent: isRecord(raw.parent) ? raw.parent : null,
    icon: iconText(raw.icon),
    raw,
  };
}

/** The page title, wherever Notion stores it on the payload. */
export function extractTitle(page: unknown): string {
  const raw = isRecord(page) ? page : {};
  if (isRecord(raw.properties)) {
    for (const [name, value] of Object.entries(raw.properties)) {
      if (isRecord(value) && Array.isArray(value.title)) return richTextToPlain(value.title);
      /* A page parent stores its title under the bare `title` key. */
      if (name === "title" && Array.isArray(value)) return richTextToPlain(value);
    }
  }
  /* Databases and search hits carry their title at the top level. */
  if (Array.isArray(raw.title)) return richTextToPlain(raw.title);
  return "";
}

export function normalizeSearchResult(item: unknown): NotionSearchResult {
  const raw = isRecord(item) ? item : {};
  const id = canonicalId(raw.id);
  return {
    id,
    title: extractTitle(raw),
    url: typeof raw.url === "string" && raw.url ? raw.url : pageUrl(id),
    type: raw.object === "database" ? "database" : "page",
    createdAt: typeof raw.created_time === "string" ? raw.created_time : "",
    updatedAt: typeof raw.last_edited_time === "string" ? raw.last_edited_time : "",
    archived: raw.archived === true || raw.in_trash === true,
    icon: iconText(raw.icon),
  };
}

/** Shareable link for a page or database id. */
export function pageUrl(id: string): string {
  const canonical = canonicalId(id);
  return canonical ? `https://www.notion.so/${dashed(canonical)}` : "";
}
