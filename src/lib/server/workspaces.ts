import { randomBytes } from "node:crypto";
import { now, queryAll, queryOne, run as sqlRun } from "./db";
import { HttpError } from "./http";
import {
  countOwners,
  ensureIdentitySeed,
  isRole,
  membershipOf,
  membershipsFor,
  type Actor,
  type Role,
} from "./identity";
import { can, ROLE_ORDER, requirePermission, type ActorLike } from "./authz";

/**
 * Workspace and membership management.
 *
 * Invariants enforced here (not in the UI):
 *  - a workspace always keeps at least one owner;
 *  - nobody may grant a role above their own, and only an owner may
 *    mint another owner;
 *  - role changes and ownership transfers are validated against the
 *    *server's* membership rows, never against a client claim;
 *  - a member can be removed only when the workspace keeps an owner.
 */

export interface WorkspaceView {
  id: string;
  name: string;
  slug: string;
  role: Role;
  createdAt: string;
}

export interface MemberView {
  userId: string;
  email: string;
  name: string;
  role: Role;
  system: boolean;
  createdAt: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  created_at: number;
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

export function getWorkspace(workspaceId: string): WorkspaceRow | undefined {
  return queryOne<WorkspaceRow>(
    "SELECT id, name, slug, created_at FROM workspaces WHERE id = ?",
    workspaceId,
  );
}

export function listWorkspacesFor(actor: Actor): WorkspaceView[] {
  return membershipsFor(actor.userId).map((membership) => ({
    id: membership.workspaceId,
    name: membership.name,
    slug: membership.slug,
    role: membership.role,
    createdAt: membership.createdAt,
  }));
}

/**
 * The payload every auth endpoint returns: who you are, where you can
 * go, and which workspace this session is currently acting in. Never
 * includes a token — the cookie is the only credential.
 */
export function sessionPayload(actor: {
  userId: string;
  workspaceId: string;
  role: Role;
  email: string;
  name: string;
}): {
  user: { id: string; email: string; name: string };
  workspaces: WorkspaceView[];
  activeWorkspaceId: string;
  role: Role;
} {
  return {
    user: { id: actor.userId, email: actor.email, name: actor.name },
    workspaces: listWorkspacesFor(actor),
    activeWorkspaceId: actor.workspaceId,
    role: actor.role,
  };
}

export function listMembers(actor: ActorLike): MemberView[] {
  requirePermission(actor, "member:read");
  const rows = queryAll<{
    user_id: string;
    email: string;
    name: string;
    role: string;
    system: number;
    created_at: number;
  }>(
    `SELECT m.user_id, u.email, u.name, m.role, u.system, m.created_at
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                           WHEN 'member' THEN 2 ELSE 3 END,
               m.created_at ASC`,
    actor.workspaceId,
  );
  return rows
    .filter((row) => isRole(row.role))
    .map((row) => ({
      userId: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role as Role,
      system: row.system === 1,
      createdAt: new Date(row.created_at).toISOString(),
    }));
}

const ROLE_ORDER_KEYS = Object.keys(ROLE_ORDER);

/* ------------------------------------------------------------------ */
/* Create / rename                                                     */
/* ------------------------------------------------------------------ */

function slugBase(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "workspace";
}

function uniqueSlug(name: string): string {
  const base = slugBase(name);
  let candidate = base;
  let attempt = 0;
  while (queryOne<{ id: string }>("SELECT id FROM workspaces WHERE slug = ?", candidate)) {
    attempt += 1;
    candidate = `${base}-${randomBytes(3).toString("hex")}`;
    if (attempt > 20) {
      candidate = `${base}-${randomBytes(6).toString("base64url").toLowerCase()}`;
      break;
    }
  }
  return candidate;
}

/** Create a workspace and make the caller its owner. */
export function createWorkspace(actor: Actor, name: string): WorkspaceView {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new HttpError(400, "BAD_REQUEST", "Give the workspace a name.");
  }
  if (trimmed.length > 80) {
    throw new HttpError(400, "BAD_REQUEST", "Workspace names are limited to 80 characters.");
  }
  const id = `ws_${randomBytes(9).toString("base64url")}`;
  const timestamp = now();
  sqlRun(
    "INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)",
    id,
    trimmed,
    uniqueSlug(trimmed),
    timestamp,
  );
  sqlRun(
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    id,
    actor.userId,
    timestamp,
  );
  const row = getWorkspace(id)!;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: "owner",
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function renameWorkspace(actor: ActorLike, name: string): WorkspaceView {
  requirePermission(actor, "workspace:update");
  const trimmed = name.trim();
  if (!trimmed) {
    throw new HttpError(400, "BAD_REQUEST", "Give the workspace a name.");
  }
  if (trimmed.length > 80) {
    throw new HttpError(400, "BAD_REQUEST", "Workspace names are limited to 80 characters.");
  }
  const row = getWorkspace(actor.workspaceId);
  if (!row) {
    throw new HttpError(404, "NOT_FOUND", "That workspace does not exist.");
  }
  sqlRun(
    "UPDATE workspaces SET name = ? WHERE id = ?",
    trimmed,
    actor.workspaceId,
  );
  return {
    id: row.id,
    name: trimmed,
    slug: row.slug,
    role: resolveRole(actor),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Membership mutations                                                */
/* ------------------------------------------------------------------ */

function resolveRole(actor: ActorLike): Role {
  const membership = membershipOf(actor);
  if (!membership) {
    throw new HttpError(403, "NOT_A_MEMBER", "You do not have access to this workspace.");
  }
  return membership.role;
}

function memberRow(workspaceId: string, userId: string): { role: Role; system: number } {
  const row = queryOne<{ role: string; system: number }>(
    `SELECT m.role, u.system FROM workspace_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.user_id = ?`,
    workspaceId,
    userId,
  );
  if (!row || !isRole(row.role)) {
    throw new HttpError(404, "NOT_FOUND", "That person is not in this workspace.");
  }
  return { role: row.role, system: row.system };
}

/**
 * Add an existing account to the workspace.
 *
 * There is no invitation mail infrastructure in KLYZ, so this is an
 * explicit "add by email" performed by an admin or owner — the honest
 * version of inviting, without inventing a mail queue.
 */
export function addMember(actor: ActorLike, email: string, role: string): MemberView {
  requirePermission(actor, "member:manage");
  const actorRoleValue = resolveRole(actor);
  if (!isRole(role)) {
    throw new HttpError(400, "BAD_REQUEST", "Unknown role.", { roles: [...ROLE_ORDER_KEYS] });
  }
  const requested = role as Role;
  /* You cannot hand out more than you hold. */
  if (ROLE_ORDER[requested] > ROLE_ORDER[actorRoleValue]) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `You cannot grant the ${requested} role from your own ${actorRoleValue} role.`,
    );
  }
  if (requested === "owner" && !can(actorRoleValue, "ownership:transfer")) {
    throw new HttpError(403, "FORBIDDEN", "Only an owner can grant the owner role.");
  }

  const normalised = email.trim().toLowerCase();
  const user = queryOne<{ id: string; name: string; email: string }>(
    "SELECT id, name, email FROM users WHERE email = ? COLLATE NOCASE",
    normalised,
  );
  if (!user) {
    throw new HttpError(
      404,
      "USER_NOT_FOUND",
      "No account with that email exists yet.",
      { hint: "Ask them to create an account first." },
    );
  }
  if (membershipOf({ userId: user.id, workspaceId: actor.workspaceId })) {
    throw new HttpError(409, "ALREADY_A_MEMBER", "That person is already in this workspace.");
  }
  sqlRun(
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    actor.workspaceId,
    user.id,
    requested,
    now(),
  );
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: requested,
    system: false,
    createdAt: new Date(now()).toISOString(),
  };
}

