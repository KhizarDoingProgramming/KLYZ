import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

import { PG_HEADER_BYTES, PG_HEADER_SLOTS, PG_WORKER_SOURCE } from "./worker-source";

/**
 * Synchronous PostgreSQL client.
 *
 * The application's data layer is synchronous: 140 call sites sit inside
 * 171 functions that are themselves synchronous, and none of them are
 * async today. Turning the whole stack async to reach `pg`'s promise API
 * is a change with no behavioural payoff, so instead the blocking is
 * moved into a worker thread that owns the connection pool, and the main
 * thread waits on it with `Atomics.wait`.
 *
 * The two sides share one SharedArrayBuffer. The main thread writes the
 * request into the body region, publishes the request state, and blocks;
 * the worker wakes, runs the query on its own event loop, writes the
 * JSON response back into the same region and flips the state. `Atomics`
 * operations are synchronous and do not need the main event loop, so the
 * worker can boot and answer while the main thread is parked.
 *
 * There is exactly one outstanding request at a time — which is exactly
 * what a synchronous caller can have — so the protocol needs no
 * correlation ids and no queue.
 */

const STATE_BOOT = 0;
const STATE_REQUEST = 2;
const STATE_ERROR = 4;
const REQUEST_READY = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Absolute path of the `pg` package, when it can be located from here.
 *
 * A bundler rewrites `import.meta.url` to a virtual id, under which
 * `createRequire(...).resolve("pg")` hands back that id — Turbopack's
 * `[externals]/pg [external] (...)` — rather than throwing, so the
 * `catch` never runs and a non-path string reaches the worker. Resolve
 * from the real filesystem first (the same base as the worker's
 * `requireBase`) and accept only an on-disk absolute path; anything
 * else yields `null`, which makes the worker fall back to its own
 * `createRequire(requireBase)("pg")`.
 */
function resolvePgPath(): string | null {
  const bases: string[] = [join(process.cwd(), "__klyz_pg_bridge__.js"), import.meta.url];
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve("pg");
      if (isAbsolute(resolved)) return resolved;
    } catch {
      // fall through to the next base
    }
  }
  return null;
}

export interface PgResult {
  rows: unknown[];
  rowCount: number;
}

class PgBridge {
  private worker: Worker | null = null;
  private header: Int32Array | null = null;
  private body: Uint8Array | null = null;
  private online = false;
  private failure: string | null = null;
  private pgPath: string | null = null;
  /** Bumped whenever a worker is replaced, so a stale exit event from
      the previous one cannot mark the replacement as broken. */
  private generation = 0;

  /**
   * Block until the worker is answering, spawning it if this is the
   * first call. Safe to call while the worker is mid-boot: `Atomics.wait`
   * returns immediately when the state already moved on.
   */
  private ensureOnline(): void {
    if (this.online) return;
    if (this.failure) throw new Error(this.failure);

    if (!this.worker) {
      const bufferBytes = intEnv("KLYZ_PG_BRIDGE_BUFFER_MB", 16) * 1024 * 1024;
      const sab = new SharedArrayBuffer(bufferBytes);
      const header = new Int32Array(sab, 0, PG_HEADER_SLOTS);
      const body = new Uint8Array(sab, PG_HEADER_BYTES);
      const url = process.env.KLYZ_DATABASE_URL;
      if (!url) {
        this.failure =
          "KLYZ_DATABASE_URL is not set. The application database is PostgreSQL; " +
          "set KLYZ_DATABASE_URL, or set KLYZ_DB_DRIVER=sqlite to fall back to the legacy store.";
        throw new Error(this.failure);
      }

      const generation = ++this.generation;
      this.pgPath ??= resolvePgPath();
      this.header = header;
      this.body = body;

      let worker: Worker;
      try {
        worker = new Worker(PG_WORKER_SOURCE, {
          eval: true,
          workerData: {
            sab,
            headerSlots: PG_HEADER_SLOTS,
            url,
            pgPath: this.pgPath,
            /* createRequire needs a real filename; any path under cwd
               gives Node the project root as the resolution base. */
            requireBase: `${process.cwd()}/__klyz_pg_bridge__.js`,
            poolMax: intEnv("KLYZ_PG_POOL_MAX", 1),
            statementTimeout: intEnv("KLYZ_PG_STATEMENT_TIMEOUT_MS", 0),
            connectionTimeout: intEnv("KLYZ_PG_CONNECT_TIMEOUT_MS", 10_000),
            applicationName: process.env.KLYZ_PG_APPLICATION_NAME || "klyz",
          },
        });
      } catch (error) {
        this.failure = `KLYZ_PG_BRIDGE_START_FAILED: ${(error as Error).message}`;
        throw new Error(this.failure);
      }

      /* The worker is not allowed to hold the process open on its own;
         the main thread blocks explicitly whenever it needs it. */
      worker.unref();
      worker.on("error", (error) => {
        if (generation !== this.generation) return;
        this.failure = `KLYZ_PG_BRIDGE_WORKER_ERROR: ${error.message}`;
        this.online = false;
      });
      worker.on("exit", (code) => {
        if (generation !== this.generation) return;
        this.online = false;
        if (!this.failure) {
          this.failure = `KLYZ_PG_BRIDGE_WORKER_EXIT: worker exited with code ${code}`;
        }
      });
      this.worker = worker;
    }

    const waited = Atomics.wait(this.header as Int32Array, 0, STATE_BOOT, 30_000);
    const state = Atomics.load(this.header as Int32Array, 0);

    if (state === STATE_BOOT) {
      this.failure =
        waited === "timed-out"
          ? "KLYZ_PG_BRIDGE_BOOT_TIMEOUT: worker did not come online in 30s"
          : "KLYZ_PG_BRIDGE_BOOT_FAILED: worker stopped before coming online";
      throw new Error(this.failure);
    }
    if (state === STATE_ERROR) {
      const message = this.readError();
      this.failure = `KLYZ_PG_BRIDGE_BOOT_FAILED: ${message}`;
      throw new Error(this.failure);
    }
    this.online = true;
  }

