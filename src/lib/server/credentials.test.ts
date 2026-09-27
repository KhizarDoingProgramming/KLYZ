import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "klyz-cred-test-"));
process.env.KLYZ_DB_PATH = join(tmpDir, "klyz.db");
process.env.KLYZ_CREDENTIAL_KEY = "ab".repeat(32);

import { HttpError } from "./http";
import { defaultActor } from "./identity";
import { getDb, queryOne } from "./db";
import {
  createCredential,
  decryptCredentialFields,
  deleteCredential,
  getCredential,
  listCredentials,
  updateCredential,
  upsertOAuthCredential,
} from "./credentials";
import { testCredential } from "./credential-test";

const actor = defaultActor();

afterAll(() => {
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("credentials", () => {
  it("stores encrypted fields and never returns them from the API surface", () => {
    const created = createCredential(actor, {
      name: "GitHub bot",
      kind: "http_bearer",
      fields: { token: "ghp_super_secret_token" },
    });

    expect(created.id).toMatch(/^cred_/);
    expect(created.kind).toBe("http_bearer");
    expect(created).not.toHaveProperty("fields");
    expect(JSON.stringify(created)).not.toContain("ghp_super_secret_token");

    /* Ciphertext at rest contains no plaintext. */
    const row = queryOne<{ secret_enc: string }>(
      "SELECT secret_enc FROM credentials WHERE id = ?",
      created.id,
    );
    expect(row?.secret_enc).toMatch(/^v1:/);
    expect(row?.secret_enc).not.toContain("ghp_super_secret_token");

    /* The worker can decrypt it for exactly one node run. */
    expect(decryptCredentialFields(actor.workspaceId, created.id)).toEqual({
      token: "ghp_super_secret_token",
    });
  });

  it("lists and fetches without exposing secrets", () => {
    createCredential(actor, {
      name: "Analytics DB",
      kind: "postgres",
      fields: { host: "db.internal", database: "analytics", user: "reader", password: "pw" },
    });

    const listed = listCredentials(actor);
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed[0]).not.toHaveProperty("fields");
    expect(JSON.stringify(listed)).not.toContain("pw");
    expect(getCredential(actor, listed[0]!.id).name).toBe(listed[0]!.name);
  });

  it("rotates stored fields and rejects foreign workspaces", () => {
    const created = createCredential(actor, {
      name: "Rotate me",
      kind: "http_header",
      fields: { headerName: "X-Key", value: "first" },
    });
    updateCredential(actor, created.id, { fields: { headerName: "X-Key", value: "second" } });
    expect(decryptCredentialFields(actor.workspaceId, created.id).value).toBe("second");

    expect(() =>
      getCredential({ userId: "u_someone", workspaceId: "ws_other" }, created.id),
    ).toThrowError(HttpError);

    deleteCredential(actor, created.id);
    expect(() => getCredential(actor, created.id)).toThrowError(HttpError);
    expect(() => decryptCredentialFields(actor.workspaceId, created.id)).toThrowError();
  });

  it("validates input", () => {
    expect(() => createCredential(actor, { name: "  ", kind: "postgres", fields: {} })).toThrowError(
      HttpError,
    );
    expect(() =>
      createCredential(actor, { name: "Bad kind", kind: "telepathy", fields: {} }),
    ).toThrowError(/Unknown credential kind/);
  });

  it("says plainly when a kind has no connection test", async () => {
    /* Provider kinds cannot be created by hand — the OAuth callback is
       the only path — so this credential arrives the way Slack's does. */
    expect(() =>
      createCredential(actor, { name: "Slack", kind: "slack", fields: { token: "xoxb-1" } }),
    ).toThrowError(/OAuth flow/);

    const created = upsertOAuthCredential({
      workspaceId: actor.workspaceId,
      kind: "slack",
      name: "KLYZ",
      fields: { token: "xoxb-1" },
      account: "klyz",
      scopes: ["chat:write"],
      expiresAt: null,
    });
    await expect(testCredential(actor, created.id)).rejects.toMatchObject({
      code: "TEST_NOT_SUPPORTED",
    });
  });

  it("requires a URL before testing an HTTP credential", async () => {
    const created = createCredential(actor, {
      name: "No URL",
      kind: "http_bearer",
      fields: { token: "tok" },
    });
    await expect(testCredential(actor, created.id)).rejects.toMatchObject({
      code: "NO_TEST_URL",
    });
  });
});