/**
 * Change a member's role.
 *
 * Guards: caller must hold `member:manage`, cannot grant above their
 * own role, cannot demote the workspace's last owner, and a non-owner
 * cannot touch an owner.
 */
export function changeMemberRole(actor: ActorLike, userId: string, role: string): MemberView {
  requirePermission(actor, "member:manage");
  const actorRoleValue = resolveRole(actor);
  if (!isRole(role)) {
    throw new HttpError(400, "BAD_REQUEST", "Unknown role.", { roles: [...ROLE_ORDER_KEYS] });
  }
  const next = role as Role;
  const target = memberRow(actor.workspaceId, userId);

  if (ROLE_ORDER[next] > ROLE_ORDER[actorRoleValue]) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `You cannot grant the ${next} role from your own ${actorRoleValue} role.`,
    );
  }
  if (next === "owner" && !can(actorRoleValue, "ownership:transfer")) {
    throw new HttpError(403, "FORBIDDEN", "Only an owner can grant the owner role.");
  }
  if (target.role === "owner" && actorRoleValue !== "owner" && userId !== actor.userId) {
    throw new HttpError(403, "FORBIDDEN", "Only an owner can change another owner's role.");
  }
  if (target.role === next) {
    throw new HttpError(409, "ROLE_UNCHANGED", "That member already has this role.");
  }
  if (target.role === "owner" && countOwners(actor.workspaceId) <= 1) {
    throw new HttpError(
      409,
      "LAST_OWNER",
      "This workspace needs at least one owner. Promote someone else first.",
    );
  }
  if (target.system === 1 && next !== "owner") {
    throw new HttpError(
      403,
      "SYSTEM_MEMBER",
      "The seeded workspace identity keeps its role.",
    );
  }

  sqlRun(
    "UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?",
    next,
    actor.workspaceId,
    userId,
  );
  const updated = memberRow(actor.workspaceId, userId);
  const user = queryOne<{ email: string; name: string }>(
    "SELECT email, name FROM users WHERE id = ?",
    userId,
  );
  return {
    userId,
    email: user?.email ?? "",
    name: user?.name ?? "",
    role: updated.role,
    system: updated.system === 1,
    createdAt: new Date(now()).toISOString(),
  };
}

