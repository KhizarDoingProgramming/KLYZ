import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as rsaSign } from "node:crypto";

vi.mock("@/lib/integrations/provider/http", () => ({
  providerFetch: vi.fn(),
}));

import { providerFetch } from "@/lib/integrations/provider/http";
import { HttpError } from "./http";
import { resetJwksCache, verifyGooglePushToken } from "./google-oidc";

const fetchMock = vi.mocked(providerFetch);

const AUDIENCE = "https://klyz.example/api/providers/gmail/hooks/abc123";
const KID = "klyz-test-key";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const head = base64url(JSON.stringify(header));
  const body = base64url(JSON.stringify(payload));
  const signature = rsaSign("sha256", Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${base64url(signature)}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    exp: now + 600,
    iat: now - 30,
    email: "1234567890@gserviceaccount.com",
    email_verified: true,
    sub: "push-svc",
    ...overrides,
  };
}

async function expectReject(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).code).toBe(code);
  expect((error as HttpError).status).toBe(401);
}

beforeEach(() => {
  resetJwksCache();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    data: { keys: [{ kty: "RSA", kid: KID, n: jwk.n, e: jwk.e }] },
    headers: { "cache-control": "max-age=3600" },
    status: 200,
    text: "",
    rateLimit: null,
    durationMs: 1,
  } as never);
});

afterEach(() => {
  resetJwksCache();
});

describe("verifyGooglePushToken", () => {
  it("accepts a correctly signed token for this exact endpoint", async () => {
    const token = signJwt({ alg: "RS256", kid: KID }, validClaims());
    const result = await verifyGooglePushToken(`Bearer ${token}`, AUDIENCE);
    expect(result.claims.iss).toBe("https://accounts.google.com");
    expect(result.claims.aud).toBe(AUDIENCE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches the signing keys for the published max-age", async () => {
    const token = signJwt({ alg: "RS256", kid: KID }, validClaims());
    await verifyGooglePushToken(`Bearer ${token}`, AUDIENCE);
    await verifyGooglePushToken(`Bearer ${token}`, AUDIENCE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resetJwksCache();
    await verifyGooglePushToken(`Bearer ${token}`, AUDIENCE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing or malformed bearer token", async () => {
    await expectReject(verifyGooglePushToken(null, AUDIENCE), "PUSH_AUTH_FAILED");
    await expectReject(verifyGooglePushToken("", AUDIENCE), "PUSH_AUTH_FAILED");
    await expectReject(verifyGooglePushToken("Bearer ", AUDIENCE), "PUSH_AUTH_FAILED");
    await expectReject(verifyGooglePushToken("Bearer a.b", AUDIENCE), "PUSH_AUTH_FAILED");
    await expectReject(verifyGooglePushToken("Basic abc", AUDIENCE), "PUSH_AUTH_FAILED");
  });

  it("rejects an unsupported algorithm or an unknown signing key", async () => {
    const token = signJwt({ alg: "HS256", kid: KID }, validClaims());
    await expectReject(verifyGooglePushToken(`Bearer ${token}`, AUDIENCE), "PUSH_AUTH_FAILED");

    const unknown = signJwt({ alg: "RS256", kid: "someone-else" }, validClaims());
    await expectReject(verifyGooglePushToken(`Bearer ${unknown}`, AUDIENCE), "PUSH_AUTH_FAILED");
  });

  it("rejects a token signed by a different key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const head = base64url(JSON.stringify({ alg: "RS256", kid: KID }));
    const body = base64url(JSON.stringify(validClaims()));
    const signature = rsaSign("sha256", Buffer.from(`${head}.${body}`), other.privateKey);
    await expectReject(
      verifyGooglePushToken(`Bearer ${head}.${body}.${base64url(signature)}`, AUDIENCE),
      "PUSH_AUTH_FAILED",
    );
  });

  it("rejects expired and future-dated tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = signJwt({ alg: "RS256", kid: KID }, validClaims({ exp: now - 3600 }));
    await expectReject(verifyGooglePushToken(`Bearer ${expired}`, AUDIENCE), "PUSH_AUTH_FAILED");

    const future = signJwt({ alg: "RS256", kid: KID }, validClaims({ iat: now + 3600 }));
    await expectReject(verifyGooglePushToken(`Bearer ${future}`, AUDIENCE), "PUSH_AUTH_FAILED");
  });

  it("rejects an unexpected issuer, audience and caller", async () => {
    const wrongIss = signJwt(
      { alg: "RS256", kid: KID },
      validClaims({ iss: "https://evil.example" }),
    );
    await expectReject(verifyGooglePushToken(`Bearer ${wrongIss}`, AUDIENCE), "PUSH_AUTH_FAILED");

    const wrongAud = signJwt(
      { alg: "RS256", kid: KID },
      validClaims({ aud: "https://other.example/hook" }),
    );
    await expectReject(verifyGooglePushToken(`Bearer ${wrongAud}`, AUDIENCE), "PUSH_AUTH_FAILED");

    const wrongCaller = signJwt(
      { alg: "RS256", kid: KID },
      validClaims({ email: "someone@example.com" }),
    );
    await expectReject(
      verifyGooglePushToken(`Bearer ${wrongCaller}`, AUDIENCE),
      "PUSH_AUTH_FAILED",
    );
  });

  it("accepts a string or array audience and both Google issuer forms", async () => {
    const arrayAud = signJwt(
      { alg: "RS256", kid: KID },
      validClaims({ aud: [AUDIENCE, "https://other.example"] }),
    );
    await expect(verifyGooglePushToken(`Bearer ${arrayAud}`, AUDIENCE)).resolves.toBeTruthy();

    const bareIss = signJwt({ alg: "RS256", kid: KID }, validClaims({ iss: "accounts.google.com" }));
    await expect(verifyGooglePushToken(`Bearer ${bareIss}`, AUDIENCE)).resolves.toBeTruthy();
  });

  it("surfaces a JWKS failure as an HTTP error, not a crash", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const token = signJwt({ alg: "RS256", kid: KID }, validClaims());
    await expect(verifyGooglePushToken(`Bearer ${token}`, AUDIENCE)).rejects.toThrow();
  });

  it("reports an empty key set as a gateway failure", async () => {
    fetchMock.mockResolvedValueOnce({
      data: { keys: [] },
      headers: {},
      status: 200,
      text: "",
      rateLimit: null,
      durationMs: 1,
    } as never);
    const token = signJwt({ alg: "RS256", kid: KID }, validClaims());
    await expect(verifyGooglePushToken(`Bearer ${token}`, AUDIENCE)).rejects.toMatchObject({
      code: "GOOGLE_JWKS_EMPTY",
    });
  });
});
