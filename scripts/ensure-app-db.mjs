#!/usr/bin/env node
/**
 * Create the application database if the server does not have it yet.
 *
 * `npm run infra:up` runs this after the containers are healthy. An
 * init SQL script inside the image would only run on the *first* boot of
 * a fresh volume, so a developer who already has `pg-data` would silently
 * be missing the database — this runs every time and is a no-op once the
 * database exists.
 *
 * The name comes from `KLYZ_DATABASE_URL`; only the database part of the
 * URL is dropped to reach an administrative connection, so pointing the
 * app at `...:5432/team_db` asks for `team_db` rather than for a name
 * hardcoded here.
 *
 *   node scripts/ensure-app-db.mjs
 *   KLYZ_DATABASE_URL=postgres://klyz:klyz@127.0.0.1:5432/klyz node scripts/ensure-app-db.mjs
 */

import { Client } from "pg";

const DEFAULT_URL = "postgres://klyz:klyz@127.0.0.1:5432/klyz";
const target = process.env.KLYZ_DATABASE_URL || DEFAULT_URL;

const url = new URL(target);
const name = url.pathname.replace(/^\//, "");

/* `CREATE DATABASE` takes an identifier, never a bound parameter. */
if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
  console.error(`refusing to create a database named ${JSON.stringify(name)}`);
  process.exit(2);
}

url.pathname = "/postgres";
const client = new Client({
  connectionString: url.toString(),
  application_name: "klyz-ensure-app-db",
});

await client.connect();
try {
  const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (existing.rowCount > 0) {
    console.log(`database ${name} already exists`);
  } else {
    await client.query(`CREATE DATABASE "${name}"`);
    console.log(`created database ${name}`);
  }
} finally {
  await client.end();
}
