import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDb, queryAll, setDatabaseDriver } from "./db";
import { pgQuery } from "./pg/bridge";
import { createTestDatabase, dropTestDatabase } from "./pg/test-database";

/**
 * The two dialects must describe the same database.
 *
 * The PostgreSQL DDL was ported by hand from the SQLite originals, and
 * hand ports drift. This test builds a fresh database with each dialect —
 * SQLite through `MIGRATIONS`, PostgreSQL through `MIGRATIONS_PG`, both
 * through the application's own startup path — then compares what each
 * one actually produced: tables, columns, nullability, primary keys,
 * unique constraints and every index down to its column order.
 *
 * Compared by structure, never by name. SQLite's implicit indexes are
 * called `sqlite_autoindex_*` and PostgreSQL's are called
 * `<table>_<columns>_key`; identical constraints under unshared names
 * are the normal case here, not a defect. Primary-key indexes are
 * excluded from the index comparison entirely, because SQLite's
 * `INTEGER PRIMARY KEY AUTOINCREMENT` is a rowid alias and produces no
 * index at all while PostgreSQL always creates one.
 */

interface Column {
  name: string;
  type: string;
  notNull: boolean;
}

interface IndexSignature {
  table: string;
  columns: string[];
  unique: boolean;
}

interface Schema {
  tables: string[];
  columns: Record<string, Column[]>;
  primaryKeys: Record<string, string[]>;
  indexes: IndexSignature[];
}

/** SQLite declared type → the PostgreSQL type it was ported to. */
function expectedPgType(sqliteType: string, tableSql: string, column: string): string {
  if (sqliteType.toUpperCase() !== "INTEGER") return sqliteType.toLowerCase();
  /* `INTEGER PRIMARY KEY AUTOINCREMENT` is a rowid alias in SQLite and
     a real identity column in PostgreSQL, which is BIGINT. */
  if (/AUTOINCREMENT/i.test(tableSql) && column === "seq") return "bigint";
  /* Epoch milliseconds and durations overflow a 32-bit INTEGER. */
  if (/(^|_)(at|ms)$/.test(column)) return "bigint";
  return "integer";
}

/** Fold PostgreSQL's `lower(x)` expression indexes back to SQLite's `x`. */
function normalizeColumn(column: string): string {
  const match = /^lower\((.*)\)$/i.exec(column.trim());
  return (match?.[1] ?? column).trim().toLowerCase();
}

/** Pull the ordered column list out of a SQLite `CREATE INDEX` statement. */
function sqliteIndexColumns(sql: string): string[] {
  const open = sql.indexOf("(");
  if (open === -1) return [];
  const inner = sql.slice(open + 1, sql.lastIndexOf(")"));
  return splitTopLevel(inner).map((part) => {
    const tokens = part.trim().split(/\s+/);
    /* `col`, `col ASC`, `col DESC` — the schema has no expression index
       on the SQLite side, so a bare column name is always token zero. */
    const first = (tokens[0] ?? "").toLowerCase();
    const direction = (tokens.at(-1) ?? "").toUpperCase();
    return direction === "DESC" || direction === "ASC"
      ? `${first} ${direction.toLowerCase()}`
      : first;
  });
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function readSqliteSchema(): Schema {
  const db = getDb();
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as unknown as { name: string; sql: string }[];

  const schema: Schema = { tables: [], columns: {}, primaryKeys: {}, indexes: [] };

  for (const { name, sql } of tables) {
    schema.tables.push(name);

    const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as unknown as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];

    schema.columns[name] = columns.map((column) => ({
      name: column.name,
      type: expectedPgType(column.type, sql, column.name),
      /* SQLite reports PRIMARY KEY columns as nullable unless the column
         itself says NOT NULL — a long-standing quirk of its rowid tables.
         PostgreSQL makes every PK column NOT NULL. The primary key is
         what the application relies on, so that is what is compared. */
      notNull: column.notnull === 1 || column.pk > 0,
    }));

    const pk = columns.filter((column) => column.pk > 0).map((column) => column.name);
    if (pk.length) schema.primaryKeys[name] = pk;

    const list = db.prepare(`PRAGMA index_list("${name}")`).all() as unknown as {
      name: string;
      unique: number;
      origin: string;
    }[];

    for (const index of list) {
      if (index.origin === "pk") continue;
      const raw = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(index.name) as { sql?: string } | undefined;
      const columnsForIndex = raw?.sql
        ? sqliteIndexColumns(raw.sql)
        : (
            db.prepare(`PRAGMA index_info("${index.name}")`).all() as unknown as {
              name: string;
            }[]
          ).map((column) => column.name.toLowerCase());

      schema.indexes.push({
        table: name,
        columns: columnsForIndex,
        unique: index.unique === 1,
      });
    }
  }

  return finalize(schema);
}

