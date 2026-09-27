import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "klyz-oauth-test-"));
process.env.KLYZ_DB_PATH = join(tmpDir, "klyz.db");
process.env.KLYZ_QUEUE_DRIVER = "memory";

import { HttpError } from "./http";
import { defaultActor } from "./identity";
import { getDb, queryAll, queryOne, run as sqlRun } from "./db";
import { completeConnect, pruneStates, startConnect } from "./oauth";

const actor = defaultActor();

const GITHUB_ENV = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_CALLBACK_URL"] as const;
const GOOGLE_ENV = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_CALLBACK_URL"] as const;

function clearEnv(): void {
  for (const name of [...GITHUB_ENV, ...GOOGLE_ENV, "KLYZ_GITHUB_SCOPES", "KLYZ_GOOGLE_SCOPES"]) {
    delete process.env[name];
  }
}

function configureGithub(): void {
  process.env.GITHUB_CLIENT_ID = "Iv1.test_client";
  process.env.GITHUB_CLIENT_SECRET = "test_secret";
}

afterAll(() => {
  clearEnv();
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearEnv();
  sqlRun("DELETE FROM oauth_states");
});

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(status);
  expect((error as HttpError).code).toBe(code);
}

function stateRow(state: string) {
  return queryOne<{ state: string; used: number; expires_at: number; redirect_path: string | null }>(
    "SELECT state, used, expires_at, redirect_path FROM oauth_states WHERE state = ?",
    state,
  );
}

/* ------------------------------------------------------------------ */
/* startConnect                                                        */
/* ------------------------------------------------------------------ */

