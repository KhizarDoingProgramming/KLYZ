import { createHash, randomBytes } from "node:crypto";
import { ProviderError } from "./errors";
import { providerFetch, type ProviderResult } from "./http";
import { clientIdFor as readClientId } from "./config";
import type { OAuthProviderSpec, ProviderId } from "./types";

/**
 * Shared OAuth 2.0 authorization-code plumbing.
 *
 * Both providers run through the same three steps — build an
 * authorisation URL, exchange the callback code, refresh when the token
 * expires — so a new connector only supplies its endpoints and scopes.
 *
 * Security properties, all enforced here rather than by convention:
 *  - `state` is 32 bytes of CSPRNG entropy, single-use, short-lived
 *    (see `server/oauth.ts` for persistence) — CSRF on the callback.
 *  - Gmail uses PKCE (S256) so a stolen code is useless without the
 *    verifier that never left this process.
 *  - Token responses are parsed into a typed struct; the raw body is
 *    never logged.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export interface PkceChallenge {
  verifier: string;
  challenge: string;
}

export function createPkce(): PkceChallenge {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export interface AuthorizeOptions {
  spec: OAuthProviderSpec;
  state: string;
  redirectUri: string;
  /** PKCE verifier, stored server-side with the state. */
  codeVerifier?: string;
  /** Forces the account picker — used by "reconnect as another account". */
  prompt?: "consent" | "select_account";
}

export function buildAuthorizeUrl(options: AuthorizeOptions): string {
  const url = new URL(options.spec.authorizationUrl);
  url.searchParams.set("client_id", readClientId(options.spec.id));
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  /* Notion scopes live in its admin console, not in the request — an
     empty list means "no scope parameter", not "public access". */
  if (options.spec.scopes.length > 0) {
    url.searchParams.set("scope", options.spec.scopes.join(" "));
  }
  url.searchParams.set("state", options.state);

  if (isGoogleProvider(options.spec.id)) {
    /* Google needs offline access to hand back a refresh token, and the
       account picker so "reconnect as another account" actually works. */
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("prompt", options.prompt ?? "consent");
    if (options.codeVerifier) {
      url.searchParams.set("code_challenge", createChallenge(options.codeVerifier));
      url.searchParams.set("code_challenge_method", "S256");
    }
  }

  for (const [key, value] of Object.entries(options.spec.authorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function isGoogleProvider(provider: ProviderId): boolean {
  return provider === "gmail" || provider === "google_sheets";
}

function createChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/* ------------------------------------------------------------------ */
/* Token exchange                                                      */
/* ------------------------------------------------------------------ */

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  scope: string;
  expiresIn: number | null;
  refreshToken: string | null;
  refreshExpiresIn: number | null;
}

export class OAuthExchangeError extends ProviderError {
  constructor(provider: ProviderId, message: string, detail?: string) {
    super(provider, message, {
      operation: "oauth_token_exchange",
      category: "authentication",
      detail,
    });
    this.name = "OAuthExchangeError";
  }
}

export async function exchangeCode(params: {
  spec: OAuthProviderSpec;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  clientSecret: string;
  clientId: string;
  signal?: AbortSignal;
}): Promise<TokenResponse> {
  const base = {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
  };

  /* Notion's token endpoint wants HTTP Basic credentials and a JSON
     body; every other provider takes the form-encoded default. */
  if (params.spec.tokenAuthStyle === "basic") {
    const result = await tokenRequest(params.spec.id, params.spec.tokenUrl, {
      headers: {
        accept: "application/json, */*",
        "content-type": "application/json",
        authorization: basicCredentials(params.clientId, params.clientSecret),
      },
      body: JSON.stringify(base),
      signal: params.signal,
    });
    return parseTokenResponse(params.spec.id, result.data, result.text);
  }

  const body = new URLSearchParams({
    ...base,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  if (params.codeVerifier) body.set("code_verifier", params.codeVerifier);

  const result = await tokenRequest(params.spec.id, params.spec.tokenUrl, {
    headers: {
      accept: "application/json, */*",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: params.signal,
  });
  return parseTokenResponse(params.spec.id, result.data, result.text);
}

export async function refreshToken(params: {
  spec: OAuthProviderSpec;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  signal?: AbortSignal;
}): Promise<TokenResponse> {
  const parsed = await tokenRequestFor(
    params.spec,
    { grant_type: "refresh_token", refresh_token: params.refreshToken },
    params,
  );
  /* Google omits refresh_token on refresh; keep the one we already hold. */
  if (!parsed.refreshToken) parsed.refreshToken = params.refreshToken;
  return parsed;
}

async function tokenRequestFor(
  spec: OAuthProviderSpec,
  base: Record<string, string>,
  params: { clientId: string; clientSecret: string; signal?: AbortSignal },
): Promise<TokenResponse> {
  const call: { headers: Record<string, string>; body: string; signal?: AbortSignal } =
    spec.tokenAuthStyle === "basic"
      ? {
          headers: {
            accept: "application/json, */*",
            "content-type": "application/json",
            authorization: basicCredentials(params.clientId, params.clientSecret),
          },
          body: JSON.stringify(base),
          signal: params.signal,
        }
      : {
          headers: {
            accept: "application/json, */*",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            ...base,
            client_id: params.clientId,
            client_secret: params.clientSecret,
          }).toString(),
          signal: params.signal,
        };
  const result = await tokenRequest(spec.id, spec.tokenUrl, call);
  return parseTokenResponse(spec.id, result.data, result.text);
}

function basicCredentials(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

async function tokenRequest(
  provider: ProviderId,
  tokenUrl: string,
  call: {
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
): Promise<ProviderResult<unknown>> {
  return await providerFetch({
    provider,
    operation: "oauth_token_exchange",
    url: tokenUrl,
    method: "POST",
    headers: call.headers,
    body: call.body,
    timeoutMs: 15_000,
    signal: call.signal,
  });
}

export function parseTokenResponse(
  provider: ProviderId,
  data: unknown,
  rawText: string,
): TokenResponse {
  const record =
    data && typeof data === "object" ? (data as Record<string, unknown>) : parseForm(rawText);

  const accessToken = stringField(record, "access_token");
  if (!accessToken) {
    const error = stringField(record, "error") || "no access_token in the response";
    const description =
      stringField(record, "error_description") ||
      stringField(record, "error_uri") ||
      "The provider refused the authorization code.";
    throw new OAuthExchangeError(
      provider,
      "The provider did not return an access token.",
      `${error} — ${description}`,
    );
  }

  return {
    accessToken,
    tokenType: stringField(record, "token_type") || "Bearer",
    scope: stringField(record, "scope"),
    expiresIn: numberField(record, "expires_in"),
    refreshToken: stringField(record, "refresh_token") || null,
    refreshExpiresIn: numberField(record, "refresh_token_expires_in"),
  };
}

function parseForm(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    /* fall through to form decoding */
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = Number(record[key]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
