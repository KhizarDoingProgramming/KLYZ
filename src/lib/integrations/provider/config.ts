import { nodeEnv } from "@/lib/config/env";
import type { OAuthProviderSpec, ProviderId } from "./types";

/**
 * Provider OAuth configuration.
 *
 * Read once, never thrown for a missing value: an unconfigured provider
 * must leave the rest of KLYZ bootable. Callers ask
 * `providerOAuthStatus(provider)` and render a clear configuration error
 * instead of a broken button.
 *
 * Secrets live only here — `client_secret` is never returned by an API
 * route, never logged, and never written to a workflow version.
 *
 * Five providers, two OAuth clients: Google Sheets deliberately reuses
 * the Gmail client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) with its
 * own redirect URI and spreadsheet-only scopes, so a deployment that
 * already connects Gmail does not have to register a second Google
 * application.
 */

export interface ProviderOAuthStatus {
  provider: ProviderId;
  configured: boolean;
  /** Human-readable blockers, shown by the Integrations page. */
  issues: string[];
  spec: OAuthProviderSpec | null;
}

/**
 * Minimum scopes for the shipped features.
 *
 * * GitHub — `public_repo` covers issue read/write on public repositories.
 *   Private repositories and webhook registration need opt-in scopes via
 *   `KLYZ_GITHUB_SCOPES`.
 * * Gmail — `gmail.send` (send/reply), `gmail.modify` (labels without
 *   touching read state), `gmail.readonly` (read threads/messages), plus
 *   `openid`/`email` so the connection can be labelled with its address.
 * * Google Sheets — `spreadsheets` (read and write the sheets the account
 *   can open) plus `openid`/`email` for that same label. No Drive scopes:
 *   KLYZ never lists or creates files.
 * * Slack — bot scopes only: write messages, read the channel list needed
 *   to resolve a channel name, and read message history for the event
 *   trigger. No files, no admin, no user tokens.
 * * Notion — Notion has no scope parameter; the integration's capabilities
 *   are chosen in the Notion admin console, so the list is empty here.
 */