export function removeMember(actor: ActorLike, userId: string): void {
  requirePermission(actor, "member:manage");
  const actorRoleValue = resolveRole(actor);
  const target = memberRow(actor.workspaceId, userId);

  if (userId === actor.userId) {
    throw new HttpError(400, "BAD_REQUEST", "You cannot remove yourself from a workspace.");
  }
  if (target.role === "owner" && actorRoleValue !== "owner") {
    throw new HttpError(403, "FORBIDDEN", "Only an owner can remove an owner.");
  }
  if (target.system === 1) {
    throw new HttpError(403, "SYSTEM_MEMBER", "The seeded workspace identity cannot be removed.");
  }
  if (target.role === "owner" && countOwners(actor.workspaceId) <= 1) {
    throw new HttpError(
      409,
      "LAST_OWNER",
      "This workspace needs at least one owner. Promote someone else first.",
    );
  }
  sqlRun(
    "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    actor.workspaceId,
    userId,
  );
}

/**
 * Ownership transfer: the target becomes owner and the actor steps down
 * to admin, so the workspace keeps exactly one acting owner after an
 * explicit hand-over and can never end up with none.
 */
export function transferOwnership(actor: ActorLike, userId: string): MemberView {
  const role = requirePermission(actor, "ownership:transfer");
  if (role !== "owner") {
    throw new HttpError(403, "FORBIDDEN", "Only an owner can transfer ownership.");
  }
  if (userId === actor.userId) {
    throw new HttpError(400, "BAD_REQUEST", "You already own this workspace.");
  }
  const target = memberRow(actor.workspaceId, userId);
  if (target.system === 1) {
    throw new HttpError(403, "SYSTEM_MEMBER", "Ownership cannot move to the seeded identity.");
  }

  sqlRun(
    "UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?",
    actor.workspaceId,
    userId,
  );
  sqlRun(
    "UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?",
    actor.workspaceId,
    actor.userId,
  );
  const updated = memberRow(actor.workspaceId, userId);
  const user = queryOne<{ email: string; name: string }>(
    "SELECT email, name FROM users WHERE id = ?",
    userId,
  );
  return {
    userId,
    email: user?.email ?? "",
    name: user?.name ?? "",
    role: updated.role,
    system: updated.system === 1,
    createdAt: new Date(now()).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Registration workspace resolution                                   */
/* ------------------------------------------------------------------ */

/**
 * Where an account lives.
 *
 * An existing membership always wins, so signing in can never move a
 * user between tenants. A brand-new account with nowhere to go falls
 * back to: adopt the seeded demo workspace if no sign-in-capable member
 * holds it yet (so a fresh install is not empty), otherwise create a
 * personal workspace — registration can therefore never widen access to
 * an existing tenant by accident.
 */
export function ensureWorkspaceFor(userId: string): string {
  ensureIdentitySeed();
  const existing = queryOne<{ workspace_id: string }>(
    "SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1",
    userId,
  );
  if (existing) return existing.workspace_id;

  const adopted = queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = 'ws_default' AND u.password_hash IS NOT NULL`,
  );
  if ((adopted?.total ?? 0) === 0) {
    sqlRun(
      "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_default', ?, 'owner', ?)",
      userId,
      now(),
    );
    const joined = queryOne<{ workspace_id: string }>(
      "SELECT workspace_id FROM workspace_members WHERE user_id = ?",
      userId,
    );
    if (joined) return joined.workspace_id;
  }
  return createWorkspace({ userId, workspaceId: "ws_default" }, "My workspace").id;
}
