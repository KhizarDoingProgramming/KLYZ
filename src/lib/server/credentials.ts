import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { credentialKey, nodeEnv, ConfigError } from "@/lib/config/env";
import { now, queryAll, queryOne, run as sqlRun } from "./db";
import { HttpError } from "./http";
import { redactMessage } from "./redact";
import type { Actor } from "./identity";
import type { CredentialKind } from "@/lib/workflow/types";

/**
 * Stored credentials — encrypted at rest, decrypted only inside the
 * worker (and by "test connection").
 *
 * The API surface only ever returns `id`, `name`, `kind` and timestamps;
 * decrypted fields live in memory for the duration of one node run. In
 * development a key file is generated under `.klyz/`; in production
 * `KLYZ_CREDENTIAL_KEY` is mandatory — no silent fallback.
 */

const KEY_FILE = join(".klyz", "credentials.key");

export interface CredentialView {
  id: string;
  name: string;
  kind: CredentialKind;
  createdAt: string;
  updatedAt: string;
  /** Connection lifecycle; `connected` for manually stored secrets. */
  status: string;
  /** Account label for OAuth connections (login/email) — never a token. */
  account: string | null;
  /** Granted scopes for OAuth connections. */
  scopes: string[];
  /** Access-token expiry for OAuth connections. */
  expiresAt: string | null;
  /** Last connection-level failure, redacted. */
  lastError: string | null;
}

interface CredentialRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  secret_enc: string;
  status: string;
  account: string | null;
  scopes: string | null;
  expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const KINDS = new Set<string>([
  "gmail",
  "github",
  "slack",
  "notion",
  "google_sheets",
  "postgres",
  "http_basic",
  "http_bearer",
  "http_header",
]);

/* ------------------------------------------------------------------ */
/* Key management                                                      */
/* ------------------------------------------------------------------ */

let cachedKey: Buffer | null = null;

export function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = credentialKey();
  if (fromEnv) {
    cachedKey = fromEnv;
    return cachedKey;
  }
  if (nodeEnv() === "production") {
    throw new ConfigError([
      "KLYZ_CREDENTIAL_KEY is required in production — credential encryption must not rely on a generated key",
    ]);
  }
  const path = join(process.cwd(), KEY_FILE);
  if (existsSync(path)) {
    const hex = readFileSync(path, "utf8").trim();
    const key = Buffer.from(hex, "hex");
    if (key.length !== 32) {
      throw new ConfigError([`${KEY_FILE} does not contain a 32-byte key`]);
    }
    cachedKey = key;
    return cachedKey;
  }
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key.toString("hex"), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  cachedKey = key;
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Credential payload is not in a recognised format.");
  }
  const [, ivRaw, tagRaw, ctRaw] = parts;
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw!, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw!, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctRaw!, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/* ------------------------------------------------------------------ */
/* CRUD (API side)                                                     */
/* ------------------------------------------------------------------ */

function toView(row: CredentialRow): CredentialView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as CredentialKind,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    status: row.status || "connected",
    account: row.account,
    scopes: (row.scopes ?? "")
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    lastError: row.last_error,
  };
}

export function listCredentials(actor: Actor): CredentialView[] {
  return queryAll<CredentialRow>(
    "SELECT * FROM credentials WHERE workspace_id = ? ORDER BY LOWER(name)",
    actor.workspaceId,
  ).map(toView);
}

export function getCredential(actor: Actor, id: string): CredentialView {
  const row = ownedRow(actor, id);
  return toView(row);
}

export interface CredentialInput {
  name: string;
  kind: string;
  fields: Record<string, string>;
}

