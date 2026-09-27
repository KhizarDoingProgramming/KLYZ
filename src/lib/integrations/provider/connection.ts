import { now, queryOne, run as sqlRun } from "@/lib/server/db";
import { decryptCredentialFields, encryptSecret } from "@/lib/server/credentials";
import type { CredentialKind } from "@/lib/workflow/types";
import { PROVIDER_CREDENTIAL_KIND, CONNECTION_STATUSES, type ConnectionStatus, type ProviderConnection, type ProviderId } from "./types";
import { ProviderError, connectionError } from "./errors";
import { clientIdFor, clientSecretFor, providerOAuthStatus } from "./config";
import { refreshToken as refreshOAuthToken } from "./oauth";
import type { OAuthProviderSpec } from "./types";

/**
 * Credential-backed provider connections.
 *
 * OAuth tokens are stored exactly like every other KLYZ credential: one
 * AES-256-GCM blob in `credentials.secret_enc`, scoped to a workspace,
 * decrypted only inside the worker for the duration of a node run. The
 * non-secret columns (`status`, `account`, `scopes`, `expires_at`) are
 * what the UI reads — so connection state is real data, never a badge
 * the frontend invented.
 *
 * The worker may transparently refresh an expired access token. The
 * refreshed token is written straight back through the same encrypted
 * path; it is never returned to a caller, never logged and never placed
 * on the queue.
 */

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

/** Skew so a token is refreshed before it actually lapses. */
const EXPIRY_SKEW_MS = 60_000;

function row(workspaceId: string, credentialId: string, provider: ProviderId): CredentialRow {
  const found = queryOne<CredentialRow>(
    "SELECT * FROM credentials WHERE id = ? AND workspace_id = ?",
    credentialId,
    workspaceId,
  );
  if (!found) {
    throw connectionError(
      provider,
      "load_connection",
      "That connection no longer exists in this workspace.",
      "not_found",
    );
  }
  return found;
}

function parseSecret(row: CredentialRow): Record<string, string> {
  const fields = decryptCredentialFields(row.workspace_id, row.id);
  return fields;
}

/**
 * Load a connection for execution.
 *
 * `provider` is asserted against the credential kind, so a GitHub node
 * can never be handed a Gmail credential even if configuration is
 * tampered with after validation.
 */
export async function loadConnection(
  workspaceId: string,
  credentialId: string,
  provider: ProviderId,
): Promise<ProviderConnection> {
  const current = row(workspaceId, credentialId, provider);
  assertKind(current, provider);

  const fields = parseSecret(current);
  const accessToken = fields.accessToken ?? fields.access_token ?? "";
  if (!accessToken) {
    throw connectionError(
      provider,
      "load_connection",
      "This connection has no access token stored.",
      "authentication",
    );
  }

  const expiresAt = fields.expiresAt ? Number(fields.expiresAt) : null;
  const connection = toConnection(current, fields, accessToken, expiresAt);

  if (current.status === "revoked") {
    throw connectionError(
      provider,
      "load_connection",
      "Access to this account was revoked — reconnect it to continue.",
      "authentication",
    );
  }
  if (current.status === "disconnected") {
    throw connectionError(
      provider,
      "load_connection",
      "This connection was disconnected.",
      "authentication",
    );
  }

  const expired = expiresAt !== null && expiresAt - EXPIRY_SKEW_MS <= now();
  if (expired && fields.refreshToken) {
    return await refreshConnection(current, connection, fields.refreshToken, provider);
  }
  if (expired) {
    setStatus(current.id, workspaceId, "expired", "The access token expired.");
    throw connectionError(
      provider,
      "load_connection",
      "The access token for this connection has expired — reconnect the account.",
      "authentication",
    );
  }
  if (current.status === "expired" || current.status === "error") {
    setStatus(current.id, workspaceId, "connected", null);
  }
  return connection;
}

function assertKind(row: CredentialRow, provider: ProviderId): void {
  const expected: CredentialKind = PROVIDER_CREDENTIAL_KIND[provider];
  if (row.kind !== expected) {
    throw connectionError(
      provider,
      "load_connection",
      `That credential is a ${row.kind} credential, not a ${provider} connection.`,
      "validation",
    );
  }
}

