import { evaluateCondition } from "@/lib/engine/conditions";
import { resolvePath } from "@/lib/workflow/expressions";
import { TRANSFORM_ERRORS, integrationError } from "../errors";

/**
 * Data Transform operations.
 *
 * Pure functions over the node's input. Two kinds of field appear here:
 *  - **paths** (`status`, `profile.email`, `items[0].id`) — read straight
 *    off the current item, with a fallback to the run scope;
 *  - **expressions** (`{{item.email}}`) — resolved per item against
 *    `{…run scope, item, index}` from the *raw* config, because the
 *    executor's outer resolution pass has already consumed `{{…}}`.
 *
 * Nothing is `eval`'d: expressions go through the same resolver the
 * engine uses everywhere else.
 */

export interface OperationMeta {
  id: string;
  label: string;
  description: string;
  produces: "array" | "any" | "text" | "number";
  needsArray: boolean;
}

export const OPERATIONS: OperationMeta[] = [
  { id: "filter", label: "Filter", description: "Keep items matching a condition.", produces: "array", needsArray: true },
  { id: "map", label: "Map fields", description: "Build new objects from item fields.", produces: "array", needsArray: true },
  { id: "pick", label: "Pick fields", description: "Keep only the listed paths.", produces: "array", needsArray: true },
  { id: "rename", label: "Rename fields", description: "Rename top-level keys.", produces: "array", needsArray: true },
  { id: "sort", label: "Sort", description: "Order items by a path.", produces: "array", needsArray: true },
  { id: "dedupe", label: "De-duplicate", description: "Drop repeated items.", produces: "array", needsArray: true },
  { id: "flatten", label: "Flatten", description: "Collapse nested arrays.", produces: "array", needsArray: true },
  { id: "slice", label: "Slice", description: "Take a window of items.", produces: "array", needsArray: true },
  { id: "first", label: "First item", description: "The first item (null when empty).", produces: "any", needsArray: true },
  { id: "last", label: "Last item", description: "The last item (null when empty).", produces: "any", needsArray: true },
  { id: "aggregate", label: "Aggregate", description: "sum / count / avg / min / max.", produces: "number", needsArray: true },
  { id: "get", label: "Get by path", description: "Read one value out of an object.", produces: "any", needsArray: false },
  { id: "to_json", label: "To JSON", description: "Serialise the value to text.", produces: "text", needsArray: false },
  { id: "from_json", label: "From JSON", description: "Parse JSON text into a value.", produces: "any", needsArray: false },
];

export const OPERATION_IDS = OPERATIONS.map((operation) => operation.id);
export const AGGREGATE_FNS = ["sum", "count", "avg", "min", "max"] as const;

export interface OperationRuntime {
  /** Resolve a raw config value against `{…scope, item, index}`. */
  resolveItem: (raw: unknown, item: unknown, index: number) => unknown;
  /** Outer run scope — plain paths fall back to it. */
  scope: Record<string, unknown>;
}

export interface OperationResult {
  value: unknown;
  count: number;
}

function invalid(message: string, detail?: string, hint?: string) {
  return integrationError(TRANSFORM_ERRORS.invalidConfig, message, {
    detail,
    hint: hint ?? "Open the step and complete the operation's fields.",
  });
}

