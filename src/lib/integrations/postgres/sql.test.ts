import { describe, expect, it } from "vitest";
import {
  applyRowLimit,
  assertSafeQuery,
  assertTableName,
  buildInsert,
  buildSelect,
  buildUpdate,
  maxParamIndex,
  paramValues,
} from "./sql";

describe("assertSafeQuery", () => {
  it("accepts a single data statement", () => {
    expect(assertSafeQuery("select * from leads where id = $1")).toBe(
      "select * from leads where id = $1",
    );
    expect(assertSafeQuery("INSERT INTO t (a) VALUES ($1)")).toContain("INSERT INTO t");
    expect(assertSafeQuery("with x as (select 1) select * from x")).toContain("with x as");
    expect(assertSafeQuery("delete from t where id = $1")).toContain("delete from t");
  });

  it("tolerates a trailing semicolon only", () => {
    expect(assertSafeQuery("select 1;")).toBe("select 1");
    expect(assertSafeQuery("select 1;;  ")).toBe("select 1");
  });

  it("rejects stacked statements", () => {
    for (const bad of [
      "select 1; drop table users",
      "select 1 ; delete from t",
      "select ';' as x; select 2",
    ]) {
      expect(() => assertSafeQuery(bad), bad).toThrowError(/one statement/i);
    }
  });

  it("rejects DDL, DCL and utility commands", () => {
    for (const bad of [
      "drop table users",
      "CREATE TABLE evil (id int)",
      "TRUNCATE users",
      "GRANT ALL ON t TO public",
      "COPY users FROM '/tmp/x'",
      "",
      "   ",
    ]) {
      expect(() => assertSafeQuery(bad), bad).toThrowError(/not allowed|empty/i);
    }
  });

  it("raises a stable error code", () => {
    try {
      assertSafeQuery("drop table users");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("POSTGRES_INVALID_QUERY");
    }
  });
});

describe("identifiers", () => {
  it("accepts simple and schema-qualified names", () => {
    expect(assertTableName("leads")).toBe("leads");
    expect(assertTableName("public.leads")).toBe("public.leads");
  });

  it("rejects injection-shaped identifiers", () => {
    for (const bad of ["leads; drop", 'leads"', "1leads", "public.leads.evil", "a-b", ""]) {
      expect(() => assertTableName(bad), bad).toThrowError(/identifier|table name/i);
    }
  });
});

describe("paramValues", () => {
  it("coerces obvious primitives and leaves everything else alone", () => {
    expect(
      paramValues([
        { key: "a", value: "42" },
        { key: "b", value: "true" },
        { key: "c", value: "null" },
        { key: "d", value: "hello" },
        { key: "e", value: "" },
        { key: "f", value: 7 },
        { key: "g", value: null },
        { key: " ", value: "skipped" },
      ]),
    ).toEqual([42, true, null, "hello", "", 7, null]);
  });
});

describe("buildSelect", () => {
  it("builds a star select with no params", () => {
    expect(buildSelect({ table: "leads" })).toEqual({
      sql: "SELECT * FROM leads",
      params: [],
    });
  });

  it("adds columns, where, order and limit as bound params", () => {
    const query = buildSelect({
      table: "public.leads",
      columns: "id, email",
      where: [
        { key: "status", value: "new" },
        { key: "score", value: "10" },
      ],
      orderBy: "created_at desc",
      limit: 25,
    });
    expect(query.sql).toBe(
      "SELECT id, email FROM public.leads WHERE status = $1 AND score = $2 ORDER BY created_at DESC LIMIT $3",
    );
    expect(query.params).toEqual(["new", 10, 25]);
  });

  it("validates order-by direction", () => {
    expect(() => buildSelect({ table: "t", orderBy: "id sideways" })).toThrowError(
      /ASC or DESC/i,
    );
  });
});

describe("buildInsert / buildUpdate", () => {
  it("builds an insert with numbered placeholders", () => {
    const query = buildInsert({
      table: "leads",
      values: [
        { key: "email", value: "a@b.c" },
        { key: "source", value: "webhook" },
      ],
      returning: "id",
    });
    expect(query.sql).toBe("INSERT INTO leads (email, source) VALUES ($1, $2) RETURNING id");
    expect(query.params).toEqual(["a@b.c", "webhook"]);
  });

  it("requires values", () => {
    expect(() => buildInsert({ table: "leads", values: [] })).toThrowError(/at least one/i);
  });

  it("continues param numbering from SET into WHERE", () => {
    const query = buildUpdate({
      table: "leads",
      set: [
        { key: "status", value: "done" },
        { key: "score", value: "3" },
      ],
      where: [{ key: "id", value: "9" }],
    });
    expect(query.sql).toBe("UPDATE leads SET status = $1, score = $2 WHERE id = $3");
    expect(query.params).toEqual(["done", 3, 9]);
  });

  it("refuses an UPDATE without a WHERE clause", () => {
    expect(() => buildUpdate({ table: "leads", set: [{ key: "a", value: 1 }] })).toThrowError(
      /every row/i,
    );
  });
});

describe("applyRowLimit", () => {
  it("wraps a SELECT and numbers the new parameter correctly", () => {
    const limited = applyRowLimit({ sql: "select * from t where a = $1", params: ["x"] }, 50);
    expect(limited.sql).toBe("SELECT * FROM (select * from t where a = $1) AS _klyz_limited LIMIT $2");
    expect(limited.params).toEqual(["x", 50]);
  });

  it("wraps a WITH query using the highest existing index", () => {
    const limited = applyRowLimit({ sql: "with cte as (select 1) select * from cte", params: [] }, 10);
    expect(limited.sql).toContain("LIMIT $1");
    expect(limited.params).toEqual([10]);
  });

  it("leaves non-SELECT statements untouched (sliced by the handler)", () => {
    const query = { sql: "insert into t (a) values ($1) returning *", params: [1] };
    expect(applyRowLimit(query, 10)).toEqual(query);
  });

  it("is a no-op without a limit", () => {
    const query = { sql: "select 1", params: [] };
    expect(applyRowLimit(query, 0)).toEqual(query);
    expect(applyRowLimit(query, undefined)).toEqual(query);
  });

  it("reports the highest placeholder index", () => {
    expect(maxParamIndex("select $1, $2, $12")).toBe(12);
    expect(maxParamIndex("select 1")).toBe(0);
  });
});
