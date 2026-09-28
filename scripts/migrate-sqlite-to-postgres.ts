/**
 * Copy the SQLite store into PostgreSQL and prove it landed intact.
 *
 * Reads the legacy file read-only, creates the schema if the target does
 * not have it yet (the same seven migrations the application runs), copies
 * every row, then verifies two independent ways before it claims success:
 *
 *   - **row counts**, one number per table, so a lost table cannot hide
 *     behind a total that happens to match;
 *   - **per-table checksums** over the primary-key-ordered rows, so a
 *     value that changed in flight cannot hide behind an unchanged count.
 *
 * Rows are normalised through the *declared* SQLite column type before
 * hashing, because SQLite's dynamic typing lets a TEXT column hold an
 * integer while PostgreSQL's cannot — without that, a faithful copy would
 * still look different. Nothing here is destructive: a table that already
 * holds rows fails on the first duplicate key rather than merging or
 * overwriting, so a re-run against a populated target is loud, not lossy.
 *
 *   npx tsx scripts/migrate-sqlite-to-postgres.ts --dry-run
 *   npx tsx scripts/migrate-sqlite-to-postgres.ts --db .klyz/klyz.db --url $KLYZ_DATABASE_URL
 *
 * `--dry-run` writes nothing: it reports the source and the target's
 * current state so the two can be compared before the real copy.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, types } from "pg";

import { MIGRATIONS_PG } from "../src/lib/server/pg/migrations";

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dryRun = process.argv.includes("--dry-run");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = resolve(repoRoot, arg("--db", process.env.KLYZ_DB_PATH || ".klyz/klyz.db")!);
const url = arg("--url", process.env.KLYZ_DATABASE_URL);
const spotTables = Number(arg("--spot", "6"));
const spotRows = Number(arg("--spot-rows", "3"));

if (!url) {
  console.error("no target: pass --url or set KLYZ_DATABASE_URL");
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`source not found: ${dbPath}`);
  process.exit(2);
}

const SCHEMA_VERSION = Math.max(...MIGRATIONS_PG.map((m) => m.version));

/* `app_meta` is a key/value map, and `ensureSchema` has already written
   `schema_version` into the target — copying that key with a plain
   INSERT would collide with a row this script itself created. It is
   merged key by key instead; every other table is plain data and fails
   loudly on a duplicate rather than silently taking whichever side
   happens to run last. */
const MERGED_TABLES = new Set(["app_meta"]);

/* Mirror the application bridge: int8 and numeric arrive as strings from
   node-postgres, and the checksum compares them against SQLite numbers. */
types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`KLYZ_PG_INT8_OVERFLOW: int8 value ${value} is not a safe integer`);
  }
  return n;
});
types.setTypeParser(1700, Number);

/* ------------------------------------------------------------------ */
/* Reading the source                                                  */
/* ------------------------------------------------------------------ */

interface Column {
  name: string;
  type: string;
  pk: number;
}

/** `PRAGMA table_info` adds a physical-position column we sort by. */
interface PragmaColumn extends Column {
  cid: number;
}

interface Table {
  name: string;
  columns: Column[];
  pk: string[];
}

interface Snapshot {
  tables: Table[];
  counts: Map<string, number>;
  checksums: Map<string, string>;
  version: number;
}

/** Declare-time type decides how a value is compared, not what arrived. */
function normalize(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const t = type.toUpperCase();
  if (t.includes("BLOB")) {
    if (Buffer.isBuffer(value)) return value.toString("hex");
    if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
    return String(value);
  }
  if (t.includes("INT") || t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`non-numeric ${t} value ${JSON.stringify(value)}`);
    return n;
  }
  return String(value);
}

function canonical(columns: Column[], values: unknown[]): string {
  return JSON.stringify(columns.map((c, i) => [c.name, normalize(c.type, values[i])]));
}

function checksum(lines: string[]): string {
  const hash = createHash("sha256");
  for (const line of lines) hash.update(line).update("\n");
  return hash.digest("hex");
}

function quote(id: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new Error(`unsafe identifier: ${JSON.stringify(id)}`);
  return `"${id}"`;
}

