import { describe, expect, it } from "vitest";
import { countPlaceholders, toPostgres } from "./placeholders";

describe("toPostgres", () => {
  it("numbers plain placeholders", () => {
    expect(toPostgres("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
    expect(countPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(2);
  });

  it("ignores ? inside single-quoted literals", () => {
    expect(toPostgres("SELECT '?' AS q WHERE a = ?")).toBe(
      "SELECT '?' AS q WHERE a = $1",
    );
    expect(toPostgres("SELECT 'it''s ?' WHERE a = ?")).toBe(
      "SELECT 'it''s ?' WHERE a = $1",
    );
    expect(countPlaceholders("SELECT '?'")).toBe(0);
  });

  it("ignores ? inside double-quoted identifiers", () => {
    expect(toPostgres('SELECT "we?ird" FROM t WHERE a = ?')).toBe(
      'SELECT "we?ird" FROM t WHERE a = $1',
    );
  });

  it("ignores ? inside line and block comments", () => {
    expect(toPostgres("SELECT 1 -- what?\nWHERE a = ?")).toBe(
      "SELECT 1 -- what?\nWHERE a = $1",
    );
    expect(toPostgres("SELECT /* huh? */ 1 WHERE a = ?")).toBe(
      "SELECT /* huh? */ 1 WHERE a = $1",
    );
    expect(countPlaceholders("/* ? */ -- ?")).toBe(0);
  });

  it("ignores ? inside dollar-quoted bodies", () => {
    expect(toPostgres("SELECT $body$ ? $body$ WHERE a = ?")).toBe(
      "SELECT $body$ ? $body$ WHERE a = $1",
    );
    expect(toPostgres("SELECT $$ ? $$ WHERE a = ?")).toBe(
      "SELECT $$ ? $$ WHERE a = $1",
    );
    expect(countPlaceholders("SELECT $$ ? $$")).toBe(0);
  });

  it("does not treat $1 as a dollar quote", () => {
    expect(toPostgres("SELECT $1::text")).toBe("SELECT $1::text");
  });

  it("leaves casts alone", () => {
    expect(toPostgres("SELECT v::text WHERE id = ?")).toBe(
      "SELECT v::text WHERE id = $1",
    );
  });

  it("handles an unterminated literal without runaway", () => {
    expect(toPostgres("SELECT 'a?b WHERE x = ?")).toBe(
      "SELECT 'a?b WHERE x = ?",
    );
    expect(countPlaceholders("SELECT 'a?b WHERE x = ?")).toBe(0);
  });

  it("matches the real statements in the codebase", () => {
    expect(
      toPostgres(
        "UPDATE executions SET status = 'running' WHERE id = ? AND status NOT IN ('completed','failed','cancelled')",
      ),
    ).toBe(
      "UPDATE executions SET status = 'running' WHERE id = $1 AND status NOT IN ('completed','failed','cancelled')",
    );
    expect(
      toPostgres(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_default', ?, 'owner', ?) ON CONFLICT DO NOTHING",
      ),
    ).toBe(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_default', $1, 'owner', $2) ON CONFLICT DO NOTHING",
    );
  });
});
