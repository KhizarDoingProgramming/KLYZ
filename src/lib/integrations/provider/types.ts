import type { CredentialKind } from "@/lib/workflow/types";

/**
 * Provider vocabulary shared by every external connector.
 *
 * GitHub and Gmail are the first two providers, but nothing in this
 * file mentions their request formats — a future Slack or Notion module
 * reuses the same connection, OAuth and error vocabulary so the engine,
 * the credential store and the UI never learn a second dialect.
 */

export const PROVIDER_IDS = [
  "github",
  "gmail",
  "google_sheets",
  "notion",
  "slack",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Maps a provider to the credential kind that stores its tokens. */
export const PROVIDER_CREDENTIAL_KIND: Record<ProviderId, CredentialKind> = {
  github: "github",
  gmail: "gmail",
  google_sheets: "google_sheets",
  notion: "notion",
  slack: "slack",
};

/** Display name used in normalised errors and logs. Never a secret. */
export const PROVIDER_LABEL: Record<ProviderId, string> = {
  github: "GitHub",
  gmail: "Gmail",
  google_sheets: "Google Sheets",
  notion: "Notion",
  slack: "Slack",
};

export function providerLabel(provider: ProviderId | string): string {
  return PROVIDER_LABEL[provider as ProviderId] ?? String(provider);
}

/**
 * Connection lifecycle.
 *
 * More than "connected": the UI has to tell the user *what to do next*,
 * so revocation and expiry are first-class states rather than a red dot.
 */
export const CONNECTION_STATUSES = [
  "connected",
  "connecting",
  "reauthorization_required",
  "expired",
  "revoked",
  "error",
  "disconnected",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Non-secret connection metadata — safe to return from any API. */
export interface ProviderConnectionView {
  id: string;
  provider: ProviderId;
  /** Workspace-scoped credential id referenced by node configuration. */
  credentialId: string;
  name: string;
  status: ConnectionStatus;
  /** Login, email or account label — never a token. */
  account: string | null;
  /** Granted scopes as the provider reported them. */
  scopes: string[];
  /** Access-token expiry (ISO), null when the token never expires. */
  expiresAt: string | null;
  /** Last connection-level failure, already redacted. */
  lastError: string | null;
  connectedAt: string;
  updatedAt: string;
  /** Workflows in this workspace whose nodes reference this connection. */
  usedBy: Array<{ workflowId: string; name: string; nodeCount: number }>;
}

/** What an OAuth-capable provider must expose to the shared flow. */
export interface OAuthProviderSpec {
  id: ProviderId;
  label: string;
  authorizationUrl: string;
  tokenUrl: string;
  /** Scopes requested on first connect — the minimum the nodes need. */
  scopes: string[];
  usesPkce: boolean;
  /**
   * How `client_id`/`client_secret` reach the token endpoint.
   * `body` is the OAuth 2.0 default (form-encoded); `basic` is what
   * Notion's `/v1/oauth/token` requires.
   */
  tokenAuthStyle?: "body" | "basic";
  /** Extra authorisation parameters some providers insist on. */
  authorizeParams?: Record<string, string>;
}

/** Decrypted tokens + metadata. Worker-only; never serialised. */
export interface ProviderConnection {
  credentialId: string;
  provider: ProviderId;
  workspaceId: string;
  name: string;
  status: ConnectionStatus;
  account: string | null;
  scopes: string[];
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
  /** Provider-specific extras (token type, id token, …). */
  extra: Record<string, string>;
}