function readSource(db: DatabaseSync): Snapshot {
  const listed = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;

  const tables: Table[] = listed.map(({ name }) => {
    const columns = (
      db.prepare(`PRAGMA table_info(${quote(name)})`).all() as unknown as PragmaColumn[]
    )
      .sort((a, b) => a.cid - b.cid)
      .map(({ name: n, type, pk }) => ({ name: n, type, pk }));
    return {
      name,
      columns,
      pk: columns
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
    };
  });

  const counts = new Map<string, number>();
  const checksums = new Map<string, string>();

  for (const table of tables) {
    const cols = table.columns.map((c) => quote(c.name)).join(", ");
    const order = table.pk.map(quote).join(", ");
    const rows = db
      .prepare(
        `SELECT ${cols} FROM ${quote(table.name)}${order ? ` ORDER BY ${order}` : ""}`,
      )
      .all() as Array<Record<string, unknown>>;

    const lines = rows.map((row) =>
      canonical(
        table.columns,
        table.columns.map((c) => row[c.name]),
      ),
    );
    counts.set(table.name, rows.length);
    checksums.set(table.name, checksum(lines));
  }

  const version = (() => {
    try {
      const row = db
        .prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
        .get() as { value?: string } | undefined;
      return Number(row?.value ?? 0) || 0;
    } catch {
      return 0;
    }
  })();

  return { tables, counts, checksums, version };
}

/* AUTOINCREMENT keeps its high-water mark in `sqlite_sequence`, which
   survives deleted rows: reusing those ids would be a silent regression. */
function readAutoincrement(db: DatabaseSync): Map<string, number> {
  const marks = new Map<string, number>();
  try {
    const rows = db.prepare("SELECT name, seq FROM sqlite_sequence").all() as Array<{
      name: string;
      seq: number;
    }>;
    for (const row of rows) marks.set(row.name, Number(row.seq));
  } catch {
    /* no AUTOINCREMENT table has ever been written */
  }
  return marks;
}

/* ------------------------------------------------------------------ */
/* Target                                                              */
/* ------------------------------------------------------------------ */

async function connect(target: string): Promise<Client> {
  const client = new Client({ connectionString: target, application_name: "klyz-migrate" });
  await client.connect();
  return client;
}

async function targetVersion(client: Client): Promise<number> {
  try {
    const row = await client.query("SELECT value FROM app_meta WHERE key = 'schema_version'");
    return Number(row.rows[0]?.value ?? 0) || 0;
  } catch {
    return 0; /* app_meta does not exist yet — brand-new database */
  }
}

async function ensureSchema(client: Client): Promise<void> {
  const current = await targetVersion(client);
  if (current >= SCHEMA_VERSION) return;
  for (const migration of MIGRATIONS_PG) {
    if (migration.version <= current) continue;
    await client.query(migration.sql);
    await writeVersion(client, migration.version);
  }
  await writeVersion(client, SCHEMA_VERSION);
}

async function writeVersion(client: Client, version: number): Promise<void> {
  await client.query(
    "INSERT INTO app_meta (key, value) VALUES ('schema_version', $1) " +
      "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [String(version)],
  );
}

async function readTargetCounts(
  client: Client,
  tables: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const name of tables) {
    try {
      const row = await client.query(`SELECT COUNT(*) AS c FROM ${quote(name)}`);
      counts.set(name, Number(row.rows[0]?.c ?? 0));
    } catch {
      /* the table does not exist yet — a brand-new target holds zero */
      counts.set(name, 0);
    }
  }
  return counts;
}

async function readTargetChecksums(
  client: Client,
  source: Table[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const table of source) {
    const cols = table.columns.map((c) => quote(c.name)).join(", ");
    const order = table.pk.map(quote).join(", ");
    const result = await client.query(
      `SELECT ${cols} FROM ${quote(table.name)}${order ? ` ORDER BY ${order}` : ""}`,
    );
    const lines = result.rows.map((row) =>
      canonical(
        table.columns,
        table.columns.map((c) => row[c.name]),
      ),
    );
    out.set(table.name, checksum(lines));
  }
  return out;
}

async function assertColumnsMatch(client: Client, table: Table): Promise<void> {
  const result = await client.query(
    "SELECT column_name FROM information_schema.columns " +
      "WHERE table_schema = 'public' AND table_name = $1",
    [table.name],
  );
  const target = new Set(result.rows.map((r) => String(r.column_name)));
  const missing = table.columns.map((c) => c.name).filter((n) => !target.has(n));
  if (missing.length > 0) {
    throw new Error(`${table.name}: target is missing column(s) ${missing.join(", ")}`);
  }
}