describe("startConnect", () => {
  it("fails cleanly when the deployment has no OAuth app configured", () => {
    const error = (() => {
      try {
        startConnect(actor, "github");
        return null;
      } catch (failure) {
        return failure as HttpError;
      }
    })();
    expect(error).toBeInstanceOf(HttpError);
    expect(error?.status).toBe(422);
    expect(error?.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(JSON.stringify(error?.details)).toContain("GITHUB_CLIENT_ID");
    expect(queryAll("SELECT state FROM oauth_states")).toHaveLength(0);
  });

  it("stores an unused state and sends the browser to the provider", () => {
    configureGithub();
    const connect = startConnect(actor, "github", "/workflows/wf_1");

    expect(connect.provider).toBe("github");
    expect(connect.callbackUrl).toContain("/api/providers/github/callback");
    expect(connect.scopes).toContain("public_repo");
    expect(connect.url.startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
    expect(connect.url).toContain(`redirect_uri=${encodeURIComponent(connect.callbackUrl)}`);

    const state = new URL(connect.url).searchParams.get("state");
    expect(state).toBeTruthy();
    const row = stateRow(state!);
    expect(row).toBeTruthy();
    expect(row!.used).toBe(0);
    expect(row!.redirect_path).toBe("/workflows/wf_1");
  });

  it("keeps the post-handshake redirect on this origin", () => {
    configureGithub();
    const hostile = [
      "//evil.example/steal",
      "https://evil.example",
      "javascript:alert(1)",
      "\\\\evil.example",
      "",
    ];
    for (const path of hostile) {
      const connect = startConnect(actor, "github", path);
      const state = new URL(connect.url).searchParams.get("state")!;
      expect(stateRow(state)!.redirect_path).toBe("/integrations");
      sqlRun("DELETE FROM oauth_states WHERE state = ?", state);
    }

    const ok = startConnect(actor, "github", "/runs?tab=failed");
    const okState = new URL(ok.url).searchParams.get("state")!;
    expect(stateRow(okState)!.redirect_path).toBe("/runs?tab=failed");
    sqlRun("DELETE FROM oauth_states WHERE state = ?", okState);
  });

  it("adds PKCE for providers that require it", () => {
    configureGithub();
    process.env.GOOGLE_CLIENT_ID = "google_client";
    process.env.GOOGLE_CLIENT_SECRET = "google_secret";

    const gmail = startConnect(actor, "gmail");
    const url = new URL(gmail.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();

    const github = startConnect(actor, "github");
    expect(new URL(github.url).searchParams.get("code_challenge")).toBeNull();
  });

  it("honours the scoped environment override", () => {
    configureGithub();
    process.env.KLYZ_GITHUB_SCOPES = "repo,admin:repo_hook";
    const connect = startConnect(actor, "github");
    expect(connect.scopes).toEqual(["repo", "admin:repo_hook"]);
    expect(new URL(connect.url).searchParams.get("scope")).toBe("repo admin:repo_hook");
  });
});

/* ------------------------------------------------------------------ */
/* completeConnect — state handling                                    */
/* ------------------------------------------------------------------ */

describe("completeConnect state handling", () => {
  it("requires a state and a code", async () => {
    configureGithub();
    await expectHttpError(completeConnect("github", null, null), 400, "OAUTH_STATE_MISSING");
    await expectHttpError(completeConnect("github", "code", null), 400, "OAUTH_STATE_MISSING");
    await expectHttpError(completeConnect("github", null, "anything"), 400, "OAUTH_CODE_MISSING");
    await expectHttpError(completeConnect("github", "", "anything"), 400, "OAUTH_CODE_MISSING");
  });

  it("consumes the state exactly once, so a replay cannot redeem the code twice", async () => {
    /* Configured so the state can be created, then left unconfigured so
       the handshake stops before any network call — the state has still
       been claimed, which is the property under test. */
    configureGithub();
    const connect = startConnect(actor, "github");
    const state = new URL(connect.url).searchParams.get("state")!;
    expect(stateRow(state)!.used).toBe(0);

    clearEnv();
    await expectHttpError(completeConnect("github", "code", state), 422, "PROVIDER_NOT_CONFIGURED");
    expect(stateRow(state)!.used).toBe(1);

    await expectHttpError(completeConnect("github", "code", state), 400, "OAUTH_STATE_INVALID");
  });

  it("rejects an unknown, expired or already-used state", async () => {
    configureGithub();
    await expectHttpError(
      completeConnect("github", "code", "not-a-real-state"),
      400,
      "OAUTH_STATE_INVALID",
    );

    sqlRun(
      `INSERT INTO oauth_states
         (state, provider, workspace_id, user_id, code_verifier, redirect_path,
          created_at, expires_at, used)
       VALUES (?, 'github', ?, ?, NULL, '/integrations', ?, ?, 0)`,
      "expired_state",
      actor.workspaceId,
      actor.userId,
      Date.now() - 60_000,
      Date.now() - 1,
    );
    await expectHttpError(
      completeConnect("github", "code", "expired_state"),
      400,
      "OAUTH_STATE_INVALID",
    );

    sqlRun(
      `INSERT INTO oauth_states
         (state, provider, workspace_id, user_id, code_verifier, redirect_path,
          created_at, expires_at, used)
       VALUES (?, 'github', ?, ?, NULL, '/integrations', ?, ?, 1)`,
      "used_state",
      actor.workspaceId,
      actor.userId,
      Date.now(),
      Date.now() + 60_000,
    );
    await expectHttpError(
      completeConnect("github", "code", "used_state"),
      400,
      "OAUTH_STATE_INVALID",
    );
  });

  it("refuses a state issued for a different provider", async () => {
    configureGithub();
    process.env.GOOGLE_CLIENT_ID = "google_client";
    process.env.GOOGLE_CLIENT_SECRET = "google_secret";

    const connect = startConnect(actor, "github");
    const state = new URL(connect.url).searchParams.get("state")!;
    await expectHttpError(completeConnect("gmail", "code", state), 400, "OAUTH_STATE_INVALID");
    /* The claim failed, so the state must still be redeemable by GitHub. */
    expect(stateRow(state)!.used).toBe(0);
  });
});

describe("pruneStates", () => {
  it("drops expired rows and keeps live ones", () => {
    sqlRun(
      `INSERT INTO oauth_states
         (state, provider, workspace_id, user_id, code_verifier, redirect_path,
          created_at, expires_at, used)
       VALUES ('old', 'github', ?, ?, NULL, '/integrations', ?, ?, 0)`,
      actor.workspaceId,
      actor.userId,
      Date.now() - 60_000,
      Date.now() - 1,
    );
    sqlRun(
      `INSERT INTO oauth_states
         (state, provider, workspace_id, user_id, code_verifier, redirect_path,
          created_at, expires_at, used)
       VALUES ('fresh', 'github', ?, ?, NULL, '/integrations', ?, ?, 0)`,
      actor.workspaceId,
      actor.userId,
      Date.now(),
      Date.now() + 60_000,
    );

    pruneStates();
    expect(stateRow("old")).toBeUndefined();
    expect(stateRow("fresh")).toBeTruthy();
  });
});
