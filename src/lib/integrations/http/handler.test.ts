import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NodeRunContext } from "@/lib/engine/types";
import type { Workflow } from "@/lib/workflow/types";
import { httpHandler } from "./handler";

/**
 * HTTP handler tests against a real loopback server. The node policy is
 * opened up for `127.0.0.1` explicitly (KLYZ_HTTP_ALLOW_PRIVATE), which
 * is the same switch a local integration setup has to flip.
 */

const ORIGINAL_ENV = { ...process.env };
let server: Server;
let port: number;
let last: { method: string; url: string; headers: Record<string, unknown>; body: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      last = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, unknown>,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      switch (path) {
        case "/json":
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ hello: "world", n: 2 }));
          return;
        case "/echo":
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              method: last.method,
              url: last.url,
              body: last.body,
              authorization: last.headers.authorization ?? null,
              apiKey: last.headers["x-api-key"] ?? null,
            }),
          );
          return;
        case "/text":
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("plain body");
          return;
        case "/redirect":
          res.writeHead(302, { location: "/json" });
          res.end();
          return;
        case "/redirect-private":
          res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
          res.end();
          return;
        case "/missing":
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "nope" }));
          return;
        case "/boom":
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("server exploded");
          return;
        case "/slow":
          /* never answers — the node's timeout has to fire */
          return;
        case "/big":
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("x".repeat(8 * 1024));
          return;
        default:
          res.writeHead(404);
          res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  process.env.KLYZ_HTTP_ALLOW_PRIVATE = "1";
  delete process.env.KLYZ_HTTP_ALLOW_HOSTS;
  delete process.env.KLYZ_HTTP_MAX_RESPONSE_BYTES;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function makeContext(config: Record<string, unknown>): NodeRunContext {
  return {
    executionId: "ex_http_test",
    workspaceId: "ws_test",
    workflow: { id: "wf_http_test", name: "HTTP test" } as unknown as Workflow,
    nodeId: "n_http",
    nodeType: "action.http",
    config,
    rawConfig: config,
    scope: { trigger: { payload: {} } },
    triggerInput: null,
    attempt: 1,
    signal: new AbortController().signal,
    publishStatus: () => undefined,
  };
}

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

async function run(config: Record<string, unknown>) {
  return (await httpHandler(makeContext(config))) as {
    output: Record<string, unknown>;
  };
}

describe("action.http handler", () => {
  it("performs a GET and exposes status, parsed body and timing", async () => {
    const { output } = await run({ method: "GET", url: url("/json") });
    expect(output.status).toBe(200);
    expect(output.ok).toBe(true);
    expect(output.body).toEqual({ hello: "world", n: 2 });
    expect(output.method).toBe("GET");
    expect(Number(output.durationMs)).toBeGreaterThanOrEqual(0);
    expect(output.redirects).toBe(0);
  });

  it("sends method, query, headers and body, and reads the response", async () => {
    const { output } = await run({
      method: "POST",
      url: url("/echo"),
      query: { page: "2", q: "hello world" },
      headers: [{ key: "X-Custom", value: "yes" }],
      body: '{"name":"klyz"}',
    });
    expect(output.status).toBe(200);
    const echoed = output.body as Record<string, unknown>;
    expect(echoed.method).toBe("POST");
    expect(String(echoed.url)).toContain("page=2");
    expect(String(echoed.url)).toContain("q=hello+world");
    expect(echoed.body).toBe('{"name":"klyz"}');
    expect(last.headers["x-custom"]).toBe("yes");
    expect(last.headers["content-type"]).toBe("application/json");
  });

  it("adds bearer and basic auth headers from inline config", async () => {
    const bearer = await run({ method: "POST", url: url("/echo"), auth: "bearer", token: "tok_123" });
    expect((bearer.output.body as Record<string, unknown>).authorization).toBe("Bearer tok_123");

    const basic = await run({
      method: "POST",
      url: url("/echo"),
      auth: "basic",
      username: "alice",
      password: "s3cret",
    });
    expect((basic.output.body as Record<string, unknown>).authorization).toBe(
      `Basic ${Buffer.from("alice:s3cret").toString("base64")}`,
    );
  });

  it("sends a JSON body with bare expressions as typed JSON", async () => {
    const context: NodeRunContext = {
      ...makeContext({
        method: "POST",
        url: url("/echo"),
        /* what the outer config pass leaves behind after text interpolation */
        body: '{"event": order.created, "n": 7}',
      }),
      rawConfig: {
        method: "POST",
        url: url("/echo"),
        body: '{"event": {{trigger.payload.event}}, "n": {{trigger.payload.n}}}',
      },
      scope: { trigger: { payload: { event: "order.created", n: 7 } } },
    };
    const { output } = (await httpHandler(context)) as { output: Record<string, unknown> };
    const echoed = output.body as Record<string, unknown>;
    expect(JSON.parse(String(echoed.body))).toEqual({ event: "order.created", n: 7 });
  });

  it("fails with HTTP_STATUS on a 4xx (retryable: false)", async () => {
    await expect(run({ method: "GET", url: url("/missing") })).rejects.toMatchObject({
      code: "HTTP_STATUS",
      retryable: false,
      httpStatus: 404,
    });
  });

  it("returns ok:false instead of throwing when allowFailure is on", async () => {
    const { output } = await run({ method: "GET", url: url("/missing"), allowFailure: true });
    expect(output.status).toBe(404);
    expect(output.ok).toBe(false);
    expect(output.body).toEqual({ error: "nope" });
  });

  it("marks 5xx as retryable so the engine retries the step", async () => {
    await expect(run({ method: "GET", url: url("/boom") })).rejects.toMatchObject({
      code: "HTTP_STATUS",
      retryable: true,
      httpStatus: 500,
    });
  });

  it("follows redirects and reports the final URL", async () => {
    const { output } = await run({ method: "GET", url: url("/redirect") });
    expect(output.status).toBe(200);
    expect(output.redirects).toBe(1);
    expect(String(output.url)).toMatch(/\/json$/);
  });

  it("blocks a redirect hop to a host outside the allowlist", async () => {
    process.env.KLYZ_HTTP_ALLOW_HOSTS = `127.0.0.1:${port}`;
    await expect(run({ method: "GET", url: url("/redirect-private") })).rejects.toMatchObject({
      code: "HTTP_BLOCKED_TARGET",
    });
  });

  it("times out against a silent server and marks it retryable", async () => {
    await expect(
      run({ method: "GET", url: url("/slow"), timeout: 300 }),
    ).rejects.toMatchObject({ code: "HTTP_TIMEOUT", retryable: true });
  }, 15_000);

  it("refuses to buffer an oversized response", async () => {
    process.env.KLYZ_HTTP_MAX_RESPONSE_BYTES = "1024";
    await expect(run({ method: "GET", url: url("/big") })).rejects.toMatchObject({
      code: "HTTP_RESPONSE_TOO_LARGE",
    });
  });

  it("rejects malformed URLs", async () => {
    await expect(run({ method: "GET", url: "nope" })).rejects.toMatchObject({
      code: "HTTP_URL_INVALID",
    });
    await expect(run({ method: "GET", url: "ftp://example.com/x" })).rejects.toMatchObject({
      code: "HTTP_URL_INVALID",
    });
  });

  it("blocks loopback targets when private addresses are not allowed", async () => {
    process.env.KLYZ_HTTP_ALLOW_PRIVATE = "0";
    await expect(run({ method: "GET", url: url("/json") })).rejects.toMatchObject({
      code: "HTTP_BLOCKED_TARGET",
    });
  });
});
