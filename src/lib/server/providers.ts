import { HttpError } from "./http";
import { queryOne, run as sqlRun, now } from "./db";
import { decryptCredentialFields, listCredentials, type CredentialView } from "./credentials";
import { redactMessage } from "./redact";
import type { Actor } from "./identity";
import {
  SCOPE_DESCRIPTION,
  providerOAuthStatus,
  callbackUrlForProvider,
} from "@/lib/integrations/provider/config";
import { providerFetch } from "@/lib/integrations/provider/http";
import {
  PROVIDER_IDS,
  providerLabel,
  type ProviderId,
} from "@/lib/integrations/provider/types";
import { getWatch, type WatchView } from "@/lib/integrations/gmail/watch";

/**
 * Integration status for the editor.
 *
 * Everything here is read from the database or the environment: which
 * providers this deployment can connect, which scopes we ask for, which
 * accounts are actually connected, and (for Gmail) whether a push watch
 * is really live. Nothing is synthesised — an unconfigured provider
 * reports `configured: false` with the missing variables, not a green
 * badge.
 */

export interface ProviderSummary {
  id: ProviderId;
  label: string;
  configured: boolean;
  issues: string[];
  /** Scopes KLYZ asks for, each annotated with a plain-language label. */
  scopes: Array<{ scope: string; label: string; granted: boolean }>;
  callbackUrl: string;
  connections: CredentialView[];
  /** Present for Gmail: the real `users.watch` subscription state. */
  watch?: WatchView | null;
  /** Node types this provider contributes, for the palette hint. */
  nodes: string[];
}

const NODES: Record<ProviderId, string[]> = {
  github: ["trigger.github", "action.github_issue", "action.github_comment"],
  gmail: [
    "trigger.gmail",
    "action.gmail_send",
    "action.gmail_reply",
    "action.gmail_label",
    "action.gmail_get",
  ],
  google_sheets: ["action.sheets_append", "action.sheets_read", "action.sheets_write"],
  notion: ["action.notion_page", "action.notion_search"],
  slack: ["trigger.slack", "action.slack_message", "action.slack_channel"],
};

/** Validates a `[provider]` route segment. */
export function parseProvider(value: string): ProviderId {
  const provider = value.trim() as ProviderId;
  if (!PROVIDER_IDS.includes(provider)) {
    throw new HttpError(404, "UNKNOWN_PROVIDER", `No integration called "${value}".`);
  }
  return provider;
}

/** Most recently updated connection for a provider in this workspace. */
export function latestConnectionId(actor: Actor, provider: ProviderId): string | null {
  const row = queryOne<{ id: string }>(
    "SELECT id FROM credentials WHERE workspace_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT 1",
    actor.workspaceId,
    provider,
  );
  return row?.id ?? null;
}

export function providerSummaries(actor: Actor): ProviderSummary[] {
  const credentials = listCredentials(actor);
  return PROVIDER_IDS.map((id) => {
    const status = providerOAuthStatus(id);
    const connections = credentials.filter((credential) => credential.kind === id);
    const granted = new Set(connections.flatMap((connection) => connection.scopes));
    const summaries: ProviderSummary = {
      id,
      label: status.spec?.label ?? providerLabel(id),
      configured: status.configured,
      issues: status.issues,
      scopes: (SCOPE_DESCRIPTION[id] ?? []).map((entry) => ({
        ...entry,
        granted: granted.has(entry.scope),
      })),
      callbackUrl: callbackUrlForProvider(id),
      connections,
      nodes: NODES[id],
    };
    if (id === "gmail") {
      summaries.watch = connections[0] ? getWatch(actor.workspaceId, connections[0].id) : null;
    }
    return summaries;
  });
}

/* ------------------------------------------------------------------ */
/* Disconnect                                                          */
/* ------------------------------------------------------------------ */

/**
 * Marks a connection disconnected and best-effort revokes the token at
 * the provider.
 *
 * Revocation failing does not fail the call: the local state is already
 * authoritative (the credential is unusable afterwards), and a revoked
 * token whose remote DELETE 404s is exactly what we want. The failure is
 * recorded so the user can see it.
 */
export async function disconnectConnection(
  actor: Actor,
  provider: ProviderId,
  credentialId: string,
): Promise<CredentialView> {
  const credential = listCredentials(actor).find(
    (entry) => entry.id === credentialId && entry.kind === provider,
  );
  if (!credential) {
    throw new HttpError(404, "NOT_FOUND", "That connection does not exist in this workspace.");
  }

  const reason = "Disconnected from the Integrations page.";
  sqlRun(
    `UPDATE credentials
        SET status = 'disconnected', last_error = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
    reason,
    now(),
    credentialId,
    actor.workspaceId,
  );

  const revoked = await revokeRemote(provider, credentialId, actor.workspaceId);
  if (!revoked.ok && revoked.error) {
    sqlRun(
      "UPDATE credentials SET last_error = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      `Disconnected. Remote revocation did not confirm: ${revoked.error}`,
      now(),
      credentialId,
      actor.workspaceId,
    );
  }

  const updated = listCredentials(actor).find((entry) => entry.id === credentialId);
  if (!updated) throw new HttpError(404, "NOT_FOUND", "That connection no longer exists.");
  return updated;
}

async function revokeRemote(
  provider: ProviderId,
  credentialId: string,
  workspaceId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const fields = decryptCredentialFields(workspaceId, credentialId);
    const token = fields.accessToken ?? "";
    if (!token) return { ok: true };

    if (provider === "github") {
      const clientId = (process.env.GITHUB_CLIENT_ID ?? "").trim();
      const clientSecret = (process.env.GITHUB_CLIENT_SECRET ?? "").trim();
      if (!clientId || !clientSecret) return { ok: true };
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      await providerFetch({
        provider: "github",
        operation: "oauth_revoke",
        url: `https://api.github.com/applications/${clientId}/token`,
        method: "DELETE",
        headers: { authorization: `Basic ${credentials}` },
        json: { access_token: token },
        timeoutMs: 10_000,
      });
      return { ok: true };
    }

    if (provider === "slack") {
      await providerFetch({
        provider: "slack",
        operation: "oauth_revoke",
        url: "https://slack.com/api/oauth.v2.revoke",
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token,
          client_id: (process.env.SLACK_CLIENT_ID ?? "").trim(),
          client_secret: (process.env.SLACK_CLIENT_SECRET ?? "").trim(),
        }).toString(),
        timeoutMs: 10_000,
      });
      return { ok: true };
    }

    if (provider === "notion") {
      /* Notion publishes no token-revocation endpoint; the local
         disconnect is authoritative because the credential becomes
         unusable the moment its status flips. */
      return { ok: true };
    }

    await providerFetch({
      provider,
      operation: "oauth_revoke",
      url: "https://oauth2.googleapis.com/revoke",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      timeoutMs: 10_000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: redactMessage(error instanceof Error ? error.message : String(error)) };
  }
}
