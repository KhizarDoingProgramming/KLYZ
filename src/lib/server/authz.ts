import { HttpError } from "./http";
import { queryOne } from "./db";
import {
  assertMember,
  isRole,
  membershipOf,
  type Actor,
  type Role,
} from "./identity";

/**
 * The authorization layer.
 *
 * Every route asks this module for a permission; nothing decides on its
 * own whether a role is "probably fine". Two rules hold everywhere:
 *
 *  1. **Workspace first.** No resource is looked up before the caller's
 *     membership of the acting workspace is proven, so an id from
 *     another tenant is a 403/404 and never a row.
 *  2. **Server-side only.** Hiding a button is not a control; the API
 *     refuses the mutation regardless of what the UI showed.
 */

/* ------------------------------------------------------------------ */
/* Roles and permissions                                               */
/* ------------------------------------------------------------------ */

export const ROLE_ORDER: Record<Role, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export type Permission =
  /* read surfaces */
  | "workflow:read"
  | "execution:read"
  | "credential:read"
  | "integration:read"
  | "webhook:read"
  | "member:read"
  | "queue:read"
  | "audit:read"
  /* authoring */
  | "workflow:write"
  | "workflow:delete"
  | "workflow:publish"
  | "execution:run"
  | "execution:cancel"
  | "credential:use"
  | "ai:use"
  /* administration */
  | "credential:manage"
  | "integration:manage"
  | "webhook:manage"
  | "member:manage"
  | "workspace:update"
  | "workspace:manage"
  | "ownership:transfer";

const VIEWER: Permission[] = [
  "workflow:read",
  "execution:read",
  "integration:read",
  "member:read",
];

const MEMBER: Permission[] = [
  ...VIEWER,
  "workflow:write",
  "workflow:publish",
  "execution:run",
  "execution:cancel",
  "credential:read",
  "credential:use",
  "webhook:read",
  "queue:read",
  "ai:use",
];

const ADMIN: Permission[] = [
  ...MEMBER,
  "workflow:delete",
  "credential:manage",
  "integration:manage",
  "webhook:manage",
  "member:manage",
  "workspace:update",
  "audit:read",
];

const OWNER: Permission[] = [...ADMIN, "workspace:manage", "ownership:transfer"];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  member: new Set(MEMBER),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[minimum];
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/* ------------------------------------------------------------------ */
/* Request-level gates                                                 */
/* ------------------------------------------------------------------ */

export type ActorLike = Actor & { role?: Role };

function roleOf(actor: ActorLike): Role {
  if (actor.role && isRole(actor.role)) return actor.role;
  const membership = membershipOf(actor);
  if (!membership) {
    throw new HttpError(
      403,
      "NOT_A_MEMBER",
      "You do not have access to this workspace.",
    );
  }
  return membership.role;
}

/**
 * Require a permission in the actor's workspace. Returns the role so a
 * caller can branch on it without a second lookup.
 */
