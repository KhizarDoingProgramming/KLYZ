import { exec, now, queryOne, run as sqlRun } from "./db";
import { recordAudit } from "./audit";
import { HttpError } from "./http";
import { assertMember, type Actor } from "./identity";
import { upsertOAuthCredential, type CredentialView } from "./credentials";
import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkce,
  exchangeCode,
  OAUTH_STATE_TTL_MS,
} from "@/lib/integrations/provider/oauth";
import {
  providerOAuthStatus,
  callbackUrlForProvider,
  clientIdFor,
  clientSecretFor,
} from "@/lib/integrations/provider/config";
import { providerFetch } from "@/lib/integrations/provider/http";
import { ProviderError } from "@/lib/integrations/provider/errors";
import type { ProviderId } from "@/lib/integrations/provider/types";
import { NOTION_API_VERSION } from "@/lib/integrations/notion/api";

/**
 * OAuth handshake.
 *
 * The callback is a plain browser navigation: no session cookie, no
 * `x-klyz-*` headers. Everything it needs to know — which workspace,
 * which user, where to send the browser back to — travels inside a
 * single-use, short-lived `state` row that is consumed on first use.
 * That row is the only place the PKCE verifier is ever stored; it is
 * deleted with the state.
 *
 * `client_secret` never leaves this module, is never logged and is
 * never part of a redirect.
 */

interface StateRow {
  state: string;
  provider: string;
  workspace_id: string;
  user_id: string;
  code_verifier: string | null;
  redirect_path: string | null;
  created_at: number;
  expires_at: number;
  used: number;
}

export interface ConnectResult {
  url: string;
  provider: ProviderId;
  scopes: string[];
  callbackUrl: string;
}

const callbackUrlFor = callbackUrlForProvider;

/**
 * Builds the provider's authorisation URL and stores the state.
 *
 * Fails with `422 PROVIDER_NOT_CONFIGURED` — never by crashing: an
 * unconfigured provider must leave the rest of the app usable.
 */
