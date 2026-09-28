import { randomBytes } from "node:crypto";

import { Client, type ClientConfig } from "pg";

import { pgQuery, resetPgBridge } from "./bridge";

/**
 * Per-test PostgreSQL databases.
 *
 * Every test file gets its own database rather than its own schema, so
 * one file's `DROP TABLE` cannot be seen by another running in parallel
 * and connection-level state (`SET search_path`, advisory locks, temp
 * tables) stays isolated for free.
 *
 * The base connection is read from `KLYZ_TEST_DATABASE_URL` and never
 * from `KLYZ_DATABASE_URL`: the application URL points at the real
 * database, and a test that dropped it would be unrecoverable.
 */

const BASE_URL =
  process.env.KLYZ_TEST_DATABASE_URL ||
  "postgres://klyz:klyz@127.0.0.1:5432/postgres";

function baseConfig(): ClientConfig {
  return { connectionString: BASE_URL, application_name: "klyz-test-setup" };
}

/** URL for a database on the same server as `KLYZ_TEST_DATABASE_URL`. */
export function databaseUrlFor(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(baseConfig());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Quote an identifier so `quote`/`$1` cannot inject SQL. */
function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe database name: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/**
 * Create an empty database and point `KLYZ_DATABASE_URL` at it.
 *
 * Dropping first makes the helper idempotent, which matters when a test
 * file is re-run against a leaked database from a previous run.
 */
export async function createTestDatabase(prefix: string): Promise<string> {
  const name = `${prefix}_${randomBytes(5).toString("hex")}`;
  await withAdmin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quote(name)}`);
  });
  const url = databaseUrlFor(name);
  process.env.KLYZ_DATABASE_URL = url;
  return name;
}

export async function dropTestDatabase(name: string): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
  });
}

/** Point `KLYZ_DATABASE_URL` at `value`, or remove it when there is none. */
function restoreUrl(value: string | undefined): void {
  if (value === undefined) delete process.env.KLYZ_DATABASE_URL;
  else process.env.KLYZ_DATABASE_URL = value;
}

/**
 * Create a database synchronously, on the main thread.
 *
 * Test files call this from module scope, before any hook has run, because
 * they read the database through module-level calls such as
 * `defaultActor()`. There is no event loop turn to await here, so the
 * work goes through the bridge's own worker: the pool is detached from
 * whatever URL it held, spawned against the admin URL, used for the two
 * statements, then detached again so the next query spawns against the
 * database just created.
 */
export function createTestDatabaseSync(prefix: string): string {
  const name = `${prefix}_${randomBytes(5).toString("hex")}`;
  const previous = process.env.KLYZ_DATABASE_URL;
  resetPgBridge();
  process.env.KLYZ_DATABASE_URL = BASE_URL;
  let created = false;
  try {
    pgQuery(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`, [], false);
    pgQuery(`CREATE DATABASE ${quote(name)}`, [], false);
    created = true;
  } finally {
    resetPgBridge();
    restoreUrl(created ? databaseUrlFor(name) : previous);
  }
  return name;
}

/** Synchronous counterpart of {@link dropTestDatabase}. */
export function dropTestDatabaseSync(name: string): void {
  const previous = process.env.KLYZ_DATABASE_URL;
  resetPgBridge();
  process.env.KLYZ_DATABASE_URL = BASE_URL;
  try {
    pgQuery(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`, [], false);
  } finally {
    resetPgBridge();
    restoreUrl(previous);
  }
}
