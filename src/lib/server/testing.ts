import { randomBytes } from "node:crypto";

import { createSession, createUser, SESSION_COOKIE, findUserByEmail, toUserView } from "./auth";
import { closeDatabase, run as sqlRun } from "./db";
import { createTestDatabaseSync, dropTestDatabaseSync } from "./pg/test-database";
import type { AuthenticatedActor, Role } from "./identity";

/**
 * Test-only fixtures for building a real, server-side session.
 *
 * Route handlers are only reachable through a session cookie, so tests
 * create accounts the same way production does — a real `users` row, a
 * real membership row, and a real `sessions` row — rather than stubbing
 * the identity layer. Nothing here is imported by application code.
 */

export interface TestAccount {
  userId: string;
  email: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
  sessionId: string;
  token: string;
  /** Ready-made request headers for route handlers. */
  headers: Record<string, string>;
  /** The actor a successful authentication produces. */
  actor: AuthenticatedActor;
}

export interface TestAccountOptions {
  email?: string;
  name?: string;
  password?: string;
  role?: Role;
  /** Reuse an existing workspace instead of creating one. */
  workspaceId?: string;
  workspaceName?: string;
}

export function createWorkspaceRow(name: string): string {
  const id = `ws_${randomBytes(9).toString("base64url")}`;
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"}-${randomBytes(3).toString("hex")}`;
  sqlRun(
    "INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)",
    id,
    name,
    slug,
    Date.now(),
  );
  return id;
}

export function addMemberRow(workspaceId: string, userId: string, role: Role): void {
  sqlRun(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
    workspaceId,
    userId,
    role,
    Date.now(),
  );
}

/** A loginable account with its own workspace and a live session. */
export function createTestAccount(options: TestAccountOptions = {}): TestAccount {
  const suffix = randomBytes(6).toString("hex");
  const email = options.email ?? `tester-${suffix}@example.test`;
  const name = options.name ?? `Tester ${suffix}`;
  const role: Role = options.role ?? "owner";

  const user = findUserByEmail(email) ?? createUser({ email, name, password: options.password ?? "correct horse battery" });
  const workspaceId =
    options.workspaceId ?? createWorkspaceRow(options.workspaceName ?? "Test workspace");
  addMemberRow(workspaceId, user.id, role);

  const { token, session } = createSession(user.id, { activeWorkspaceId: workspaceId });

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    workspaceId,
    workspaceName: options.workspaceName ?? "Test workspace",
    role,
    sessionId: session.id,
    token,
    headers: authHeaders(token),
    actor: {
      userId: user.id,
      workspaceId,
      sessionId: session.id,
      role,
      email: user.email,
      name: user.name,
    },
  };
}

/** Cookie headers for a session token. */
export function authHeaders(token: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

/** The user view of a test account, for assertions. */
export function userViewOf(account: TestAccount) {
  return toUserView({
    id: account.userId,
    email: account.email,
    name: account.name,
    password_hash: null,
    system: 0,
    created_at: 0,
    updated_at: 0,
  });
}

/* ------------------------------------------------------------------ */
/* The database this file owns                                         */
/* ------------------------------------------------------------------ */

let owned: string | null = null;

/**
 * Give this test file its own PostgreSQL database.
 *
 * A database per file rather than a schema per file: one file's
 * `DROP`/`TRUNCATE` is then invisible to the others, and connection
 * state (`search_path`, prepared statements, advisory locks) needs no
 * thought at all. Names are random, so parallel workers never collide.
 *
 * Synchronous, and called from module scope. Test files read the
 * database through module-level calls such as `defaultActor()`, which
 * run while the module is still being evaluated — long before any hook —
 * so a database created in `beforeAll` would arrive too late.
 */
export function openTestDatabase(prefix: string): void {
  if (owned) throw new Error(`test database ${owned} is already open`);
  owned = createTestDatabaseSync(prefix);
  process.env.KLYZ_DB_DRIVER = "postgres";
  /* The SQLite path is a per-process file; leaving it set would let a
     driver re-resolution fall back to a store nothing else reads. */
  delete process.env.KLYZ_DB_PATH;
}

/**
 * Release the bridge and drop the database. The last statement of
 * `afterAll`: anything that still queries after it has no store, which
 * is the point — the rows must not outlive the file that made them.
 */
export async function endTestDatabase(): Promise<void> {
  const name = owned;
  owned = null;
  await closeDatabase();
  if (name) dropTestDatabaseSync(name);
}
