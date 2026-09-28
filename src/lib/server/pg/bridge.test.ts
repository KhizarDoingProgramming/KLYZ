import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { disposePgBridge, pgQuery } from "./bridge";
import { createTestDatabase, dropTestDatabase } from "./test-database";

let name = "";

beforeAll(async () => {
  name = await createTestDatabase("klyz_bridge");
}, 60_000);

afterAll(async () => {
  await disposePgBridge();
  if (name) await dropTestDatabase(name);
  /* vitest may reuse this worker for the next file: leaving the URL set
     would flip every later file onto a dropped database. */
  delete process.env.KLYZ_DATABASE_URL;
}, 60_000);

describe("PgBridge", () => {
  it("answers a query while the main thread is synchronously blocked", () => {
    const started = Date.now();
    const result = pgQuery("SELECT 1 + 1 AS two, current_database() AS db", [], true);
    const elapsed = Date.now() - started;
    expect(result.rows).toEqual([{ two: 2, db: name }]);
    expect(result.rowCount).toBe(1);
    expect(elapsed).toBeLessThan(30_000);
  });

  it("returns int8 and numeric as numbers, not strings", () => {
    const result = pgQuery(
      "SELECT 9007199254740991::int8 AS max_int, 42::numeric AS num, 7::int4 AS i",
      [],
      true,
    );
    expect(result.rows).toEqual([{ max_int: 9007199254740991, num: 42, i: 7 }]);
    for (const value of Object.values(result.rows[0] as Record<string, unknown>)) {
      expect(typeof value).toBe("number");
    }
  });

  it("refuses to round an int8 that is not a safe integer", () => {
    expect(() => pgQuery("SELECT 9007199254740993::int8 AS too_big", [], true)).toThrow(
      /KLYZ_PG_INT8_OVERFLOW/,
    );
  });

  it("reads a fractional numeric as a number, the way SQLite read AVG", () => {
    const result = pgQuery(
      "SELECT AVG(x) AS avg_x FROM (VALUES (100), (151)) AS t(x)",
      [],
      true,
    );
    expect(result.rows).toEqual([{ avg_x: 125.5 }]);
  });

  it("binds positional parameters", () => {
    const result = pgQuery("SELECT $1::text AS a, $2::int AS b", ["x", 5], true);
    expect(result.rows).toEqual([{ a: "x", b: 5 }]);
  });

  it("propagates the driver error message and code", () => {
    let caught: (Error & { code?: string }) | undefined;
    try {
      pgQuery("SELECT * FROM relation_that_does_not_exist", [], true);
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/relation_that_does_not_exist/);
    expect(caught?.code).toBe("42P01");
  });

  it("reports rowCount for writes", () => {
    pgQuery("CREATE TABLE t (id int PRIMARY KEY)", [], false);
    const inserted = pgQuery("INSERT INTO t (id) VALUES ($1), ($2)", [1, 2], false);
    expect(inserted.rowCount).toBe(2);
    const updated = pgQuery("UPDATE t SET id = id + 10", [], false);
    expect(updated.rowCount).toBe(2);
    const noop = pgQuery("UPDATE t SET id = id WHERE id < 0", [], false);
    expect(noop.rowCount).toBe(0);
  });

  it("keeps answering after an error", () => {
    expect(() => pgQuery("SELECT nope", [], true)).toThrow();
    expect(pgQuery("SELECT 3 AS ok", [], true).rows).toEqual([{ ok: 3 }]);
  });

  it("round-trips a large payload inside the buffer", () => {
    const big = "y".repeat(400_000);
    const result = pgQuery("SELECT $1::text AS big", [big], true);
    expect((result.rows[0] as { big: string }).big).toBe(big);
  });

  it("rejects non-scalar column values instead of coercing them", () => {
    expect(() => pgQuery("SELECT now() AS ts", [], true)).toThrow(
      /KLYZ_PG_BRIDGE_NON_SCALAR/,
    );
  });

  it("reports rowCount for a zero-parameter write", () => {
    pgQuery("CREATE TABLE z (id int PRIMARY KEY)", [], false);
    expect(pgQuery("INSERT INTO z VALUES (1), (2)", [], false).rowCount).toBe(2);
    expect(pgQuery("UPDATE z SET id = id", [], false).rowCount).toBe(2);
    expect(pgQuery("UPDATE z SET id = id WHERE id < 0", [], false).rowCount).toBe(0);
    expect(pgQuery("DELETE FROM z", [], false).rowCount).toBe(2);
  });

  it("binds null and unicode text", () => {
    const result = pgQuery("SELECT $1::text AS a, $2::text AS b", ["héllo ✅", null], true);
    expect(result.rows).toEqual([{ a: "héllo ✅", b: null }]);
  });
});