export function startConnect(
  actor: Actor,
  provider: ProviderId,
  redirectPath = "/integrations",
): ConnectResult {
  assertMember(actor);
  const status = providerOAuthStatus(provider);
  if (!status.configured || !status.spec) {
    throw new HttpError(
      422,
      "PROVIDER_NOT_CONFIGURED",
      `${status.spec?.label ?? provider} OAuth is not configured for this deployment.`,
      { issues: status.issues },
    );
  }

  const state = createOAuthState();
  const pkce = status.spec.usesPkce ? createPkce() : null;
  const expiresAt = now() + OAUTH_STATE_TTL_MS;

  sqlRun(
    `INSERT INTO oauth_states
       (state, provider, workspace_id, user_id, code_verifier, redirect_path,
        created_at, expires_at, used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    state,
    provider,
    actor.workspaceId,
    actor.userId,
    pkce?.verifier ?? null,
    safeRedirect(redirectPath),
    now(),
    expiresAt,
  );

  pruneStates();

  return {
    provider,
    url: buildAuthorizeUrl({
      spec: status.spec,
      state,
      redirectUri: callbackUrlFor(provider),
      codeVerifier: pkce?.verifier ?? undefined,
    }),
    scopes: status.spec.scopes,
    callbackUrl: callbackUrlFor(provider),
  };
}

/** Where the browser goes after the handshake — same-origin only. */
function safeRedirect(path: string): string {
  const trimmed = (path || "/integrations").trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\\\")) {
    return "/integrations";
  }
  return trimmed.slice(0, 512);
}

export interface CallbackResult {
  credential: CredentialView;
  provider: ProviderId;
  redirectPath: string;
  account: string;
  scopes: string[];
}

/** Consumes the state, exchanges the code and stores the connection. */
export async function completeConnect(
  provider: ProviderId,
  code: string | null,
  stateParam: string | null,
): Promise<CallbackResult> {
  if (!stateParam) {
    throw new HttpError(400, "OAUTH_STATE_MISSING", "The callback is missing its state.");
  }
  if (!code) {
    throw new HttpError(400, "OAUTH_CODE_MISSING", "The provider did not return an authorization code.");
  }

  const row = takeState(stateParam, provider);
  const status = providerOAuthStatus(provider);
  if (!status.configured || !status.spec) {
    throw new HttpError(
      422,
      "PROVIDER_NOT_CONFIGURED",
      `${status.spec?.label ?? provider} OAuth is not configured for this deployment.`,
      { issues: status.issues },
    );
  }

  const clientId = clientIdFor(provider);
  const clientSecret = clientSecretFor(provider);

  const tokens = await exchangeCode({
    spec: status.spec,
    code,
    redirectUri: callbackUrlFor(provider),
    codeVerifier: row.code_verifier ?? undefined,
    clientId,
    clientSecret,
  });

  const connection = await fetchIdentity(provider, tokens.accessToken, tokens.scope);
  const actor: Actor = { userId: row.user_id, workspaceId: row.workspace_id };
  assertMember(actor);

  const credential = upsertOAuthCredential({
    workspaceId: actor.workspaceId,
    kind: provider,
    name: connection.name,
    fields: tokenFields(tokens, connection.extra),
    account: connection.account,
    scopes: connection.scopes,
    expiresAt: tokens.expiresIn ? now() + tokens.expiresIn * 1000 : null,
    replaceId: findExisting(actor, provider),
  });

  /* The handshake is finished — record who linked what, with the
     provider and credential id only (never a token or scope list that
     could be replayed). */
  recordAudit({
    action: "integration.connected",
    actorId: actor.userId,
    workspaceId: actor.workspaceId,
    resourceType: "credential",
    resourceId: credential.id,
    metadata: { provider },
  });

  return {
    credential,
    provider,
    redirectPath: row.redirect_path ?? "/integrations",
    account: connection.account,
    scopes: connection.scopes,
  };
}

interface Identity {
  account: string;
  name: string;
  scopes: string[];
  extra: Record<string, string>;
}

/** Provider-specific profile lookup — the only place identity is read. */
async function fetchIdentity(
  provider: ProviderId,
  accessToken: string,
  grantedScope: string,
): Promise<Identity> {
  const scopes = grantedScope
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  if (provider === "github") {
    const user = await providerFetch<{ login?: string; name?: string | null; email?: string | null; id?: number }>({
      provider: "github",
      operation: "oauth_identity",
      url: "https://api.github.com/user",
      headers: { authorization: `Bearer ${accessToken}` },
      timeoutMs: 10_000,
    });
    const login = user.data?.login ?? "";
    if (!login) {
      throw new ProviderError("github", "GitHub did not return an account for this token.", {
        operation: "oauth_identity",
        category: "authentication",
      });
    }
    return {
      account: login,
      name: `GitHub — ${login}`,
      scopes,
      extra: {
        userId: String(user.data?.id ?? ""),
        ...(user.data?.email ? { email: user.data.email } : {}),
      },
    };
  }

  if (provider === "gmail" || provider === "google_sheets") {
    const info = await providerFetch<{ sub?: string; email?: string; name?: string; email_verified?: boolean }>({
      provider,
      operation: "oauth_identity",
      url: "https://www.googleapis.com/oauth2/v3/userinfo",
      headers: { authorization: `Bearer ${accessToken}` },
      timeoutMs: 10_000,
    });
    const email = info.data?.email ?? "";
    if (!email) {
      throw new ProviderError(
        provider,
        "Google did not return an email address — the account may be a Workspace user without the email scope.",
        { operation: "oauth_identity", category: "authorization" },
      );
    }
    return {
      account: email,
      name: `${provider === "gmail" ? "Gmail" : "Google Sheets"} — ${email}`,
      scopes,
      extra: {
        subject: info.data?.sub ?? "",
        ...(info.data?.name ? { displayName: info.data.name } : {}),
      },
    };
  }

  if (provider === "slack") {
    const auth = await providerFetch<{
      ok?: boolean;
      error?: string;
      team?: string;
      team_id?: string;
      user?: string;
      user_id?: string;
      bot_id?: string;
      url?: string;
    }>({
      provider: "slack",
      operation: "oauth_identity",
      url: "https://slack.com/api/auth.test",
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
      timeoutMs: 10_000,
    });
    const body = auth.data;
    if (body?.ok === false || !body?.team) {
      throw new ProviderError(
        "slack",
        "Slack did not return a workspace for this token.",
        { operation: "oauth_identity", category: "authentication", providerMessage: body?.error },
      );
    }
    return {
      account: body.team,
      name: `Slack — ${body.team}`,
      scopes,
      extra: {
        teamId: body.team_id ?? "",
        userId: body.user_id ?? "",
        ...(body.bot_id ? { botUserId: body.bot_id } : {}),
        ...(body.url ? { workspaceUrl: body.url } : {}),
      },
    };
  }

  const me = await providerFetch<{
    id?: string;
    name?: string;
    type?: string;
    person?: { email?: string };
    bot?: { workspace_name?: string; workspace_icon?: string; owner?: unknown };
  }>({
    provider: "notion",
    operation: "oauth_identity",
    url: "https://api.notion.com/v1/users/me",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "notion-version": NOTION_API_VERSION,
    },
    timeoutMs: 10_000,
  });
  const workspace = me.data?.bot?.workspace_name ?? "";
  const email = me.data?.person?.email ?? "";
  const label = workspace || email || me.data?.name || "";
  if (!label) {
    throw new ProviderError("notion", "Notion did not return an account for this token.", {
      operation: "oauth_identity",
      category: "authentication",
    });
  }
  return {
    account: label,
    name: `Notion — ${label}`,
    scopes,
    extra: {
      userId: me.data?.id ?? "",
      userType: me.data?.type ?? "",
      ...(workspace ? { workspaceName: workspace } : {}),
      ...(email ? { email } : {}),
    },
  };
}

function tokenFields(
  tokens: { accessToken: string; refreshToken: string | null; expiresIn: number | null; scope: string; tokenType: string },
  extra: Record<string, string>,
): Record<string, string> {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresIn ? { expiresAt: String(now() + tokens.expiresIn * 1000) } : {}),
    scope: tokens.scope,
    tokenType: tokens.tokenType,
    ...extra,
  };
}

function findExisting(actor: Actor, provider: ProviderId): string | undefined {
  const row = queryOne<{ id: string }>(
    "SELECT id FROM credentials WHERE workspace_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT 1",
    actor.workspaceId,
    provider,
  );
  return row?.id;
}

/* ------------------------------------------------------------------ */
/* State store                                                         */
/* ------------------------------------------------------------------ */

/**
 * Marks the state used and returns it, or fails.
 *
 * Single-use: the `used` flag flips inside the same statement that
 * reads the row, so a replayed callback cannot redeem the same code
 * twice even under concurrency.
 */
function takeState(state: string, provider: ProviderId): StateRow {
  /* The claim is scoped to the provider: a callback that arrives with
     somebody else's state must not be able to burn it. */
  const claimed = exec(
    `UPDATE oauth_states SET used = 1 WHERE state = ? AND provider = ? AND used = 0 AND expires_at > ?`,
    state,
    provider,
    now(),
  );
  const row = queryOne<StateRow>("SELECT * FROM oauth_states WHERE state = ?", state);
  if (claimed === 0) {
    if (row && row.provider !== provider) {
      throw new HttpError(
        400,
        "OAUTH_STATE_INVALID",
        "The sign-in link is for a different provider.",
      );
    }
    throw new HttpError(
      400,
      "OAUTH_STATE_INVALID",
      "That sign-in link has expired or was already used — start the connection again.",
    );
  }
  if (!row) {
    throw new HttpError(400, "OAUTH_STATE_INVALID", "That sign-in link is no longer available.");
  }
  return row;
}

/** Removes expired states. Cheap, and keeps the table from growing. */
export function pruneStates(): void {
  sqlRun("DELETE FROM oauth_states WHERE expires_at <= ?", now());
}