function readPgSchema(): Schema {
  const tables = pgQuery(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [],
    true,
  ).rows as { table_name: string }[];

  const columns = pgQuery(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
    [],
    true,
  ).rows as {
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }[];

  const indexes = pgQuery(
    `SELECT t.relname::text AS table_name,
            ix.indisunique AS is_unique,
            ix.indisprimary AS is_primary,
            /* chr(1) as separator: the bridge marshals JSON scalars only,
               so the column list arrives as one string and is split here. */
            pg_get_indexdef(ix.indexrelid) AS columns
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relkind = 'r'`,
    [],
    true,
  ).rows as {
    table_name: string;
    is_unique: boolean;
    is_primary: boolean;
    columns: string;
  }[];

  const schema: Schema = { tables: [], columns: {}, primaryKeys: {}, indexes: [] };

  for (const table of tables) schema.tables.push(table.table_name);

  for (const column of columns) {
    (schema.columns[column.table_name] ??= []).push({
      name: column.column_name,
      type: column.data_type,
      notNull: column.is_nullable === "NO",
    });
  }

  for (const index of indexes) {
    const normalized = sqliteIndexColumns(index.columns).map(normalizeColumn);
    if (index.is_primary) {
      schema.primaryKeys[index.table_name] = normalized;
      continue;
    }
    schema.indexes.push({
      table: index.table_name,
      columns: normalized,
      unique: index.is_unique,
    });
  }

  return finalize(schema);
}

function finalize(schema: Schema): Schema {
  schema.tables.sort();
  for (const key of Object.keys(schema.columns)) {
    (schema.columns[key] ?? []).sort((a, b) => a.name.localeCompare(b.name));
  }
  schema.indexes.sort(
    (a, b) =>
      a.table.localeCompare(b.table) ||
      Number(b.unique) - Number(a.unique) ||
      a.columns.join(",").localeCompare(b.columns.join(",")),
  );
  return schema;
}

function formatIndexes(indexes: IndexSignature[]): string[] {
  return indexes.map(
    (index) =>
      `${index.table}(${index.columns.join(", ")})${index.unique ? " UNIQUE" : ""}`,
  );
}

function queryOneSqlite(): string | undefined {
  const row = getDb()
    .prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  return row?.value;
}

let sqliteDir = "";
let pgName = "";
let sqliteSchema: Schema;
let pgSchema: Schema;
let pgSchemaVersion: string | undefined;
let emailIndexDef: string | undefined;
let sqliteSchemaVersion: string | undefined;

beforeAll(async () => {
  sqliteDir = mkdtempSync(join(tmpdir(), "klyz-schema-"));
  process.env.KLYZ_DB_PATH = join(sqliteDir, "schema.db");
  setDatabaseDriver("sqlite");
  queryAll("SELECT 1 AS ok");
  sqliteSchema = readSqliteSchema();
  sqliteSchemaVersion = queryOneSqlite();
  await closeDatabase();

  pgName = await createTestDatabase("klyz_schema");
  setDatabaseDriver("postgres");
  queryAll("SELECT 1 AS ok");
  pgSchema = readPgSchema();
  emailIndexDef = (
    pgQuery(
      "SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index " +
        "WHERE indexrelid = 'idx_users_email'::regclass",
      [],
      true,
    ).rows as { def: string }[]
  )[0]?.def;
  pgSchemaVersion = (
    pgQuery("SELECT value FROM app_meta WHERE key = 'schema_version'", [], true)
      .rows as { value: string }[]
  )[0]?.value;
  await closeDatabase();
  delete process.env.KLYZ_DATABASE_URL;
  delete process.env.KLYZ_DB_PATH;
}, 120_000);

afterAll(async () => {
  await closeDatabase();
  if (pgName) await dropTestDatabase(pgName);
  if (sqliteDir) rmSync(sqliteDir, { recursive: true, force: true });
  delete process.env.KLYZ_DATABASE_URL;
  delete process.env.KLYZ_DB_PATH;
}, 60_000);

describe("schema conformance", () => {
  it("creates the same tables", () => {
    expect(sqliteSchema.tables).toHaveLength(20);
    expect(pgSchema.tables).toEqual(sqliteSchema.tables);
  });

  it("creates the same columns with the same ported types and nullability", () => {
    for (const table of sqliteSchema.tables) {
      expect(pgSchema.columns[table], `columns of ${table}`).toEqual(
        sqliteSchema.columns[table],
      );
    }
  });

  it("declares the same primary keys", () => {
    expect(Object.keys(sqliteSchema.primaryKeys)).toHaveLength(20);
    expect(pgSchema.primaryKeys).toEqual(sqliteSchema.primaryKeys);
  });

  it("declares the same unique constraints", () => {
    const unique = (schema: Schema) =>
      formatIndexes(schema.indexes.filter((index) => index.unique));
    expect(unique(pgSchema)).toEqual(unique(sqliteSchema));
    expect(unique(sqliteSchema).length).toBeGreaterThan(5);
  });

  it("creates the same secondary indexes over the same columns", () => {
    const secondary = (schema: Schema) =>
      formatIndexes(schema.indexes.filter((index) => !index.unique));
    expect(secondary(pgSchema)).toEqual(secondary(sqliteSchema));
    expect(secondary(sqliteSchema).length).toBeGreaterThan(20);
  });

  it("folds case in the email index the way SQLite's NOCASE did", () => {
    expect(emailIndexDef).toMatch(/lower\(email\)/i);
  });

  it("stops both databases on schema version 7", () => {
    expect(sqliteSchemaVersion).toBe("7");
    expect(pgSchemaVersion).toBe("7");
  });
});
