import Redis from "ioredis";
import { queueDriver, redisUrl } from "@/lib/config/env";

/**
 * Redis connectivity.
 *
 * One publisher connection (commands, pub) is shared process-wide; a
 * separate connection exists for pattern subscriptions, because a
 * client in subscriber mode may only run subscribe-family commands.
 * Connections are lazy — a process that never touches the queue never
 * opens a socket — and every client carries an error handler so an
 * unreachable Redis degrades the app instead of crashing it.
 */

/**
 * Deliberately narrow option shape: compatible with both ioredis and
 * BullMQ's `ConnectionOptions` union (ioredis's own `RedisOptions`
 * carries a `retryStrategy` union that BullMQ rejects structurally).
 */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
  enableOfflineQueue?: boolean;
  maxRetriesPerRequest?: number | null;
  retryStrategy?: (times: number) => number | null;
}

export interface ParsedRedisOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
}

export function parseRedisUrl(raw: string): ParsedRedisOptions {
  const url = new URL(raw);
  const options: ParsedRedisOptions = {
    host: url.hostname || "127.0.0.1",
    port: url.port ? Number(url.port) : 6379,
  };
  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  const db = url.pathname.replace(/^\//, "");
  if (db) {
    const parsed = Number(db);
    if (!Number.isInteger(parsed)) {
      throw new Error(`Redis URL has a non-integer database index: "${db}"`);
    }
    options.db = parsed;
  }
  if (url.protocol === "rediss:") options.tls = {};
  return options;
}

/** Connection options for a fast-failing client (no silent buffering). */
export function redisOptions(raw: string): RedisConnectionOptions {
  const parsed = parseRedisUrl(raw);
  return {
    ...parsed,
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  };
}

interface RedisClients {
  pub: Redis | null;
  sub: Redis | null;
  failed: boolean;
}

function state(): RedisClients {
  const global = globalThis as typeof globalThis & { __klyzRedis?: RedisClients };
  if (!global.__klyzRedis) global.__klyzRedis = { pub: null, sub: null, failed: false };
  return global.__klyzRedis;
}

function isRedisDriver(): boolean {
  try {
    return queueDriver() === "redis";
  } catch {
    return false;
  }
}

/**
 * Shared publisher connection, or `null` when the queue is not on
 * Redis (unit tests) or Redis has been marked unavailable.
 */
export function tryRedis(): Redis | null {
  if (!isRedisDriver()) return null;
  const clients = state();
  if (clients.failed) return null;
  if (!clients.pub) {
    try {
      const client = new Redis({
        ...redisOptions(redisUrl()),
        enableOfflineQueue: true,
        lazyConnect: false,
      });
      client.on("error", () => {
        /* reported through status checks; never let this throw */
      });
      client.on("end", () => {
        state().failed = false; /* allow reconnect attempts to be retried */
      });
      clients.pub = client;
    } catch {
      clients.failed = true;
      return null;
    }
  }
  return clients.pub;
}

/** A second connection for pub/sub subscriptions (subscriber mode). */
export function trySubscriber(): Redis | null {
  if (!isRedisDriver()) return null;
  const clients = state();
  if (clients.failed) return null;
  if (!clients.sub) {
    try {
      const client = new Redis({
        ...redisOptions(redisUrl()),
        enableOfflineQueue: true,
      });
      client.on("error", () => {
        /* swallow — the relay reports health through status */
      });
      clients.sub = client;
    } catch {
      clients.failed = true;
      return null;
    }
  }
  return clients.sub;
}

export function closeRedis(): void {
  const clients = state();
  clients.pub?.disconnect();
  clients.sub?.disconnect();
  clients.pub = null;
  clients.sub = null;
}
