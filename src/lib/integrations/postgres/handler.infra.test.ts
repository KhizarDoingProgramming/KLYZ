import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * PostgreSQL integration — real database.
 *
 * Runs against the docker compose `postgres` service (database
 * `klyz_integrations`). It fails with setup instructions rather than
 * silently skipping, like the queue infra suite.
 */

const tmpDir = mkdtempSync(join(tmpdir(), "klyz-pg-infra-"));
process.env.KLYZ_DB_PATH = join(tmpDir, "klyz.db");
process.env.KLYZ_QUEUE_DRIVER = "memory";

import { Pool } from "pg";
import type { NodeRunContext } from "@/lib/engine/types";
import type { Workflow } from "@/lib/workflow/types";
import { defaultActor } from "@/lib/server/identity";
import { createCredential, deleteCredential } from "@/lib/server/credentials";
import { getDb } from "@/lib/server/db";
import { postgresHandler } from "./handler";

const actor = defaultActor();
const PG_URL =
  process.env.KLYZ_PG_URL ??
  "postgres://klyz:klyz@127.0.0.1:5432/klyz_integrations";
const TABLE = "klyz_infra_leads";

let credentialId = "";
let setupPool: Pool;

function makeContext(
  config: Record<string, unknown>,
  nodeType: "action.postgres" | "data.postgres" = "action.postgres",
): NodeRunContext {
  return {
    executionId: "ex_pg_infra",
    workspaceId: actor.workspaceId,
    workflow: { id: "wf_pg_infra", name: "Postgres infra" } as unknown as Workflow,
    nodeId: "n_pg",
    nodeType,
    config,
    rawConfig: config,
    scope: { trigger: { payload: {} } },
    triggerInput: null,
    attempt: 1,
    signal: new AbortController().signal,
    publishStatus: () => undefined,
  };
}

async function run(
  config: Record<string, unknown>,
  nodeType: "action.postgres" | "data.postgres" = "action.postgres",
) {
  return (await postgresHandler(makeContext(config, nodeType))) as {
    output: Record<string, unknown>;
  };
}

async function isPostgresReachable(): Promise<boolean> {
  const { createConnection } = await import("node:net");
  return new Promise((resolve) => {
    const socket = createConnection({ port: 5432, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

beforeAll(async () => {
  if (!(await isPostgresReachable())) {
    throw new Error(
      "PostgreSQL is not reachable on 127.0.0.1:5432.\n" +
        "PostgreSQL integration tests need the real database:\n" +
        "    npm run infra:up   (docker compose up -d redis postgres)",
    );
  }
  credentialId = createCredential(actor, {
    name: "infra postgres",
    kind: "postgres",
    fields: { connectionString: PG_URL },
  }).id;

  setupPool = new Pool({ connectionString: PG_URL, max: 1 });
  await setupPool.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await setupPool.query(
    `CREATE TABLE ${TABLE} (
       id serial primary key,
       email text not null,
       source text,
       created_at timestamptz default now()
     )`,
  );
}, 30_000);

afterAll(async () => {
  try {
    await setupPool?.query(`DROP TABLE IF EXISTS ${TABLE}`);
  } catch {
    /* database already gone */
  }
  await setupPool?.end();
  try {
    if (credentialId) deleteCredential(actor, credentialId);
  } catch {
    /* credential already removed */
  }
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("postgres handler against the real database", () => {
  it("inserts, selects and reads rows through the builder operations", async () => {
    const inserted = await run({
      credential: credentialId,
      operation: "insert",
      table: TABLE,
      values: [
        { id: "1", key: "email", value: "ada@example.com" },
        { id: "2", key: "source", value: "infra-test" },
      ],
      returning: "id, email",
    });
    expect(inserted.output.rowCount).toBe(1);
    const rows = inserted.output.rows as Array<Record<string, unknown>>;
    expect(rows[0]?.email).toBe("ada@example.com");

    const selected = await run({
      credential: credentialId,
      operation: "select",
      table: TABLE,
      where: [{ id: "1", key: "email", value: "ada@example.com" }],
      orderBy: "id",
      limit: 10,
    });
    const found = selected.output.rows as Array<Record<string, unknown>>;
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]?.email).toBe("ada@example.com");
    expect(selected.output.rowCount).toBeGreaterThanOrEqual(1);
  });

  it("runs a parameterised raw query", async () => {
    const { output } = await run({
      credential: credentialId,
      operation: "query",
      query: `select email from ${TABLE} where source = $1 order by id`,
      params: [{ id: "1", key: "1", value: "infra-test" }],
      readMode: "rows",
    });
    const rows = output.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.email).toBe("ada@example.com");
  });

  it("reads through the data.postgres node type", async () => {
    const { output } = await run(
      {
        credential: credentialId,
        query: `select count(*)::int as n from ${TABLE}`,
        limit: 5,
      },
      "data.postgres",
    );
    const rows = output.rows as Array<Record<string, unknown>>;
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(1);
    expect(output.rowCount).toBe(1);
  });

  it("refuses unsafe SQL before it reaches the database", async () => {
    await expect(
      run({
        credential: credentialId,
        operation: "query",
        query: `select 1; drop table ${TABLE}`,
        params: [],
        readMode: "rows",
      }),
    ).rejects.toMatchObject({ code: "POSTGRES_INVALID_QUERY" });

    await expect(
      run({
        credential: credentialId,
        operation: "update",
        table: TABLE,
        set: [{ id: "1", key: "source", value: "nope" }],
      }),
    ).rejects.toMatchObject({ code: "POSTGRES_INVALID_QUERY" });

    /* The table is still there after the refused statements. */
    const probe = await setupPool.query(`select count(*) from ${TABLE}`);
    expect(Number(probe.rows[0].count)).toBeGreaterThanOrEqual(1);
  });

  it("refuses {{expressions}} inside raw SQL before connecting", async () => {
    await expect(
      run({
        credential: credentialId,
        operation: "query",
        query: `select * from ${TABLE} where email = '{{webhook.body.email}}'`,
        params: [],
        readMode: "rows",
      }),
    ).rejects.toMatchObject({ code: "POSTGRES_INVALID_QUERY" });
  });

  it("surfaces connection failures with a credential error code", async () => {
    const bad = createCredential(actor, {
      name: "infra postgres unreachable",
      kind: "postgres",
      fields: { host: "127.0.0.1", port: "59999", database: "nope", user: "nope" },
    });
    try {
      await expect(
        run({ credential: bad.id, operation: "select", table: TABLE }),
      ).rejects.toMatchObject({ code: "POSTGRES_CONNECTION_FAILED" });
    } finally {
      deleteCredential(actor, bad.id);
    }
  }, 20_000);
});