  /**
   * Recover from a timed-out or crashed worker by starting a new one.
   *
   * Also used to hand the pool over to a different connection URL — see
   * {@link resetPgBridge} — because a worker's URL is fixed for life.
   */
  reset(): void {
    const previous = this.worker;
    this.generation++;
    this.worker = null;
    this.header = null;
    this.body = null;
    this.online = false;
    this.failure = null;
    if (previous) void previous.terminate();
  }

  private readError(): string {
    const length = Atomics.load(this.header as Int32Array, 2);
    const text = decoder.decode((this.body as Uint8Array).subarray(0, length));
    try {
      const parsed = JSON.parse(text) as { message?: string; code?: string };
      const message = parsed.message || text;
      return parsed.code ? `${message} (${parsed.code})` : message;
    } catch {
      return text || "unknown bridge error";
    }
  }

  /**
   * Run one statement and block until PostgreSQL answers.
   *
   * `wantRows = false` skips serialising the result — every caller that
   * only needs `rowCount` would otherwise pay for an array it throws
   * away.
   */
  query(sql: string, params: readonly unknown[], wantRows: boolean): PgResult {
    this.ensureOnline();

    const header = this.header as Int32Array;
    const body = this.body as Uint8Array;
    const request = encoder.encode(JSON.stringify({ sql, params, wantRows }));
    if (request.length > body.length) {
      throw new Error(
        `KLYZ_PG_BRIDGE_REQUEST_TOO_LARGE: ${request.length} bytes exceeds the ${body.length} byte bridge buffer`,
      );
    }
    body.set(request);
    Atomics.store(header, 1, request.length);
    /* Publish the request on both slots: STATE is what this thread parks
       on, REQUEST_READY is what the worker parks on. */
    Atomics.store(header, 0, STATE_REQUEST);
    Atomics.store(header, REQUEST_READY, 1);
    Atomics.notify(header, REQUEST_READY);

    const timeoutMs = intEnv("KLYZ_PG_QUERY_TIMEOUT_MS", 120_000);
    const waited = Atomics.wait(header, 0, STATE_REQUEST, timeoutMs);
    const state = Atomics.load(header, 0);

    if (state === STATE_REQUEST) {
      /* The worker is still busy. Parked state can no longer be trusted,
         so the next call rebuilds the worker rather than interleaving. */
      this.reset();
      throw new Error(
        `KLYZ_PG_BRIDGE_TIMEOUT: no answer within ${timeoutMs}ms (KLYZ_PG_QUERY_TIMEOUT_MS)`,
      );
    }

    const rowCount = Atomics.load(header, 3);
    if (state === STATE_ERROR) {
      const message = this.readError();
      if (waited !== "not-equal") this.reset();
      const error = new Error(message) as Error & { code?: string };
      const match = /\((\w+)\)$/.exec(message);
      if (match) error.code = match[1];
      throw error;
    }

    const length = Atomics.load(header, 2);
    const text = decoder.decode(body.subarray(0, length));
    const rows = text ? (JSON.parse(text) as unknown[]) : [];
    return { rows, rowCount };
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.generation++;
    this.worker = null;
    this.header = null;
    this.body = null;
    this.online = false;
    if (worker) await worker.terminate();
  }
}

const bridge = new PgBridge();

export function pgQuery(sql: string, params: readonly unknown[], wantRows: boolean): PgResult {
  return bridge.query(sql, params, wantRows);
}

/**
 * Drop the live worker without waiting for it to die.
 *
 * The worker is bound to one connection URL for its whole life, so a
 * caller that has to talk to a *different* database — the test harness
 * creating its own database through the admin URL — detaches the pool
 * first and lets the next query spawn against the new URL. Termination
 * is fire-and-forget on purpose: the worker is unref'd, generation
 * tagging already ignores its exit event, and nothing this thread does
 * next depends on it having finished.
 */
export function resetPgBridge(): void {
  bridge.reset();
}

export function disposePgBridge(): Promise<void> {
  return bridge.dispose();
}
