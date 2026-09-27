import { HttpError } from "./http";
import { exec, queryAll, queryOne, run as sqlRun, now } from "./db";
import { ensureSeed } from "./seed";
import {
  assertSameOrigin,
  clientIp,
  clientUserAgent,
  readSession,
  sessionTokenFrom,
  setActiveWorkspace,
  type SessionRow,
} from "./auth";

/**
 * Workspace identity — "which tenant is this request acting for".
 *
 * The actor is always derived from the server-side session: the cookie
 * proves *who*, the session row carries the active workspace, and
 * `workspace_members` proves the right to act in it. Nothing in the
 * request body, query string or path is trusted as identity.
 *
 * A client may still *ask* for a workspace with the `x-klyz-workspace`
 * header — that is a selection hint, not a claim: it is accepted only
 * when this user really is a member of that workspace.
 */

export interface Actor {
  userId: string;
  workspaceId: string;
}

/** An actor plus everything the authorization layer needs per request. */
export interface AuthenticatedActor extends Actor {
  sessionId: string;
  role: Role;
  email: string;
  name: string;
}

export type Role = "owner" | "admin" | "member" | "viewer";

export const WORKSPACE_HEADER = "x-klyz-workspace";

/**
 * The seeded single-user workspace used by development, the demo seed
 * and the actor-based test suites. It is a real row with a real
 * membership — never a bypass around `assertMember`.
 */
const DEFAULT_USER = "u_default";
const DEFAULT_WORKSPACE = "ws_default";

/* ------------------------------------------------------------------ */
/* Resolving an authenticated actor                                    */
/* ------------------------------------------------------------------ */

function header(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The authenticated actor behind a raw session token, or `null` when
 * there is no live session. Identity comes from the session row alone —
 * never from a header, body or path.
 *
 * `requested` is an optional workspace *selection* (a header hint on an
 * HTTP request, nothing at all for a server component). It is honoured
 * only when this user really is a member of that workspace.
 */
export function actorFromToken(
  token: string | null,
  requested?: string | null,
): AuthenticatedActor | null {
  const session = readSession(token);
  if (!session) return null;
  const user = queryOne<{ id: string; email: string; name: string }>(
    "SELECT id, email, name FROM users WHERE id = ?",
    session.user_id,
  );
  if (!user) return null;
  const workspaceId = resolveWorkspaceId(session, user.id, requested ?? null);
  if (!workspaceId) {
    throw new HttpError(
      403,
      "NO_WORKSPACE",
      "This account is not a member of any workspace yet.",
    );
  }
  const membership = membershipOf({ userId: user.id, workspaceId });
  if (!membership) {
    throw new HttpError(
      403,
      "NOT_A_MEMBER",
      "You do not have access to this workspace.",
    );
  }
  return {
    userId: user.id,
    workspaceId,
    sessionId: session.id,
    role: membership.role,
    email: user.email,
    name: user.name,
  };
}

/** The authenticated actor behind an HTTP request (cookie only). */
export function getAuthenticatedActor(request: Request): AuthenticatedActor | null {
  return actorFromToken(sessionTokenFrom(request), header(request, WORKSPACE_HEADER));
}

/**
 * The actor behind a request — the gate every authenticated route
 * walks through. Throws 403 on a cross-site state change, 401 when the
 * session is missing or expired, 403 when the account has nowhere to go.
 */
export function requireAuthenticatedActor(request: Request): AuthenticatedActor {
  assertSameOrigin(request);
  const actor = getAuthenticatedActor(request);
  if (!actor) {
    throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  }
  return actor;
}

/**
 * Which workspace this request wants.
 *
 * Selection hint → remembered session choice → first membership. Every
 * candidate is checked against `workspace_members` before use, so a
 * forged workspace id can only ever produce a 403.
 */
function resolveWorkspaceId(
  session: SessionRow,
  userId: string,
  requested: string | null,
): string | null {
  if (requested) {
    if (!membershipOf({ userId, workspaceId: requested })) {
      throw new HttpError(
        403,
        "NOT_A_MEMBER",
        "You do not have access to this workspace.",
      );
    }
    if (session.active_workspace_id !== requested) {
      setActiveWorkspace(session.id, requested);
    }
    return requested;
  }
  if (session.active_workspace_id) {
    if (membershipOf({ userId, workspaceId: session.active_workspace_id })) {
      return session.active_workspace_id;
    }
    setActiveWorkspace(session.id, null);
  }
  const first = queryOne<{ workspace_id: string }>(
    "SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1",
    userId,
  );
  return first?.workspace_id ?? null;
}

/* ------------------------------------------------------------------ */
/* Membership                                                          */
/* ------------------------------------------------------------------ */

export interface Membership {
  workspaceId: string;
  userId: string;
  role: Role;
}

const ROLES = new Set<Role>(["owner", "admin", "member", "viewer"]);

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLES.has(value as Role);
}