async function copyTable(
  client: Client,
  db: DatabaseSync,
  table: Table,
): Promise<number> {
  await assertColumnsMatch(client, table);

  const cols = table.columns.map((c) => quote(c.name)).join(", ");
  const order = table.pk.map(quote).join(", ");
  const rows = db
    .prepare(`SELECT ${cols} FROM ${quote(table.name)}${order ? ` ORDER BY ${order}` : ""}`)
    .all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return 0;

  const names = table.columns.map((c) => quote(c.name)).join(", ");
  const placeholders = table.columns.map((_, i) => `$${i + 1}`).join(", ");
  let statement = `INSERT INTO ${quote(table.name)} (${names}) VALUES (${placeholders})`;

  if (MERGED_TABLES.has(table.name)) {
    const updated = table.columns
      .filter((c) => !table.pk.includes(c.name))
      .map((c) => `${quote(c.name)} = EXCLUDED.${quote(c.name)}`)
      .join(", ");
    statement += ` ON CONFLICT (${table.pk.map(quote).join(", ")}) DO UPDATE SET ${updated}`;
  }

  for (const row of rows) {
    const values = table.columns.map((c) => row[c.name]);
    await client.query(statement, values);
  }
  return rows.length;
}

/** Bring each identity sequence back to where SQLite left it. */
async function fixSequences(
  client: Client,
  source: Table[],
  marks: Map<string, number>,
): Promise<number> {
  const sequences = await client.query(
    "SELECT c.relname AS table_name, a.attname AS column_name, " +
      "pg_get_serial_sequence(format('%I.%I', 'public', c.relname), a.attname) AS seq " +
      "FROM pg_class c " +
      "JOIN pg_namespace n ON n.oid = c.relnamespace " +
      "JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped " +
      "WHERE n.nspname = 'public' AND c.relkind = 'r'",
  );

  let fixed = 0;
  for (const row of sequences.rows) {
    const seq = row.seq;
    if (!seq) continue;
    const table = String(row.table_name);
    const column = String(row.column_name);
    const declared = marks.get(table);

    const max = await client.query(
      `SELECT MAX(${quote(column)}) AS m FROM ${quote(table)}`,
    );
    const actual = max.rows[0]?.m == null ? 0 : Number(max.rows[0].m);

    /* SQLite's AUTOINCREMENT high-water mark wins: it can be above every
       surviving row, and reusing those ids is exactly what it prevents. */
    const next = Math.max(actual, declared ?? 0);
    if (next === 0) {
      await client.query("SELECT setval($1, 1, false)", [String(seq)]);
    } else {
      await client.query("SELECT setval($1, $2, true)", [String(seq), next]);
    }
    fixed += 1;
  }
  return fixed;
}

/* ------------------------------------------------------------------ */
/* Spot reads                                                          */
/* ------------------------------------------------------------------ */

interface Spot {
  table: string;
  rows: number;
  identical: boolean;
}