export function createCredential(actor: Actor, input: CredentialInput): CredentialView {
  validate(input);
  const id = `cred_${randomBytes(8).toString("hex")}`;
  const timestamp = now();
  sqlRun(
    `INSERT INTO credentials (id, workspace_id, name, kind, secret_enc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    actor.workspaceId,
    input.name.trim(),
    input.kind,
    encryptSecret(JSON.stringify(input.fields)),
    timestamp,
    timestamp,
  );
  return getCredential(actor, id);
}

export function updateCredential(
  actor: Actor,
  id: string,
  input: Partial<CredentialInput>,
): CredentialView {
  const row = ownedRow(actor, id);
  const name = input.name?.trim() || row.name;
  const kind = input.kind || row.kind;
  const fields = input.fields ?? null;
  if (fields) validate({ name, kind, fields });

  sqlRun(
    "UPDATE credentials SET name = ?, kind = ?, secret_enc = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
    name,
    kind,
    fields ? encryptSecret(JSON.stringify(fields)) : row.secret_enc,
    now(),
    id,
    actor.workspaceId,
  );
  return getCredential(actor, id);
}

export function deleteCredential(actor: Actor, id: string): void {
  ownedRow(actor, id);
  sqlRun("DELETE FROM credentials WHERE id = ? AND workspace_id = ?", id, actor.workspaceId);
}

function ownedRow(actor: Actor, id: string): CredentialRow {
  const row = queryOne<CredentialRow>(
    "SELECT * FROM credentials WHERE id = ? AND workspace_id = ?",
    id,
    actor.workspaceId,
  );
  if (!row) {
    throw new HttpError(404, "NOT_FOUND", "That credential does not exist.");
  }
  return row;
}

/**
 * Credential kinds that only the OAuth flow may write.
 *
 * Provider tokens arrive from a verified callback with scopes the user
 * saw; letting the generic API accept them by hand would create a
 * second, unaudited path for provider secrets (and a way to attach a
 * token of the wrong kind to a workspace).
 */
const OAUTH_ONLY_KINDS = new Set<string>([
  "github",
  "gmail",
  "google_sheets",
  "notion",
  "slack",
]);

function validate(input: CredentialInput): void {
  if (!input.name || !input.name.trim()) {
    throw new HttpError(400, "BAD_REQUEST", "Give the credential a name.");
  }
  if (!KINDS.has(input.kind)) {
    throw new HttpError(400, "BAD_REQUEST", `Unknown credential kind "${input.kind}".`);
  }
  if (OAUTH_ONLY_KINDS.has(input.kind)) {
    throw new HttpError(
      422,
      "OAUTH_ONLY",
      `"${input.kind}" connections are created through the provider's OAuth flow, not by hand.`,
      { hint: "Use Connect on the Integrations page." },
    );
  }
  if (!input.fields || typeof input.fields !== "object") {
    throw new HttpError(400, "BAD_REQUEST", "Credential fields are required.");
  }
  for (const [key, value] of Object.entries(input.fields)) {
    if (typeof value !== "string") {
      throw new HttpError(400, "BAD_REQUEST", `Field "${key}" must be text.`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* OAuth connections (server-side only)                                */
/* ------------------------------------------------------------------ */

export interface OAuthCredentialInput {
  workspaceId: string;
  kind: string;
  name: string;
  fields: Record<string, string>;
  account: string;
  scopes: string[];
  expiresAt: number | null;
  /** Existing credential to replace when the user reconnects. */
  replaceId?: string;
}

/**
 * Create (or replace) an OAuth connection.
 *
 * Called only by the verified callback handler. Reconnecting the same
 * provider replaces the previous credential in place so workflows that
 * reference it keep working without being re-edited.
 */
export function upsertOAuthCredential(input: OAuthCredentialInput): CredentialView {
  if (!OAUTH_ONLY_KINDS.has(input.kind)) {
    throw new HttpError(500, "BAD_REQUEST", "OAuth credentials must be a provider kind.");
  }
  const timestamp = now();
  const secret = encryptSecret(JSON.stringify(input.fields));

  if (input.replaceId) {
    const existing = queryOne<CredentialRow>(
      "SELECT * FROM credentials WHERE id = ? AND workspace_id = ?",
      input.replaceId,
      input.workspaceId,
    );
    if (existing && existing.kind === input.kind) {
      sqlRun(
        `UPDATE credentials
            SET name = ?, secret_enc = ?, status = 'connected', account = ?, scopes = ?,
                expires_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
        input.name,
        secret,
        input.account,
        input.scopes.join(" "),
        input.expiresAt,
        timestamp,
        existing.id,
        input.workspaceId,
      );
      return toView(
        queryOne<CredentialRow>(
          "SELECT * FROM credentials WHERE id = ? AND workspace_id = ?",
          existing.id,
          input.workspaceId,
        )!,
      );
    }
  }

  const id = `cred_${randomBytes(8).toString("hex")}`;
  sqlRun(
    `INSERT INTO credentials
       (id, workspace_id, name, kind, secret_enc, status, account, scopes, expires_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?)`,
    id,
    input.workspaceId,
    input.name,
    input.kind,
    secret,
    input.account,
    input.scopes.join(" "),
    input.expiresAt,
    timestamp,
    timestamp,
  );
  return toView(
    queryOne<CredentialRow>(
      "SELECT * FROM credentials WHERE id = ? AND workspace_id = ?",
      id,
      input.workspaceId,
    )!,
  );
}

/* ------------------------------------------------------------------ */
/* Worker side — decrypt for one node run                              */
/* ------------------------------------------------------------------ */

/**
 * Decrypted fields for a credential id. Never logged, never returned
 * by an API route: handlers spread these into a request and drop them.
 */
export function decryptCredentialFields(
  workspaceId: string,
  credentialId: string,
): Record<string, string> {
  const row = queryOne<CredentialRow>(
    "SELECT * FROM credentials WHERE id = ? AND workspace_id = ?",
    credentialId,
    workspaceId,
  );
  if (!row) {
    throw new Error(`Credential ${credentialId} no longer exists.`);
  }
  try {
    const parsed: unknown = JSON.parse(decryptSecret(row.secret_enc));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("credential payload is not an object");
    }
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      fields[key] = typeof value === "string" ? value : String(value);
    }
    return fields;
  } catch (error) {
    throw new Error(
      `Credential "${row.name}" could not be decrypted: ${redactMessage(
        error instanceof Error ? error.message : "unknown error",
      )}`,
    );
  }
}