function toConnection(
  row: CredentialRow,
  fields: Record<string, string>,
  accessToken: string,
  expiresAt: number | null,
): ProviderConnection {
  const scopes = (row.scopes ?? "")
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (["accessToken", "access_token", "refreshToken", "refresh_token", "expiresAt"].includes(key)) {
      continue;
    }
    extra[key] = value;
  }
  return {
    credentialId: row.id,
    provider: row.kind as ProviderId,
    workspaceId: row.workspace_id,
    name: row.name,
    status: normaliseStatus(row.status),
    account: row.account,
    scopes,
    accessToken,
    refreshToken: fields.refreshToken ?? fields.refresh_token ?? undefined,
    expiresAt,
    extra,
  };
}

async function refreshConnection(
  current: CredentialRow,
  connection: ProviderConnection,
  refreshTokenValue: string,
  provider: ProviderId,
): Promise<ProviderConnection> {
  const spec = oauthSpecFor(provider);
  const clientId = clientIdFor(provider);
  const clientSecret = clientSecretFor(provider);
  if (!spec || !clientId || !clientSecret) {
    throw connectionError(
      provider,
      "refresh_token",
      "The access token expired and OAuth is not configured to refresh it.",
      "authentication",
    );
  }

  let tokens;
  try {
    tokens = await refreshOAuthToken({
      spec,
      refreshToken: refreshTokenValue,
      clientId,
      clientSecret,
    });
  } catch (error) {
    const invalid =
      error instanceof ProviderError &&
      /invalid_grant|bad credentials|token has been expired|revoked/i.test(
        `${error.providerMessage ?? ""} ${error.detail ?? ""}`,
      );
    if (invalid) {
      setStatus(current.id, connection.workspaceId, "revoked", "The refresh token was rejected.");
      throw connectionError(
        provider,
        "refresh_token",
        "The connection was revoked — reconnect the account to continue.",
        "authentication",
      );
    }
    throw error;
  }

  const expiresAt = tokens.expiresIn ? now() + tokens.expiresIn * 1000 : null;
  const fields = parseSecret(current);
  fields.accessToken = tokens.accessToken;
  fields.expiresAt = expiresAt ? String(expiresAt) : "";
  if (tokens.refreshToken) fields.refreshToken = tokens.refreshToken;
  if (tokens.scope) fields.scope = tokens.scope;

  persistSecret(current, fields);
  setStatus(current.id, connection.workspaceId, "connected", null, {
    expiresAt,
    scopes: tokens.scope || current.scopes || "",
  });

  return {
    ...connection,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? refreshTokenValue,
    expiresAt,
    status: "connected",
    scopes: tokens.scope
      ? tokens.scope.split(/[,\s]+/).filter(Boolean)
      : connection.scopes,
  };
}

/* ------------------------------------------------------------------ */
/* Persistence helpers                                                 */
/* ------------------------------------------------------------------ */

function persistSecret(current: CredentialRow, fields: Record<string, string>): void {
  sqlRun(
    "UPDATE credentials SET secret_enc = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
    encryptSecret(JSON.stringify(fields)),
    now(),
    current.id,
    current.workspace_id,
  );
}

export function setStatus(
  credentialId: string,
  workspaceId: string,
  status: ConnectionStatus,
  lastError: string | null,
  extra: { expiresAt?: number | null; scopes?: string | string[]; account?: string } = {},
): void {
  const scopes = Array.isArray(extra.scopes)
    ? extra.scopes.join(" ")
    : (extra.scopes ?? undefined);
  sqlRun(
    `UPDATE credentials
        SET status = ?,
            last_error = ?,
            expires_at = COALESCE(?, expires_at),
            scopes = COALESCE(?, scopes),
            account = COALESCE(?, account),
            updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
    status,
    lastError,
    extra.expiresAt === undefined ? null : extra.expiresAt,
    scopes ?? null,
    extra.account ?? null,
    now(),
    credentialId,
    workspaceId,
  );
}

/** Connection lifecycle for OAuth connections. */
function normaliseStatus(value: string): ConnectionStatus {
  return (CONNECTION_STATUSES as readonly string[]).includes(value)
    ? (value as ConnectionStatus)
    : "connected";
}

function oauthSpecFor(provider: ProviderId): OAuthProviderSpec | null {
  return providerOAuthStatus(provider).spec;
}
