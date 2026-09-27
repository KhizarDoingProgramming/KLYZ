import http from "node:http";
import https from "node:https";
import { CancelledError, type EngineError } from "@/lib/engine/types";
import { redactMessage } from "@/lib/server/redact";
import { HTTP_ERRORS, integrationError } from "../errors";
import { assertTarget, safeLookup, type UrlPolicy } from "./ssrf";

/**
 * One outbound HTTP attempt over node:http — no global `fetch`, because
 * SSRF protection needs control of DNS resolution, redirect handling,
 * response size and timeouts at the socket level.
 */

export interface PerformRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  policy: UrlPolicy;
  signal?: AbortSignal;
}

export interface RequestResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  bytesRead: number;
}

export async function performHttpRequest(request: PerformRequest): Promise<RequestResult> {
  assertTarget(request.url.toString(), request.policy);
  if (request.signal?.aborted) throw new CancelledError();

  const transport = request.url.protocol === "https:" ? https : http;

  return await new Promise<RequestResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let bytesRead = 0;
    const chunks: Buffer[] = [];

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = (): void => {
      settle(() => reject(new CancelledError()));
      outgoing.destroy();
    };

    const outgoing = transport.request(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        lookup: safeLookup(request.policy) as never,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
        }

        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          bytesRead += chunk.length;
          if (bytesRead > request.maxBytes) {
            settle(() =>
              reject(
                integrationError(
                  HTTP_ERRORS.responseTooLarge,
                  "The response was larger than the configured limit.",
                  {
                    detail: `Limit is ${request.maxBytes} bytes; the server kept sending after that.`,
                    hint: "Fetch a smaller payload (paginated or filtered) instead.",
                  },
                ),
              ),
            );
            outgoing.destroy();
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          settle(() =>
            resolve({
              status,
              headers,
              body: Buffer.concat(chunks).toString("utf8"),
              bytesRead,
            }),
          );
        });
        response.on("error", (error) => {
          settle(() => reject(mapRequestError(error, request)));
        });
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      outgoing.destroy(new Error("request timed out"));
    }, request.timeoutMs);

    outgoing.on("error", (error) => {
      settle(() => reject(mapRequestError(error, request, timedOut)));
    });

    request.signal?.addEventListener("abort", onAbort, { once: true });

    if (request.body !== undefined && request.body !== "") {
      outgoing.write(request.body);
    }
    outgoing.end();
  });
}

export function mapRequestError(
  error: unknown,
  request: PerformRequest,
  timedOut = false,
): Error | EngineError {
  if (request.signal?.aborted) return new CancelledError();
  if (isEngineError(error)) return error;
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";

  if (timedOut || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return integrationError(
      HTTP_ERRORS.timeout,
      `The request to ${request.url.hostname} timed out after ${request.timeoutMs}ms.`,
      {
        detail: "The server accepted the connection but did not answer in time.",
        hint: "Raise the node timeout or check whether the host is reachable.",
        retryable: true,
      },
    );
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return integrationError(
      HTTP_ERRORS.dnsFailure,
      `The host ${request.url.hostname} could not be resolved.`,
      { detail: "DNS lookup failed — the hostname may be misspelled or the network is down.", retryable: true },
    );
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" ||
      code === "ENETUNREACH" || code === "EPIPE") {
    return integrationError(
      HTTP_ERRORS.connectionFailed,
      `Could not connect to ${request.url.hostname}.`,
      {
        detail: `${code} — the target refused or dropped the connection.`,
        hint: "Check that the service is running and reachable from this machine.",
        retryable: true,
      },
    );
  }
  return integrationError(
    HTTP_ERRORS.connectionFailed,
    `The request to ${request.url.hostname} failed.`,
    { detail: redactMessage(error instanceof Error ? error.message : "unknown error") },
  );
}

function isEngineError(value: unknown): value is EngineError {
  return (
    value instanceof Error &&
    value.name === "EngineError" &&
    typeof (value as EngineError).code === "string"
  );
}