export function requirePermission(actor: ActorLike, permission: Permission): Role {
  const role = roleOf(actor);
  if (!can(role, permission)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Your role (${role}) cannot perform this action.`,
      { required: permission, role },
    );
  }
  return role;
}

/** Require at least this role in the actor's workspace. */
export function requireWorkspaceRole(actor: ActorLike, minimum: Role): Role {
  const role = roleOf(actor);
  if (!roleAtLeast(role, minimum)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `This action requires the ${minimum} role or higher.`,
      { required: minimum, role },
    );
  }
  return role;
}

/** Membership of the acting workspace, proven before any resource read. */
export function requireWorkspaceMember(actor: ActorLike): Role {
  return assertMember(actor).role;
}

/* ------------------------------------------------------------------ */
/* Resource ownership                                                  */
/* ------------------------------------------------------------------ */

const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Shape check for an id arriving in a path, query or body.
 *
 * Ids are compared with bound parameters everywhere, so this is not an
 * injection guard — it is a cheap way to reject junk before it reaches
 * a query plan, and it keeps odd characters out of audit rows and logs.
 */
export function assertResourceId(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !RESOURCE_ID.test(value)) {
    throw new HttpError(400, "BAD_ID", `That ${label} is not valid.`);
  }
  return value;
}

/**
 * A workflow id may name a *new* workflow (the editor posts a definition
 * it has never run before), so absence is fine — but a row owned by
 * another tenant must be indistinguishable from absence, never a 403
 * that confirms the id exists.
 */
export function assertWorkflowUsable(actor: ActorLike, workflowId: string): void {
  const row = queryOne<{ workspace_id: string }>(
    "SELECT workspace_id FROM workflows WHERE id = ?",
    workflowId,
  );
  if (row && row.workspace_id !== actor.workspaceId) {
    throw new HttpError(404, "NOT_FOUND", "That workflow does not exist.");
  }
}

/**
 * Workflow access.
 *
 * The row must exist *and* belong to the acting workspace: a workflow id
 * from another tenant resolves to 404 exactly like a typo, so ids cannot
 * be enumerated across tenants.
 */
export function assertWorkflowAccess(
  actor: ActorLike,
  workflowId: string,
  permission: Permission,
): { id: string; workspaceId: string; name: string; status: string } {
  requirePermission(actor, permission);
  const row = queryOne<{
    id: string;
    workspace_id: string;
    name: string;
    status: string;
  }>(
    "SELECT id, workspace_id, name, status FROM workflows WHERE id = ?",
    workflowId,
  );
  if (!row || row.workspace_id !== actor.workspaceId) {
    throw new HttpError(404, "NOT_FOUND", "That workflow does not exist.");
  }
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, status: row.status };
}

/** Workflow version access — versions inherit their workflow's tenant. */
export function assertWorkflowVersionAccess(
  actor: ActorLike,
  versionId: string,
  permission: Permission,
): { id: string; workflowId: string; workspaceId: string; version: number } {
  requirePermission(actor, permission);
  const row = queryOne<{
    id: string;
    workflow_id: string;
    workspace_id: string;
    version: number;
  }>(
    "SELECT id, workflow_id, workspace_id, version FROM workflow_versions WHERE id = ?",
    versionId,
  );
  if (!row || row.workspace_id !== actor.workspaceId) {
    throw new HttpError(404, "NOT_FOUND", "That workflow version does not exist.");
  }
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workspaceId: row.workspace_id,
    version: row.version,
  };
}

/**
 * Execution access.
 *
 * Executions carry their own `workspace_id`, so the check is a single
 * indexed read with no traversal — and the caller's *role* is enforced
 * in the same call, which is what stops a viewer from cancelling a run.
 */
export function assertExecutionAccess(
  actor: ActorLike,
  executionId: string,
  permission: Permission,
): { id: string; workspaceId: string; workflowId: string; status: string } {
  requirePermission(actor, permission);
  const row = queryOne<{
    id: string;
    workspace_id: string;
    workflow_id: string;
    status: string;
  }>(
    "SELECT id, workspace_id, workflow_id, status FROM executions WHERE id = ?",
    executionId,
  );
  if (!row || row.workspace_id !== actor.workspaceId) {
    throw new HttpError(404, "NOT_FOUND", "That execution does not exist.");
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    status: row.status,
  };
}

export function assertCredentialAccess(
  actor: ActorLike,
  credentialId: string,
  permission: Permission,
): { id: string; workspaceId: string } {
  requirePermission(actor, permission);
  const row = queryOne<{ id: string; workspace_id: string }>(
    "SELECT id, workspace_id FROM credentials WHERE id = ?",
    credentialId,
  );
  if (!row || row.workspace_id !== actor.workspaceId) {
    throw new HttpError(404, "NOT_FOUND", "That credential does not exist.");
  }
  return { id: row.id, workspaceId: row.workspace_id };
}

export function assertWebhookAccess(
  actor: ActorLike,
  webhookId: string,
  permission: Permission,
): { id: string; workspaceId: string; workflowId: string } {
  requirePermission(actor, permission);
  const row = queryOne<{ id: string; workspace_id: string; workflow_id: string }>(
    "SELECT id, workspace_id, workflow_id FROM webhooks WHERE id = ?",
    webhookId,
  );
  if (!row || row.workspace_id !== actor.workspaceId) {
    throw new HttpError(404, "NOT_FOUND", "That endpoint does not exist.");
  }
  return { id: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id };
}

/** Every workspace-scoped read starts by proving the membership. */
export function assertWorkspaceAccess(actor: ActorLike, permission?: Permission): Role {
  const role = requireWorkspaceMember(actor);
  if (permission && !can(role, permission)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Your role (${role}) cannot perform this action.`,
      { required: permission, role },
    );
  }
  return role;
}
