import { POSTGRES_ERRORS, REMEDIATION, integrationError } from "../errors";

/**
 * Safe SQL construction for the PostgreSQL node.
 *
 * Two paths, both closed to injection:
 *  - raw queries are validated (single statement, allowlisted leading
 *    keyword) and always run through the driver's parameter binding;
 *  - builder operations generate SQL from identifier-checked names and
 *    `$n` placeholders — user values never touch the SQL text.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWED_LEADING_KEYWORDS = new Set(["select", "insert", "update", "delete", "with"]);
const PLACEHOLDER = /\$(\d+)/g;

export interface RawQuery {
  sql: string;
  params: unknown[];
}

function invalid(message: string, detail?: string, hint?: string) {
  return integrationError(POSTGRES_ERRORS.invalidQuery, message, {
    detail,
    hint: hint ?? "Only a single SELECT/INSERT/UPDATE/DELETE (or WITH) statement is allowed.",
    remediation: REMEDIATION.inspect,
  });
}

export function assertIdentifier(value: string, label: string): string {
  const name = value.trim();
  if (!IDENTIFIER.test(name)) {
    throw invalid(
      `${label} "${name}" is not a valid SQL identifier.`,
      "Use letters, digits and underscores; it must not start with a digit.",
      "Identifiers are checked, never interpolated from free text.",
    );
  }
  return name;
}

/** Schema-qualified table name: `table` or `schema.table`, each part validated. */
export function assertTableName(value: string): string {
  const name = value.trim();
  const parts = name.split(".");
  if (parts.length > 2 || parts.some((part) => part.trim() === "")) {
    throw invalid(
      `"${name}" is not a valid table name.`,
      "Use `table` or `schema.table` with letters, digits and underscores only.",
    );
  }
  return parts.map((part) => assertIdentifier(part, "Table")).join(".");
}

/** Validate a user-authored statement: one statement, allowlisted verb. */
export function assertSafeQuery(raw: string): string {
  const sql = raw.trim();
  if (!sql) throw invalid("The query is empty.");
  if (sql.includes("\0")) throw invalid("The query contains a null byte.");

  const withoutTrailing = sql.replace(/;+\s*$/, "");
  if (withoutTrailing.includes(";")) {
    throw invalid(
      "Only one statement can run at a time.",
      "Remove the extra `;` — a second statement could be a data-changing command you did not intend.",
    );
  }
  const leading = withoutTrailing.match(/^[a-zA-Z]+/);
  const keyword = leading?.[0]?.toLowerCase() ?? "";
  if (!ALLOWED_LEADING_KEYWORDS.has(keyword)) {
    throw invalid(
      `"${keyword || "?"}" statements are not allowed.`,
      "The node accepts SELECT, INSERT, UPDATE, DELETE and WITH (CTE) statements only — no DDL, DCL or utility commands.",
    );
  }
  return withoutTrailing;
}

