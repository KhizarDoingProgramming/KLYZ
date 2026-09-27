import { NOTION_ERRORS, REMEDIATION, integrationError } from "../errors";

/**
 * Notion property mapping.
 *
 * A workflow only knows plain values — `"Triage"`, `"42"`, `"yes"` —
 * while Notion insists on one typed payload per property, decided by
 * the database's schema. This module is the translation layer: it turns
 * a `properties` key/value config plus the (optional) schema into the
 * `properties` body Notion accepts, and flattens Notion's answers back
 * into values expressions can read. Pure — no network, no credentials.
 */

export type PropertyType =
  | "title"
  | "rich_text"
  | "number"
  | "checkbox"
  | "select"
  | "multi_select"
  | "url"
  | "email"
  | "date"
  | "status";

export const SUPPORTED_PROPERTY_TYPES: PropertyType[] = [
  "title",
  "rich_text",
  "number",
  "checkbox",
  "select",
  "multi_select",
  "url",
  "email",
  "date",
  "status",
];

export interface PropertySchema {
  name: string;
  type: PropertyType;
}

/** What a property reads as inside a workflow expression. */
export type PropertyValue = string | number | boolean | null | string[];

/** Notion caps a single rich-text value at 2000 characters. */
const RICH_TEXT_LIMIT = 2000;

/** Checkbox truthiness, matching what a key/value row can express. */
const TRUTHY = new Set(["true", "1", "yes", "on"]);

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

function configError(message: string, hint: string): never {
  throw integrationError(NOTION_ERRORS.configInvalid, message, {
    hint,
    remediation: REMEDIATION.inspect,
  });
}

function unsupported(type: string): never {
  throw integrationError(
    NOTION_ERRORS.propertyUnsupported,
    `Notion property type "${type}" is not supported by this step.`,
    {
      hint: `Supported types: ${SUPPORTED_PROPERTY_TYPES.join(", ")}.`,
      remediation: REMEDIATION.inspect,
    },
  );
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || text(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    configError(
      `"${text(value)}" is not a number, but this property expects one.`,
      "Use a numeric value, or clear the field to leave the property empty.",
    );
  }
  return parsed;
}

function optionName(value: unknown): { name: string } | null {
  const name = text(value).trim();
  return name ? { name } : null;
}

