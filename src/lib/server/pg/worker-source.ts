/**
 * Source of the PostgreSQL bridge worker, as a string.
 *
 * The worker is started with `new Worker(source, { eval: true })` rather
 * than a path to a module file, so the same code runs under `tsx`, inside
 * a Next.js server bundle and inside the Deplexo image without any of
 * them having to emit, trace or transpile an extra entry point. The
 * source is plain ESM: an eval'd worker inherits the parent's module
 * type, and every runtime this application ships on is ESM.
 *
 * `pg` is resolved from the worker's own `createRequire` base rather
 * than imported statically, so bundlers leave the real package on disk
 * alone — `require.resolve` inside a bundle would hand back a chunk
 * path that does not exist at runtime.
 */

export const PG_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");

const STATE_BOOT = 0;
const STATE_ONLINE = 1;
const STATE_REQUEST = 2;
const STATE_OK = 3;
const STATE_ERROR = 4;

/*
 * Two slots, because "Atomics.wait" blocks *while* a slot holds the
 * expected value — it cannot say "wait until". The main thread parks on
 * STATE waiting for the worker to overwrite it, and the worker parks on
 * REQUEST_READY waiting for the main thread to set it. One slot would
 * have to serve both directions and would let the worker fall straight
 * through its own wait the instant the handshake completed.
 */
const REQUEST_READY = 4;

const header = new Int32Array(workerData.sab, 0, workerData.headerSlots);
const BODY_BYTES = workerData.headerSlots * 4;
const body = new Uint8Array(workerData.sab, BODY_BYTES);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const port = parentPort;
const notify = () => Atomics.notify(header, 0);

function fail(message, code) {
  const payload = encoder.encode(JSON.stringify({ message, code: code || "" }));
  if (payload.length > body.length) {
    /* Never leave the caller blocked on an unencodable error. */
    const clipped = encoder.encode(
      JSON.stringify({
        message: "error message too large for bridge buffer: " + message,
        code: "KLYZ_BRIDGE_BUFFER",
      }),
    );
    body.set(clipped);
    header[2] = clipped.length;
  } else {
    body.set(payload);
    header[2] = payload.length;
  }
  header[3] = 0;
  Atomics.store(header, 0, STATE_ERROR);
  notify();
}

function writeOk(text, rowCount) {
  const payload = encoder.encode(text);
  if (payload.length > body.length) {
    fail(
      "KLYZ_PG_BRIDGE_OVERFLOW: result needs " +
        payload.length +
        " bytes, bridge buffer is " +
        body.length +
        ". Raise KLYZ_PG_BRIDGE_BUFFER_MB.",
      "KLYZ_PG_BRIDGE_OVERFLOW",
    );
    return;
  }
  body.set(payload);
  header[2] = payload.length;
  header[3] = rowCount;
  Atomics.store(header, 0, STATE_OK);
  notify();
}

/**
 * Row values are marshalled as JSON, so anything that is not a JSON
 * scalar would be silently coerced (a Date becomes an ISO string, a
 * Buffer becomes {}). The schema has no columns of those types; if one
 * is ever added this throws instead of corrupting a write.
 */
function encodeRows(rows) {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const value = row[key];
      const t = typeof value;
      if (value !== null && t !== "string" && t !== "number" && t !== "boolean") {
        throw new Error(
          "KLYZ_PG_BRIDGE_NON_SCALAR: column " +
            key +
            " has type " +
            (value && value.constructor ? value.constructor.name : t) +
            "; the bridge only marshals JSON scalars",
        );
      }
    }
  }
  return JSON.stringify(rows);
}

let pool;
try {
  const require_ = createRequire(workerData.requireBase);
  const pg = workerData.pgPath ? require_(workerData.pgPath) : require_("pg");

  /* node-postgres hands back int8 as a string so it cannot lose precision.
     Every INTEGER column in this schema is an epoch-ms timestamp or a
     count that the application compares with ===, so they must come back
     as numbers. Anything past 2^53 is a bug, not a rounding opportunity,
     so it throws instead. */
  const asInt = (oidName) => (value) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(
        "KLYZ_PG_INT8_OVERFLOW: " + oidName + " value " + value + " is not a safe integer",
      );
    }
    return parsed;
  };
  pg.types.setTypeParser(20, asInt("int8"));

  /* numeric is where the aggregates land — AVG over an INTEGER column is
     fractional — and SQLite returned those as REAL. Reading it as a plain
     number keeps the two dialects agreeing on the shape of a value; only
     money would care about the lost digits, and there is no money here. */
  pg.types.setTypeParser(1700, Number);

  pool = new pg.Pool({
    connectionString: workerData.url,
    max: workerData.poolMax,
    application_name: workerData.applicationName,
    ...(workerData.statementTimeout
      ? { statement_timeout: workerData.statementTimeout }
      : {}),
    ...(workerData.connectionTimeout
      ? { connectionTimeoutMillis: workerData.connectionTimeout }
      : {}),
  });
  /* A pool-level error (server restart, network blip) must not take the
     worker thread down: the next query re-establishes a connection. */
  pool.on("error", () => {});

  Atomics.store(header, 0, STATE_ONLINE);
  Atomics.notify(header, 0);
} catch (error) {
  fail(error && error.message ? error.message : String(error), error && error.code);
}

(async function() {
  while (true) {
    Atomics.wait(header, REQUEST_READY, 0);
    Atomics.store(header, REQUEST_READY, 0);

    const requestLength = header[1];
    let request;
    try {
      request = JSON.parse(decoder.decode(body.subarray(0, requestLength)));
    } catch (error) {
      fail("undecodable bridge request: " + error.message, "KLYZ_BRIDGE_PROTOCOL");
      continue;
    }

    try {
      /* No bind parameters means the simple query protocol, which is the
         only shape PostgreSQL accepts a multi-statement string in — that
         is how a whole migration is applied as one implicit transaction. */
      const result =
        request.params && request.params.length
          ? await pool.query(request.sql, request.params)
          : await pool.query(request.sql);
      if (request.wantRows) {
        writeOk(encodeRows(result.rows), result.rowCount || 0);
      } else {
        writeOk("[]", result.rowCount || 0);
      }
    } catch (error) {
      fail(
        error && error.message ? error.message : String(error),
        error && error.code,
      );
    }
  }
})();
`;

export const PG_HEADER_SLOTS = 8;
export const PG_HEADER_BYTES = PG_HEADER_SLOTS * 4;