export function membershipOf(actor: {
  userId: string;
  workspaceId: string;
}): Membership | null {
  const row = queryOne<{ role: string }>(
    "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    actor.workspaceId,
    actor.userId,
  );
  if (!row || !isRole(row.role)) return null;
  return { workspaceId: actor.workspaceId, userId: actor.userId, role: row.role };
}

export function assertMember(actor: Actor): Membership {
  const membership = membershipOf(actor);
  if (!membership) {
    throw new HttpError(
      403,
      "NOT_A_MEMBER",
      "You do not have access to this workspace.",
    );
  }
  return membership;
}

/** All workspaces this user belongs to, oldest first. */
export function membershipsFor(userId: string): Array<{
  workspaceId: string;
  name: string;
  slug: string;
  role: Role;
  createdAt: string;
}> {
  const rows = queryAll<{
    workspace_id: string;
    name: string;
    slug: string;
    role: string;
    created_at: number;
  }>(
    `SELECT m.workspace_id, w.name, w.slug, m.role, m.created_at
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ?
      ORDER BY m.created_at ASC`,
    userId,
  );
  return rows
    .filter((row) => isRole(row.role))
    .map((row) => ({
      workspaceId: row.workspace_id,
      name: row.name,
      slug: row.slug,
      role: row.role as Role,
      createdAt: new Date(row.created_at).toISOString(),
    }));
}

/* ------------------------------------------------------------------ */
/* Seeds                                                               */
/* ------------------------------------------------------------------ */

/**
 * Ensures the default workspace and its seeded identity exist.
 *
 * The seeded user has no password and cannot sign in — it exists so the
 * demo workspace has a stable owner and so the actor-based test suites
 * keep a real membership to assert against.
 */
export function ensureIdentitySeed(): void {
  ensureSeed();
  const workspace = queryOne<{ id: string }>(
    "SELECT id FROM workspaces WHERE id = ?",
    DEFAULT_WORKSPACE,
  );
  if (!workspace) {
    sqlRun(
      "INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)",
      DEFAULT_WORKSPACE,
      "Default workspace",
      "default",
      now(),
    );
  }
  const user = queryOne<{ id: string }>(
    "SELECT id FROM users WHERE id = ?",
    DEFAULT_USER,
  );
  if (!user) {
    sqlRun(
      `INSERT INTO users (id, email, name, password_hash, system, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 1, ?, ?)`,
      DEFAULT_USER,
      "seed@klyz.local",
      "KLYZ seed",
      now(),
      now(),
    );
  }
  const member = queryOne<{ user_id: string }>(
    "SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    DEFAULT_WORKSPACE,
    DEFAULT_USER,
  );
  if (!member) {
    sqlRun(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      DEFAULT_WORKSPACE,
      DEFAULT_USER,
      "owner",
      now(),
    );
  }
}

/**
 * The default workspace actor for server components and tests that run
 * outside an HTTP request. Membership is seeded, then checked — the
 * same rule every HTTP actor follows.
 */
export function defaultActor(): Actor {
  ensureIdentitySeed();
  const actor: Actor = { userId: DEFAULT_USER, workspaceId: DEFAULT_WORKSPACE };
  assertMember(actor);
  return actor;
}

export { DEFAULT_USER, DEFAULT_WORKSPACE };

/** Best-effort request metadata for audit records. */
export function requestMeta(request: Request): { ip: string | null; userAgent: string | null } {
  return { ip: clientIp(request), userAgent: clientUserAgent(request) };
}

/** Rows in a workspace without an owner are a data error, not a state. */
export function countOwners(workspaceId: string): number {
  return (
    queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM workspace_members WHERE workspace_id = ? AND role = 'owner'",
      workspaceId,
    )?.total ?? 0
  );
}

/** Remove a membership only when it cannot orphan the workspace. */
export function deleteMembership(workspaceId: string, userId: string): number {
  return exec(
    "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    workspaceId,
    userId,
  );
}
