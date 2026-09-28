import { afterEach, describe, expect, it } from "vitest";

import {
  HEALTH_PATH,
  resolveHealthPort,
  startHealthServer,
  type HealthServer,
} from "./health";

const originalPort = process.env.PORT;
const CANARY = "canary-value-must-never-appear-in-a-response";

let server: HealthServer | null = null;

async function listen(port = "0"): Promise<HealthServer> {
  process.env.PORT = port;
  server = await startHealthServer();
  return server;
}

const base = (target: HealthServer): string => `http://127.0.0.1:${target.port}`;

afterEach(async () => {
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  delete process.env.KLYZ_TEST_CANARY;
  const open = server;
  server = null;
  if (open) await open.close();
});

describe("resolveHealthPort", () => {
  it("falls back to 3000 when PORT is unset or blank", () => {
    expect(resolveHealthPort(undefined)).toBe(3000);
    expect(resolveHealthPort("")).toBe(3000);
    expect(resolveHealthPort("   ")).toBe(3000);
  });

  it("uses PORT when it is a usable TCP port", () => {
    expect(resolveHealthPort("8080")).toBe(8080);
    expect(resolveHealthPort(" 4000 ")).toBe(4000);
    expect(resolveHealthPort("65535")).toBe(65535);
    expect(resolveHealthPort("0")).toBe(0);
  });

  it("falls back when PORT is not a usable TCP port", () => {
    expect(resolveHealthPort("not-a-port")).toBe(3000);
    expect(resolveHealthPort("-1")).toBe(3000);
    expect(resolveHealthPort("65536")).toBe(3000);
    expect(resolveHealthPort("3.5")).toBe(3000);
  });
});

describe("startHealthServer", () => {
  it("answers GET /health with 200 and the fixed payload", async () => {
    const target = await listen();
    const response = await fetch(`${base(target)}${HEALTH_PATH}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok", service: "klyz-worker" });
  });

  it("requires no authentication", async () => {
    const target = await listen();
    const response = await fetch(`${base(target)}${HEALTH_PATH}`, { headers: {} });

    expect(response.status).toBe(200);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("binds 0.0.0.0 so the platform can reach it", async () => {
    const target = await listen();
    expect(target.host).toBe("0.0.0.0");
  });

  it("reports the bound port rather than the requested one", async () => {
    const target = await listen("0");
    expect(target.port).toBeGreaterThan(0);
    expect(target.port).not.toBe(0);
  });

  it("never reflects configuration, credentials or internals", async () => {
    process.env.KLYZ_TEST_CANARY = CANARY;
    const target = await listen();

    const response = await fetch(`${base(target)}${HEALTH_PATH}`);
    const text = await response.text();

    expect(text).not.toContain(CANARY);
    expect(text).not.toMatch(
      /postgres|redis|npg_|password|token|secret|credential|KLYZ_|stack|error/i,
    );
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>).sort()).toEqual([
      "service",
      "status",
    ]);
  });

  it("answers HEAD with headers and no body", async () => {
    const target = await listen();
    const response = await fetch(`${base(target)}${HEALTH_PATH}`, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("ignores a query string on the health path", async () => {
    const target = await listen();
    const response = await fetch(`${base(target)}${HEALTH_PATH}?probe=1`);

    expect(response.status).toBe(200);
  });

  it("404s every other path", async () => {
    const target = await listen();

    for (const path of ["/", "/healthz", "/healthy", "/metrics", "/env"]) {
      const response = await fetch(`${base(target)}${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  it("404s methods other than GET and HEAD on the health path", async () => {
    const target = await listen();

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await fetch(`${base(target)}${HEALTH_PATH}`, { method });
      expect(response.status, method).toBe(404);
    }
  });

  it("does not leak details on a 404", async () => {
    const target = await listen();
    const response = await fetch(`${base(target)}/nope`);
    const text = await response.text();

    expect(response.status).toBe(404);
    expect(JSON.parse(text) as Record<string, unknown>).toEqual({ error: "not found" });
  });

  it("closes the listener so the socket stops answering", async () => {
    const target = await listen();
    await target.close();

    await expect(fetch(`${base(target)}${HEALTH_PATH}`)).rejects.toThrow();
  });

  it("is safe to close twice", async () => {
    const target = await listen();
    await target.close();
    await expect(target.close()).resolves.toBeUndefined();
  });
});
