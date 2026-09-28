#!/usr/bin/env node
/**
 * Checkpoint the legacy SQLite store before a schema-changing event.
 *
 * Uses `VACUUM INTO`, which takes a transactionally consistent online
 * snapshot without blocking writers — never a naive file copy, which
 * would race with the WAL. The snapshot is self-contained (no -wal
 * sidecar) so it can be reopened read-only on any machine.
 *
 * Also prints a row-count + checksum manifest. Phase 6 of the
 * PostgreSQL migration compares that manifest against the target
 * database, so run this first, then run the cutover, then compare.
 *
 *   node scripts/backup-sqlite.mjs
 *   node scripts/backup-sqlite.mjs --db /abs/path/klyz.db --out .klyz/backups
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dbPath = resolve(repoRoot, arg("--db", process.env.KLYZ_DB_PATH || ".klyz/klyz.db"));
const outDir = resolve(repoRoot, arg("--out", ".klyz/backups"));
const keep = Number(arg("--keep", "10"));

if (!/^\d+$/.test(String(keep))) {
  console.error("--keep must be a non-negative integer");
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });

/* Read-only: a backup must never take a write lock on the live store. */
const db = new DatabaseSync(dbPath, { readOnly: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const snapshotPath = join(outDir, `${basename(dbPath)}-${stamp}.sqlite`);

db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);

/* Manifest: one line per table, sorted, stable across runs. */
const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all();

const counts = [];
let total = 0;
for (const { name } of tables) {
  const { c } = db.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`).get();
  counts.push({ table: name, rows: c });
  total += c;
}
db.close();

const manifest = counts.map((r) => `${r.table}\t${r.rows}`).join("\n");
const checksum = createHash("sha256").update(`${manifest}\n${total}\n`).digest("hex");

/* Prune old snapshots; keep the newest `keep`. */
const prefix = `${basename(dbPath)}-`;
const stale = readdirSync(outDir)
  .filter((f) => f.startsWith(prefix) && f.endsWith(".sqlite"))
  .map((f) => ({ f, m: statSync(join(outDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)
  .slice(keep)
  .map((x) => x.f);
for (const f of stale) {
  try {
    rmSync(join(outDir, f));
  } catch {
    /* best effort */
  }
}

const snapshotBytes = statSync(snapshotPath).size;

const report = {
  source: dbPath,
  snapshot: snapshotPath,
  snapshotBytes,
  tables: counts.length,
  rows: total,
  checksum,
  sha256: createHash("sha256").update(readFileSync(snapshotPath)).digest("hex"),
  at: new Date().toISOString(),
};

console.log(JSON.stringify(report, null, 2));
console.log("\nrow counts:");
for (const r of counts) console.log(`  ${r.table.padEnd(28)} ${r.rows}`);
console.log(`  ${"TOTAL".padEnd(28)} ${total}`);
console.log(`\nmanifest sha256: ${checksum}`);