function asArray(input: unknown, operation: string): unknown[] {
  if (Array.isArray(input)) return input;
  if (input === null || input === undefined) return [];
  throw invalid(
    `"${operation}" needs a list to work on.`,
    `Received ${describe(input)} instead of an array.`,
    "Point the input at an array (a query result, a webhook list, …).",
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function resolveItemPath(
  runtime: OperationRuntime,
  item: unknown,
  index: number,
  raw: unknown,
): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const path = raw.trim();
  if (path.includes("{{")) {
    return runtime.resolveItem(raw, item, index);
  }
  if (path === "$") return item;
  if (path === "$index") return index;
  const fromItem =
    item !== null && typeof item === "object"
      ? resolvePath(item as Record<string, unknown>, path)
      : undefined;
  if (fromItem !== undefined) return fromItem;
  /* Fall back to the run scope so `context.startedAt`-style paths work. */
  return resolvePath(runtime.scope, path);
}

function resolveRaw(
  runtime: OperationRuntime,
  item: unknown,
  index: number,
  raw: unknown,
): unknown {
  if (typeof raw === "string" && raw.includes("{{")) {
    return runtime.resolveItem(raw, item, index);
  }
  return raw;
}

function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function requireOperation(operation: string): void {
  if (!OPERATION_IDS.includes(operation)) {
    throw invalid(`Unknown transform operation "${operation}".`);
  }
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

export function applyOperation(
  operation: string,
  config: Record<string, unknown>,
  rawConfig: Record<string, unknown>,
  input: unknown,
  runtime: OperationRuntime,
): OperationResult {
  requireOperation(operation);
  const raw = (key: string): unknown => rawConfig[key];
  const resolved = (key: string): unknown => config[key];

  switch (operation) {
    case "filter": {
      const items = asArray(input, operation);
      const leftRaw = raw("left");
      const rightRaw = raw("value");
      const operator = String(resolved("operator") ?? "eq");
      if (typeof leftRaw !== "string" || !leftRaw.trim()) {
        throw invalid("Filter needs a field to test.", "Set the left-hand path or expression.");
      }
      const kept = items.filter((item, index) => {
        const left = resolveItemPath(runtime, item, index, leftRaw);
        const right = resolveRaw(runtime, item, index, rightRaw);
        try {
          return evaluateCondition({ left, operator, right });
        } catch (error) {
          throw integrationError(
            TRANSFORM_ERRORS.invalidExpression,
            "The filter condition could not be evaluated.",
            {
              detail: error instanceof Error ? error.message : "condition failed",
              hint: "Check the operator (a bad pattern for `matches` fails here) and the value.",
            },
          );
        }
      });
      return { value: kept, count: kept.length };
    }

    case "map": {
      const items = asArray(input, operation);
      /* Prefer the raw rows: their values still carry `{{item…}}`. */
      const rows = keyValueRows(raw("fields"));
      if (rows.length === 0) {
        throw invalid("Map needs at least one output field.");
      }
      const mapped = items.map((item, index) => {
        const out: Record<string, unknown> = {};
        for (const row of rows) {
          out[row.key] = resolveRaw(runtime, item, index, row.value);
        }
        return out;
      });
      return { value: mapped, count: mapped.length };
    }

    case "pick": {
      const items = asArray(input, operation);
      const keys = splitList(resolved("keys"));
      if (keys.length === 0) throw invalid("Pick needs a list of field paths.");
      const picked = items.map((item) => {
        const out: Record<string, unknown> = {};
        for (const key of keys) {
          out[key] = item !== null && typeof item === "object"
            ? (resolvePath(item as Record<string, unknown>, key) ?? null)
            : null;
        }
        return out;
      });
      return { value: picked, count: picked.length };
    }

    case "rename": {
      const items = asArray(input, operation);
      const rows = keyValueRows(resolved("mappings"));
      if (rows.length === 0) throw invalid("Rename needs at least one new → old mapping.");
      const renamed = items.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw invalid(
            "Rename can only rework objects.",
            `Received ${describe(item)}.`,
          );
        }
        const source = { ...(item as Record<string, unknown>) };
        const out: Record<string, unknown> = {};
        const moved = new Set<string>();
        for (const row of rows) {
          const oldKey = row.value;
          if (typeof oldKey !== "string" || !(oldKey in source)) continue;
          out[row.key] = source[oldKey];
          moved.add(oldKey);
        }
        for (const [key, value] of Object.entries(source)) {
          if (!moved.has(key)) out[key] = value;
        }
        return out;
      });
      return { value: renamed, count: renamed.length };
    }

    case "sort": {
      const items = asArray(input, operation);
      const by = typeof resolved("by") === "string" ? String(resolved("by")).trim() : "";
      if (!by) throw invalid("Sort needs a field path to order by.");
      const direction = String(resolved("direction") ?? "asc").toLowerCase() === "desc" ? -1 : 1;
      const decorated = items.map((item, index) => ({
        item,
        index,
        key: resolveItemPath(runtime, item, index, by),
      }));
      decorated.sort((a, b) => {
        const order = compareKeys(a.key, b.key);
        return order !== 0 ? order * direction : a.index - b.index;
      });
      const sorted = decorated.map((entry) => entry.item);
      return { value: sorted, count: sorted.length };
    }

    case "dedupe": {
      const items = asArray(input, operation);
      const by = typeof resolved("by") === "string" ? String(resolved("by")).trim() : "";
      const seen = new Set<string>();
      const output: unknown[] = [];
      items.forEach((item, index) => {
        const key = by
          ? stableKey(resolveItemPath(runtime, item, index, by))
          : stableKey(item);
        if (seen.has(key)) return;
        seen.add(key);
        output.push(item);
      });
      return { value: output, count: output.length };
    }

    case "flatten": {
      const items = asArray(input, operation);
      const depth = clampInt(resolved("depth"), 0, 10, 1);
      const flattened = flatten(items, depth);
      return { value: flattened, count: flattened.length };
    }

    case "slice": {
      const items = asArray(input, operation);
      const offset = clampInt(resolved("offset"), 0, Number.MAX_SAFE_INTEGER, 0);
      const limitRaw = Number(resolved("limit"));
      const end = Number.isFinite(limitRaw) && limitRaw > 0 ? offset + Math.floor(limitRaw) : undefined;
      const sliced = items.slice(offset, end);
      return { value: sliced, count: sliced.length };
    }

    case "first":
    case "last": {
      const items = asArray(input, operation);
      const value = operation === "first" ? (items[0] ?? null) : (items[items.length - 1] ?? null);
      return { value, count: value === null ? 0 : 1 };
    }

    case "aggregate": {
      const items = asArray(input, operation);
      const fn = String(resolved("fn") ?? "count");
      if (!(AGGREGATE_FNS as readonly string[]).includes(fn)) {
        throw invalid(`Unknown aggregate "${fn}".`, `Use one of: ${AGGREGATE_FNS.join(", ")}.`);
      }
      const path = typeof resolved("path") === "string" ? String(resolved("path")).trim() : "";
      if (fn !== "count" && !path) {
        throw invalid(`"${fn}" needs a field path to read values from.`);
      }
      const values = items
        .map((item, index) =>
          path ? resolveItemPath(runtime, item, index, path) : item,
        )
        .filter((value) => value !== null && value !== undefined);
      return { value: aggregate(fn, values, items.length), count: items.length };
    }

    case "get": {
      const path = typeof resolved("path") === "string" ? String(resolved("path")).trim() : "";
      if (!path) throw invalid("Get needs a field path.");
      const value = resolveItemPath(runtime, input, 0, path);
      return { value: value ?? null, count: countOf(value) };
    }

    case "to_json": {
      const text = safeStringify(input);
      return { value: text, count: text.length };
    }

    case "from_json": {
      const text =
        typeof input === "string" ? input : typeof input === "number" || typeof input === "boolean" ? String(input) : "";
      if (!text.trim()) {
        throw invalid("From JSON received nothing to parse.", "Point the input at JSON text.");
      }
      try {
        const value: unknown = JSON.parse(text);
        return { value, count: countOf(value) };
      } catch (error) {
        throw integrationError(
          TRANSFORM_ERRORS.invalidExpression,
          "The input is not valid JSON.",
          {
            detail: error instanceof Error ? error.message : "JSON.parse failed",
            hint: "Check that the upstream step produced text (not an already-parsed object).",
          },
        );
      }
    }
  }

  throw invalid(`Unknown transform operation "${operation}".`);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function keyValueRows(value: unknown): { key: string; value: unknown }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({ key: String(item.key ?? "").trim(), value: item.value }))
    .filter((row) => row.key !== "");
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function flatten(items: unknown[], depth: number): unknown[] {
  let output = [...items];
  for (let level = 0; level < depth; level += 1) {
    if (!output.some((item) => Array.isArray(item))) break;
    output = output.flatMap((item) => (Array.isArray(item) ? item : [item]));
  }
  return output;
}

function compareKeys(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function aggregate(fn: string, values: unknown[], total: number): number {
  if (fn === "count") return values.length;
  const numbers = values
    .map((value) => (typeof value === "number" ? value : Number(value)))
    .filter((value) => Number.isFinite(value));
  if (fn === "sum") return numbers.reduce((sum, value) => sum + value, 0);
  if (fn === "avg") return numbers.length === 0 ? 0 : numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  if (fn === "min") return numbers.length === 0 ? 0 : Math.min(...numbers);
  if (fn === "max") return numbers.length === 0 ? 0 : Math.max(...numbers);
  return total;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
