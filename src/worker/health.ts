import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Liveness endpoint for the container platform.
 *
 * The worker consumes BullMQ jobs and serves no HTTP of its own, but a
 * container orchestrator needs a socket to probe before it will call the
 * process healthy. This is that probe and nothing more: one path, a fixed
 * two-field body, no authentication, and no route that can reach
 * configuration, job data, the database or an internal error.
 */

/** The only path this server answers. */
export const HEALTH_PATH = "/health";

/** Body of a healthy response. Static by design — never derived from env. */
const HEALTH_BODY = JSON.stringify({ status: "ok", service: "klyz-worker" });

const NOT_FOUND_BODY = JSON.stringify({ error: "not found" });

/** Used when `PORT` is unset, empty or not a usable TCP port. */
const DEFAULT_PORT = 3000;

/**
 * Port to bind: `PORT` when it is a valid TCP port, otherwise 3000.
 *
 * `0` is accepted as given — an ephemeral port, which is what tests ask
 * for. Anything unparsable falls back rather than crashing the worker.
 */
export function resolveHealthPort(raw: string | undefined = process.env.PORT): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_PORT;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) return DEFAULT_PORT;
  return value;
}

export interface HealthServer {
  /** Port actually bound — differs from the request when `PORT=0`. */
  readonly port: number;
  /** Interface the socket is bound to. */
  readonly host: string;
  /** Stops accepting connections and tears the socket down. */
  close(): Promise<void>;
}

/**
 * Bind the health server to `0.0.0.0` on `PORT` (default 3000).
 *
 * Rejects if the port cannot be bound: a worker that is running but
 * unprobeable is worse than one that failed loudly at startup.
 */
export async function startHealthServer(): Promise<HealthServer> {
  const port = resolveHealthPort();

  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const healthy = (method === "GET" || method === "HEAD") && path === HEALTH_PATH;
    const body = healthy ? HEALTH_BODY : NOT_FOUND_BODY;

    response.writeHead(healthy ? 200 : 404, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    /* HEAD carries headers only, so the body must not be written. */
    response.end(method === "HEAD" ? undefined : body);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      rejectListen(
        new Error(
          `health server could not bind 0.0.0.0:${port} — ${error.message}. ` +
            `Set PORT to a free port.`,
        ),
      );
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "0.0.0.0");
  });

  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    host: address.address,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        if (!server.listening) {
          resolveClose();
          return;
        }
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
        /* Health probes hold keep-alive sockets open; without this the
           close callback would wait for the platform's idle timeout. */
        server.closeAllConnections();
      }),
  };
}