const DEFAULT_SCOPES: Record<ProviderId, string[]> = {
  github: ["public_repo"],
  gmail: [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly",
    "openid",
    "email",
  ],
  google_sheets: [
    "https://www.googleapis.com/auth/spreadsheets",
    "openid",
    "email",
  ],
  notion: [],
  slack: ["chat:write", "channels:read", "groups:read", "channels:history", "groups:history"],
};

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function splitScopes(raw: string | undefined, fallback: string[]): string[] {
  const list = (raw ?? "")
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

function absoluteUrl(candidate: string, path: string): string {
  if (candidate) return candidate;
  const base = env("KLYZ_PUBLIC_URL") || "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}${path}`;
}

export function isProviderConfigured(provider: ProviderId): boolean {
  return providerOAuthStatus(provider).configured;
}

export function providerOAuthStatus(provider: ProviderId): ProviderOAuthStatus {
  switch (provider) {
    case "github":
      return githubStatus();
    case "google_sheets":
      return googleSheetsStatus();
    case "notion":
      return notionStatus();
    case "slack":
      return slackStatus();
    default:
      return gmailStatus();
  }
}

function githubStatus(): ProviderOAuthStatus {
  const issues: string[] = [];
  const clientId = env("GITHUB_CLIENT_ID");
  const clientSecret = env("GITHUB_CLIENT_SECRET");
  if (!clientId) issues.push("GITHUB_CLIENT_ID is not set.");
  if (!clientSecret) issues.push("GITHUB_CLIENT_SECRET is not set.");

  const spec: OAuthProviderSpec | null =
    issues.length === 0
      ? {
          id: "github",
          label: "GitHub",
          authorizationUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          scopes: splitScopes(env("KLYZ_GITHUB_SCOPES"), DEFAULT_SCOPES.github),
          usesPkce: false,
          authorizeParams: { allow_signup: "true" },
        }
      : null;

  return { provider: "github", configured: issues.length === 0, issues, spec };
}

function gmailStatus(): ProviderOAuthStatus {
  const issues: string[] = [];
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  if (!clientId) issues.push("GOOGLE_CLIENT_ID is not set.");
  if (!clientSecret) issues.push("GOOGLE_CLIENT_SECRET is not set.");

  const spec: OAuthProviderSpec | null =
    issues.length === 0
      ? {
          id: "gmail",
          label: "Gmail",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          scopes: splitScopes(env("KLYZ_GOOGLE_SCOPES"), DEFAULT_SCOPES.gmail),
          usesPkce: true,
        }
      : null;

  return { provider: "gmail", configured: issues.length === 0, issues, spec };
}

function googleSheetsStatus(): ProviderOAuthStatus {
  const issues: string[] = [];
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  if (!clientId) issues.push("GOOGLE_CLIENT_ID is not set.");
  if (!clientSecret) issues.push("GOOGLE_CLIENT_SECRET is not set.");

  const spec: OAuthProviderSpec | null =
    issues.length === 0
      ? {
          id: "google_sheets",
          label: "Google Sheets",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          scopes: splitScopes(env("KLYZ_GOOGLE_SHEETS_SCOPES"), DEFAULT_SCOPES.google_sheets),
          usesPkce: true,
        }
      : null;

  return { provider: "google_sheets", configured: issues.length === 0, issues, spec };
}

function notionStatus(): ProviderOAuthStatus {
  const issues: string[] = [];
  const clientId = env("NOTION_CLIENT_ID");
  const clientSecret = env("NOTION_CLIENT_SECRET");
  if (!clientId) issues.push("NOTION_CLIENT_ID is not set.");
  if (!clientSecret) issues.push("NOTION_CLIENT_SECRET is not set.");

  const spec: OAuthProviderSpec | null =
    issues.length === 0
      ? {
          id: "notion",
          label: "Notion",
          authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
          tokenUrl: "https://api.notion.com/v1/oauth/token",
          scopes: [],
          usesPkce: false,
          tokenAuthStyle: "basic",
          authorizeParams: { owner: "user" },
        }
      : null;

  return { provider: "notion", configured: issues.length === 0, issues, spec };
}

function slackStatus(): ProviderOAuthStatus {
  const issues: string[] = [];
  const clientId = env("SLACK_CLIENT_ID");
  const clientSecret = env("SLACK_CLIENT_SECRET");
  if (!clientId) issues.push("SLACK_CLIENT_ID is not set.");
  if (!clientSecret) issues.push("SLACK_CLIENT_SECRET is not set.");

  const spec: OAuthProviderSpec | null =
    issues.length === 0
      ? {
          id: "slack",
          label: "Slack",
          authorizationUrl: "https://slack.com/oauth/v2/authorize",
          tokenUrl: "https://slack.com/api/oauth.v2.access",
          scopes: splitScopes(env("KLYZ_SLACK_SCOPES"), DEFAULT_SCOPES.slack),
          usesPkce: false,
        }
      : null;

  return { provider: "slack", configured: issues.length === 0, issues, spec };
}

/* ------------------------------------------------------------------ */
/* Client credentials                                                  */
/* ------------------------------------------------------------------ */

const CLIENT_ENV: Record<ProviderId, { id: string; secret: string }> = {
  github: { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
  gmail: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  google_sheets: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  notion: { id: "NOTION_CLIENT_ID", secret: "NOTION_CLIENT_SECRET" },
  slack: { id: "SLACK_CLIENT_ID", secret: "SLACK_CLIENT_SECRET" },
};

/** `client_id` for a provider — empty string when the deployment has none. */
export function clientIdFor(provider: ProviderId): string {
  return env(CLIENT_ENV[provider].id);
}

/** `client_secret` — server-side only, never serialised. */
export function clientSecretFor(provider: ProviderId): string {
  return env(CLIENT_ENV[provider].secret);
}

export function githubClientId(): string {
  return clientIdFor("github");
}

export function githubClientSecret(): string {
  return clientSecretFor("github");
}

export function githubCallbackUrl(): string {
  return callbackUrlForProvider("github");
}

export function googleClientId(): string {
  return clientIdFor("gmail");
}

export function googleClientSecret(): string {
  return clientSecretFor("gmail");
}

export function googleCallbackUrl(): string {
  return callbackUrlForProvider("gmail");
}

/** Callback URL for a provider id — used by routes and the status view. */
export function callbackUrlForProvider(provider: ProviderId): string {
  switch (provider) {
    case "github":
      return absoluteUrl(env("GITHUB_CALLBACK_URL"), "/api/providers/github/callback");
    case "gmail":
      return absoluteUrl(env("GOOGLE_CALLBACK_URL"), "/api/providers/gmail/callback");
    case "google_sheets":
      return absoluteUrl(
        env("GOOGLE_SHEETS_CALLBACK_URL"),
        "/api/providers/google_sheets/callback",
      );
    case "notion":
      return absoluteUrl(env("NOTION_CALLBACK_URL"), "/api/providers/notion/callback");
    default:
      return absoluteUrl(env("SLACK_CALLBACK_URL"), "/api/providers/slack/callback");
  }
}

/**
 * Cloud Pub/Sub topic that Gmail push notifications are delivered to.
 * Empty means watch/push is unavailable and Gmail runs are started
 * manually — never a silently expiring subscription.
 */
export function googlePubSubTopic(): string {
  return env("GOOGLE_PUBSUB_TOPIC");
}

/**
 * Slack signing secret used to verify Events API deliveries.
 * Empty means the Slack trigger cannot verify anything, so publishing an
 * endpoint refuses rather than accepting unsigned events.
 */
export function slackSigningSecret(): string {
  return env("SLACK_SIGNING_SECRET");
}

/** Description of what KLYZ asks the user to grant, shown in the UI. */
export const SCOPE_DESCRIPTION: Record<ProviderId, Array<{ scope: string; label: string }>> = {
  github: [
    { scope: "public_repo", label: "Read and write issues on public repositories" },
    { scope: "repo", label: "Also allow private repositories (set KLYZ_GITHUB_SCOPES=repo)" },
    {
      scope: "admin:repo_hook",
      label: "Manage repository webhooks so KLYZ can receive events",
    },
  ],
  gmail: [
    { scope: "gmail.send", label: "Send mail from the connected account" },
    { scope: "gmail.modify", label: "Add and remove labels" },
    { scope: "gmail.readonly", label: "Read messages and threads" },
    { scope: "email", label: "Read the account's email address" },
  ],
  google_sheets: [
    { scope: "https://www.googleapis.com/auth/spreadsheets", label: "Read and write spreadsheets" },
    { scope: "email", label: "Read the account's email address" },
  ],
  notion: [],
  slack: [
    { scope: "chat:write", label: "Post messages as the app" },
    { scope: "channels:read", label: "List public channels to resolve names" },
    { scope: "groups:read", label: "List private channels the app is in" },
    { scope: "channels:history", label: "Read public channel messages (event trigger)" },
    { scope: "groups:history", label: "Read private channel messages (event trigger)" },
  ],
};

/** True when the deployment is production — callback URLs must be absolute. */
export function strictCallbacks(): boolean {
  return nodeEnv() === "production";
}