function names(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => text(item).trim()).filter(Boolean);
  }
  return text(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const PROPERTY_BUILDERS: Record<PropertyType, (value: unknown) => object> = {
  title: (value) => ({
    title: [{ type: "text", text: { content: truncate(text(value), RICH_TEXT_LIMIT) } }],
  }),
  rich_text: (value) => ({
    rich_text: [{ type: "text", text: { content: truncate(text(value), RICH_TEXT_LIMIT) } }],
  }),
  number: (value) => ({ number: numberValue(value) }),
  checkbox: (value) => ({
    checkbox: TRUTHY.has(text(value).trim().toLowerCase()),
  }),
  select: (value) => ({ select: optionName(value) }),
  status: (value) => ({ status: optionName(value) }),
  multi_select: (value) => ({ multi_select: names(value).map((name) => ({ name })) }),
  url: (value) => ({ url: text(value) }),
  email: (value) => ({ email: text(value) }),
  date: (value) => {
    const start = text(value).trim();
    return { date: start ? { start } : null };
  },
};

/**
 * Explicit `types[name]` wins, then the database schema, then
 * `rich_text` — the type a page parent gets when nothing else is known.
 */
function resolveType(
  name: string,
  types: Record<string, PropertyType> | undefined,
  schema: PropertySchema[] | undefined,
): PropertyType {
  const explicit = types?.[name];
  if (explicit !== undefined) {
    if (!SUPPORTED_PROPERTY_TYPES.includes(explicit)) unsupported(String(explicit));
    return explicit;
  }
  const entry = schema?.find((property) => property.name === name);
  if (entry) {
    if (!SUPPORTED_PROPERTY_TYPES.includes(entry.type)) unsupported(entry.type);
    return entry.type;
  }
  if (schema) {
    configError(
      `"${name}" is not a property of this database.`,
      `This database has: ${schema.map((property) => property.name).join(", ") || "no properties"}.`,
    );
  }
  return "rich_text";
}

/** Builds Notion `properties` payload entries from plain values. */
export function buildProperties(params: {
  values: Record<string, unknown>;
  types?: Record<string, PropertyType>;
  schema?: PropertySchema[];
  title?: string;
}): Record<string, unknown> {
  const { values, types, schema, title } = params;
  const out: Record<string, unknown> = {};

  if (title !== undefined) {
    /* The schema decides which property carries the title; without one
       Notion's canonical `title` key is used for a page parent. */
    const titleName =
      schema?.find((property) => property.type === "title")?.name ??
      Object.entries(types ?? {}).find(([, type]) => type === "title")?.[0] ??
      "title";
    resolveType(titleName, types, schema);
    out[titleName] = PROPERTY_BUILDERS.title(title);
  }

  for (const [name, value] of Object.entries(values)) {
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = PROPERTY_BUILDERS[resolveType(name, types, schema)](value);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Reading values back                                                 */
/* ------------------------------------------------------------------ */

/** The `properties` key/value rows (or a plain object) as a record. */
function entriesOf(raw: unknown): Array<[string, unknown]> {
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .filter((item) => typeof item.key === "string" && item.key.trim() !== "")
      .map((item) => [String(item.key), item.value] as [string, unknown]);
  }
  if (raw && typeof raw === "object") return Object.entries(raw as Record<string, unknown>);
  return [];
}

function segmentText(segment: unknown): string {
  if (!segment || typeof segment !== "object") return "";
  const record = segment as Record<string, unknown>;
  if (typeof record.plain_text === "string") return record.plain_text;
  const rich = record.text;
  if (rich && typeof rich === "object") {
    const content = (rich as Record<string, unknown>).content;
    if (typeof content === "string") return content;
  }
  return "";
}

function optionText(value: unknown): PropertyValue {
  if (!value || typeof value !== "object") return null;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

/** A Notion property payload (`{title:[…]}`, `{number:3}`, …) → a plain value. */
function fromProperty(record: Record<string, unknown>): PropertyValue | undefined {
  if (Array.isArray(record.title)) return record.title.map(segmentText).join("");
  if (Array.isArray(record.rich_text)) return record.rich_text.map(segmentText).join("");
  if (typeof record.number === "number" || record.number === null) return record.number;
  if (typeof record.checkbox === "boolean") return record.checkbox;
  if ("select" in record) return optionText(record.select);
  if ("status" in record) return optionText(record.status);
  if (Array.isArray(record.multi_select)) {
    return record.multi_select.map((option) => optionText(option)).filter((name): name is string => name !== null);
  }
  if (typeof record.url === "string" || record.url === null) return record.url;
  if (typeof record.email === "string" || record.email === null) return record.email;
  if ("date" in record) {
    const date = record.date;
    if (!date || typeof date !== "object") return null;
    const start = (date as Record<string, unknown>).start;
    return typeof start === "string" ? start : null;
  }
  return undefined;
}

function itemText(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "object") {
    const record = item as Record<string, unknown>;
    if (typeof record.plain_text === "string") return record.plain_text;
    if (typeof record.name === "string") return record.name;
    return JSON.stringify(record);
  }
  return String(item);
}

function plainValue(value: unknown): PropertyValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(itemText);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const property = fromProperty(record);
    return property !== undefined ? property : JSON.stringify(record);
  }
  return text(value);
}

/**
 * Anything that carries properties — key/value rows, a plain record or
 * a page straight from the API — as `name → plain value`.
 */
export function normalizeProperties(raw: unknown): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const [name, value] of entriesOf(raw)) {
    const plain = plainValue(value);
    if (plain === undefined) continue;
    out[name] = plain;
  }
  return out;
}

/** Concatenated `plain_text` of a rich-text array (titles, search hits). */
export function richTextToPlain(segments: unknown[]): string {
  return segments.map(segmentText).join("");
}

/** One paragraph block per non-empty line, rich text capped at 2000 chars. */
export function textToBlocks(value: string): unknown[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          { type: "text", text: { content: truncate(line, RICH_TEXT_LIMIT) } },
        ],
      },
    }));
}