async function spotRead(
  client: Client,
  db: DatabaseSync,
  source: Table[],
): Promise<Spot[]> {
  const report: Spot[] = [];
  const populated = source.filter((t) => (sourceCounts.get(t.name) ?? 0) > 0);

  for (const table of populated.slice(0, spotTables)) {
    const cols = table.columns.map((c) => quote(c.name)).join(", ");
    const order = table.pk.map(quote).join(", ");
    const limit = ` LIMIT ${spotRows}`;

    const left = db
      .prepare(`SELECT ${cols} FROM ${quote(table.name)} ORDER BY ${order}${limit}`)
      .all() as Array<Record<string, unknown>>;
    const right = (
      await client.query(`SELECT ${cols} FROM ${quote(table.name)} ORDER BY ${order}${limit}`)
    ).rows as Array<Record<string, unknown>>;

    const encode = (rows: Array<Record<string, unknown>>) =>
      rows
        .map((row) =>
          canonical(
            table.columns,
            table.columns.map((c) => row[c.name]),
          ),
        )
        .join("\n");

    report.push({
      table: table.name,
      rows: left.length,
      identical: encode(left) === encode(right),
    });
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

let sourceCounts: Map<string, number>;

async function main(): Promise<void> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const source = readSource(db);
  const marks = readAutoincrement(db);
  sourceCounts = source.counts;

  const rows = [...source.counts.entries()];
  const total = rows.reduce((n, [, c]) => n + c, 0);
  const manifest = rows.map(([t, c]) => `${t}\t${c}`).join("\n");
  const sourceManifest = createHash("sha256").update(`${manifest}\n${total}\n`).digest("hex");

  console.log(`source  ${dbPath}`);
  console.log(`         schema_version ${source.version}, ${source.tables.length} tables, ${total} rows`);
  console.log(`         manifest sha256 ${sourceManifest}`);
  console.log(`target  ${redact(url!)}`);
  console.log(`         ${dryRun ? "dry run — nothing will be written" : "copy + verify"}`);
  console.log("");

  let client: Client | undefined;
  try {
    client = await connect(url!);
  } catch (error) {
    console.log(`target unreachable: ${(error as Error).message}`);
    db.close();
    if (!dryRun) process.exit(1);
    return;
  }

  const before = await readTargetCounts(
    client!,
    source.tables.map((t) => t.name),
  );
  const beforeTotal = [...before.values()].reduce((n, c) => n + c, 0);
  console.log(`         currently holds ${beforeTotal} rows`);
  console.log(`         schema_version ${await targetVersion(client!)}`);
  console.log("");

  if (dryRun) {
    console.log(`${"table".padEnd(24)} ${"source".padStart(8)} ${"target".padStart(8)}`);
    for (const table of source.tables) {
      console.log(
        `${table.name.padEnd(24)} ${String(source.counts.get(table.name)).padStart(8)} ` +
          `${String(before.get(table.name)).padStart(8)}`,
      );
    }
    console.log(`${"TOTAL".padEnd(24)} ${String(total).padStart(8)} ${String(beforeTotal).padStart(8)}`);
    console.log(`\nready: ${total} rows would be copied into ${source.tables.length} tables`);
    db.close();
    await client!.end();
    return;
  }

  /* --- copy ------------------------------------------------------- */
  await ensureSchema(client!);

  console.log("copying…");
  let copied = 0;
  await client!.query("BEGIN");
  try {
    for (const table of source.tables) {
      const n = await copyTable(client!, db, table);
      copied += n;
      console.log(`  ${table.name.padEnd(24)} ${String(n).padStart(6)}`);
    }
    await client!.query("COMMIT");
  } catch (error) {
    await client!.query("ROLLBACK").catch(() => undefined);
    db.close();
    await client!.end();
    throw error;
  }
  console.log(`  ${"TOTAL".padEnd(24)} ${String(copied).padStart(6)}`);

  const sequences = await fixSequences(client!, source.tables, marks);
  console.log(`  sequences reset: ${sequences}`);
  console.log("");

  /* --- verify ----------------------------------------------------- */
  const after = await readTargetCounts(
    client!,
    source.tables.map((t) => t.name),
  );
  const afterTotal = [...after.values()].reduce((n, c) => n + c, 0);
  const afterChecksums = await readTargetChecksums(client!, source.tables);
  const spots = await spotRead(client!, db, source.tables);

  let ok = true;
  console.log(`${"table".padEnd(24)} ${"rows".padStart(12)} ${"checksum".padEnd(10)}`);
  for (const table of source.tables) {
    const name = table.name;
    const sameCount = source.counts.get(name) === after.get(name);
    const sameSum = source.checksums.get(name) === afterChecksums.get(name);
    if (!sameCount || !sameSum) ok = false;
    console.log(
      `${name.padEnd(24)} ` +
        `${String(after.get(name)).padStart(5)}/${String(source.counts.get(name)).padEnd(5)} ` +
        `${sameCount && sameSum ? "ok" : "MISMATCH"}`,
    );
  }
  console.log(`${"TOTAL".padEnd(24)} ${String(afterTotal).padStart(5)}/${String(total).padEnd(5)}`);

  console.log("\nspot reads:");
  for (const spot of spots) {
    if (!spot.identical) ok = false;
    console.log(
      `  ${spot.table.padEnd(24)} ${spot.rows} row(s) ${spot.identical ? "byte-identical" : "DIFFERENT"}`,
    );
  }

  console.log(
    ok
      ? `\nok: ${source.tables.length} tables, ${afterTotal} rows — counts and checksums match`
      : `\nFAILED: counts or checksums differ — see the mismatches above`,
  );

  db.close();
  await client!.end();
  if (!ok) process.exit(1);
}

/** Never print a password: the URL is only shown as its safe parts. */
function redact(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return raw;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
