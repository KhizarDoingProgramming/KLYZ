import { Pool } from "pg";
import { httpAllowHosts, httpAllowPrivate } from "@/lib/config/env";
import { performHttpRequest } from "@/lib/integrations/http/request";
import { assertTarget, type UrlPolicy } from "@/lib/integrations/http/ssrf";
import { connectionConfig } from "@/lib/integrations/postgres";
import { HttpError } from "./http";
import { decryptCredentialFields, getCredential } from "./credentials";
import { redactMessage } from "./redact";
import type { Actor } from "./identity";

/**
 * "Test connection" for stored credentials.
 *
 * Runs one real, minimal call — `SELECT 1` for PostgreSQL, a guarded
 * GET for HTTP credentials — and reports the outcome without ever
 * returning secret values. Kinds with no meaningful check say so
 * instead of pretending to work.
 */

export interface CredentialTestResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

const TEST_TIMEOUT_MS = 5_000;
const TEST_MAX_BYTES = 64 * 1024;

export async function testCredential(actor: Actor, id: string): Promise<CredentialTestResult> {
  const credential = getCredential(actor, id);
  const fields = decryptCredentialFields(actor.workspaceId, id);

  if (credential.kind === "postgres") {
    return await testPostgres(fields);
  }
  if (
    credential.kind === "http_basic" ||
    credential.kind === "http_bearer" ||
    credential.kind === "http_header"
  ) {
    return await testHttp(fields);
  }
  throw new HttpError(
    422,
    "TEST_NOT_SUPPORTED",
    `There is no connection test for "${credential.kind}" credentials yet.`,
  );
}

async function testPostgres(fields: Record<string, string>): Promise<CredentialTestResult> {
  const startedAt = Date.now();
  const pool = new Pool({ ...connectionConfig(fields), max: 1 });
  try {
    await pool.query("SELECT 1 AS klyz_ok");
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      detail: `Connected to ${fields.database ?? "the database"} on ${fields.host ?? "the configured host"}.`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      detail: redactMessage(error instanceof Error ? error.message : "Connection failed."),
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function testHttp(fields: Record<string, string>): Promise<CredentialTestResult> {
  const rawUrl = fields.url?.trim();
  if (!rawUrl) {
    throw new HttpError(
      422,
      "NO_TEST_URL",
      'Add a "url" field (e.g. https://api.example.com/health) so the credential has something to call.',
    );
  }
  const policy: UrlPolicy = { allowHosts: httpAllowHosts(), allowPrivate: httpAllowPrivate() };
  const url = assertTarget(rawUrl, policy);
  const headers: Record<string, string> = { accept: "application/json, */*" };
  if (fields.username !== undefined) {
    headers.authorization = `Basic ${Buffer.from(
      `${fields.username}:${fields.password ?? ""}`,
      "utf8",
    ).toString("base64")}`;
  } else if (fields.token) {
    headers.authorization = `Bearer ${fields.token}`;
  } else if (fields.headerName) {
    headers[fields.headerName.toLowerCase()] = fields.value ?? fields.token ?? "";
  }

  const startedAt = Date.now();
  try {
    const response = await performHttpRequest({
      method: "GET",
      url,
      headers,
      timeoutMs: TEST_TIMEOUT_MS,
      maxBytes: TEST_MAX_BYTES,
      policy,
    });
    return {
      ok: response.status < 400,
      latencyMs: Date.now() - startedAt,
      detail:
        response.status < 400
          ? `${url.host} answered ${response.status}.`
          : `${url.host} answered ${response.status} — the credentials may still be valid; check the URL.`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      detail:
        error instanceof Error
          ? `${redactMessage(error.message)}${(error as { detail?: string }).detail ? ` — ${(error as { detail?: string }).detail}` : ""}`
          : "The request failed.",
    };
  }
}
