/**
 * SQLite `?` → PostgreSQL `$n` placeholder translation.
 *
 * Every statement in the application was written against `node:sqlite`,
 * which takes positional `?` markers. PostgreSQL names them `$1`, `$2`,
 * … so the facade translates once, at prepare time, and caches the
 * result next to the statement.
 *
 * The translation has to be dialect-aware: a `?` inside a string
 * literal, a quoted identifier, a comment or a dollar-quoted block is
 * data, not a marker, and rewriting it would corrupt the statement.
 * The scanner below is deliberately minimal — it recognises exactly
 * those four literal contexts and nothing else — because the SQL in
 * this codebase is machine-generated and never uses operator forms
 * that start with `?`.
 */

/** Number of `?` markers in `sql`, respecting literal contexts. */
export function countPlaceholders(sql: string): number {
  let n = 0;
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const c = sql[i];
    if (c === "'") i = skipQuoted(sql, i, "'");
    else if (c === '"') i = skipQuoted(sql, i, '"');
    else if (c === "-" && sql[i + 1] === "-") {
      while (i < len && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      i = skipBlock(sql, i);
    } else if (c === "$") {
      const tag = dollarTag(sql, i);
      if (tag) i = skipDollar(sql, i, tag);
      else i++;
    } else {
      if (c === "?") n++;
      i++;
    }
  }
  return n;
}

/**
 * Rewrite `sql` so its positional markers are PostgreSQL's.
 *
 * Idempotent on already-translated SQL only in the sense that it never
 * touches `$1` — feeding it a statement that mixes `?` and `$n` would
 * produce two independent parameter series, which PostgreSQL rejects
 * rather than silently mis-binding.
 */
export function toPostgres(sql: string): string {
  let out = "";
  let n = 0;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const c = sql[i];

    if (c === "'" || c === '"') {
      const start = i;
      i = skipQuoted(sql, i, c);
      out += sql.slice(start, i);
      continue;
    }

    if (c === "-" && sql[i + 1] === "-") {
      const start = i;
      while (i < len && sql[i] !== "\n") i++;
      out += sql.slice(start, i);
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      const start = i;
      i = skipBlock(sql, i);
      out += sql.slice(start, i);
      continue;
    }

    if (c === "$") {
      const tag = dollarTag(sql, i);
      if (tag) {
        const start = i;
        i = skipDollar(sql, i, tag);
        out += sql.slice(start, i);
        continue;
      }
      out += c;
      i++;
      continue;
    }

    if (c === "?") {
      n++;
      out += `$${n}`;
      i++;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/** Index just past a quoted run starting at `start` (`''`/`""` doubled). */
function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  const len = sql.length;
  while (i < len) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return len;
}

function skipBlock(sql: string, start: number): number {
  const end = sql.indexOf("*/", start + 2);
  return end === -1 ? sql.length : end + 2;
}

/** `$$`, `$tag$`, or `undefined` when this `$` is not a dollar quote. */
function dollarTag(sql: string, start: number): string | undefined {
  const m = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(start));
  return m?.[0];
}

function skipDollar(sql: string, start: number, tag: string): number {
  const end = sql.indexOf(tag, start + tag.length);
  return end === -1 ? sql.length : end + tag.length;
}