/** Highest `$n` index used in a statement (for appending a new param). */
export function maxParamIndex(sql: string): number {
  let max = 0;
  for (const match of sql.matchAll(PLACEHOLDER)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** Key/value config rows → bound parameter values, in order. */
export function paramValues(rows: readonly { key: string; value: unknown }[]): unknown[] {
  return rows
    .filter((row) => row.key.trim() !== "")
    .map((row) => normaliseParam(row.value));
}

function normaliseParam(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return "";
    if (trimmed === "null") return null;
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return value;
  }
  return value;
}

export interface WhereClause {
  sql: string;
  params: unknown[];
}

/** `col = $n AND col = $n …` from key/value rows. */
export function buildWhere(
  rows: readonly { key: string; value: unknown }[],
  startIndex: number,
  label = "condition",
): WhereClause {
  const params = paramValues(rows);
  if (params.length === 0) return { sql: "", params: [] };
  const conditions = rows
    .filter((row) => row.key.trim() !== "")
    .map((row, index) => `${assertIdentifier(row.key, label)} = $${startIndex + index}`);
  return { sql: conditions.join(" AND "), params };
}

export function buildSelect(input: {
  table: string;
  columns?: string;
  where?: readonly { key: string; value: unknown }[];
  orderBy?: string;
  limit?: number;
}): RawQuery {
  const table = assertTableName(input.table);
  const columns = input.columns?.trim()
    ? input.columns
        .split(",")
        .map((column) => assertIdentifier(column, "Column"))
        .join(", ")
    : "*";

  let sql = `SELECT ${columns} FROM ${table}`;
  const params: unknown[] = [];

  const where = buildWhere(input.where ?? [], 1);
  if (where.sql) {
    sql += ` WHERE ${where.sql}`;
    params.push(...where.params);
  }
  if (input.orderBy?.trim()) {
    const order = input.orderBy
      .split(",")
      .map((part) => {
        const [rawColumn, rawDirection] = part.trim().split(/\s+/);
        const column = assertIdentifier(rawColumn ?? "", "Order-by column");
        const direction = (rawDirection ?? "asc").toLowerCase();
        if (direction !== "asc" && direction !== "desc") {
          throw invalid(`Cannot sort by "${rawDirection}" — use ASC or DESC.`);
        }
        return `${column} ${direction.toUpperCase()}`;
      })
      .join(", ");
    sql += ` ORDER BY ${order}`;
  }
  if (input.limit !== undefined && input.limit > 0) {
    sql += ` LIMIT $${params.length + 1}`;
    params.push(Math.min(Math.floor(input.limit), 10_000));
  }
  return { sql, params };
}

export function buildInsert(input: {
  table: string;
  values: readonly { key: string; value: unknown }[];
  returning?: string;
}): RawQuery {
  const table = assertTableName(input.table);
  const entries = input.values.filter((row) => row.key.trim() !== "");
  if (entries.length === 0) throw invalid("An INSERT needs at least one column/value.");
  const columns = entries.map((row) => assertIdentifier(row.key, "Column"));
  const params = paramValues(entries);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  let sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;
  if (input.returning?.trim()) {
    const returning = input.returning
      .split(",")
      .map((column) => assertIdentifier(column, "Returning column"))
      .join(", ");
    sql += ` RETURNING ${returning}`;
  }
  return { sql, params };
}

export function buildUpdate(input: {
  table: string;
  set: readonly { key: string; value: unknown }[];
  where?: readonly { key: string; value: unknown }[];
}): RawQuery {
  const table = assertTableName(input.table);
  const entries = input.set.filter((row) => row.key.trim() !== "");
  if (entries.length === 0) throw invalid("An UPDATE needs at least one column to set.");
  const params = paramValues(entries);
  const assignments = entries.map(
    (row, index) => `${assertIdentifier(row.key, "Column")} = $${index + 1}`,
  );
  let sql = `UPDATE ${table} SET ${assignments.join(", ")}`;

  const where = buildWhere(input.where ?? [], params.length + 1);
  if (!where.sql) {
    throw invalid(
      "An UPDATE without a WHERE clause would rewrite every row.",
      "Add at least one WHERE condition (or run the change deliberately from a migration).",
    );
  }
  sql += ` WHERE ${where.sql}`;
  params.push(...where.params);
  return { sql, params };
}

/**
 * Apply a row limit to a user query.
 *
 * SELECT/WITH statements are wrapped so the database does the limiting;
 * anything else runs as written and is sliced afterwards (a RETURNING
 * statement, for example).
 */
export function applyRowLimit(query: RawQuery, limit?: number): RawQuery {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return query;
  const capped = Math.min(Math.floor(limit), 10_000);
  const leading = query.sql.trim().toLowerCase().startsWith("select")
    ? "select"
    : query.sql.trim().toLowerCase().startsWith("with")
      ? "with"
      : "";
  if (leading) {
    return {
      sql: `SELECT * FROM (${query.sql}) AS _klyz_limited LIMIT $${maxParamIndex(query.sql) + 1}`,
      params: [...query.params, capped],
    };
  }
  return query;
}
