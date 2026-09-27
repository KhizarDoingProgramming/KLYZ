import { randomBytes } from "node:crypto";
import { fromJson, now, queryAll, queryOne, run as sqlRun, toJson } from "./db";
import { redact } from "./redact";
import type { ActorLike } from "./authz";

/**
 * Workspace-aware audit trail.
 *
 * Security-relevant actions land here with *who*, *what* and *which
 * resource* — and with metadata passed through the same redaction the
 * debugger uses, so an audit row can never become a second copy of a
 * secret. Tokens, passwords, API keys and credential values are never
 * written: only ids, names, roles and outcomes.
 */

export type AuditAction =
  /* authentication */
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.registered"
  | "auth.session_revoked"
  /* workspace */
  | "workspace.created"
  | "workspace.updated"
  | "workspace.member_added"
  | "workspace.member_removed"
  | "workspace.role_changed"
  | "workspace.ownership_transferred"
  /* credentials */
  | "credential.created"
  | "credential.updated"
  | "credential.deleted"
  | "credential.tested"
  | "credential.used"
  /* workflows */
  | "workflow.created"
  | "workflow.updated"
  | "workflow.deleted"
  | "workflow.published"
  | "workflow.unpublished"
  | "workflow.version_created"
  | "workflow.version_restored"
  | "workflow.duplicated"
  | "workflow.exported"
  | "workflow.imported"
  | "workflow.created_from_template"
  /* templates — a workspace-scoped library, not a marketplace */
  | "template.created"
  | "template.updated"
  | "template.deleted"
  /* triggers — who armed, disarmed or moved a schedule */
  | "trigger.updated"
  | "trigger.enabled"
  | "trigger.disabled"
  | "trigger.invoked"
  | "schedule.executed"
  | "workflow.executed"
  /* executions */
  | "execution.started"
  | "execution.cancelled"
  | "execution.retried"
  /* integrations */
  | "integration.connected"
  | "integration.disconnected"
  | "integration.webhook_published"
  | "integration.webhook_removed"
  | "integration.watch_started"
  | "integration.watch_stopped"
  /* AI — spend and prompt volume are worth a row */
  | "ai.generate";

export interface AuditInput {
  workspaceId?: string | null;
  actorId?: string | null;
  action: AuditAction;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

const MAX_METADATA_CHARS = 4_000;

/**
 * Write one audit event. Never throws: a failed audit write must not
 * fail the operation it is describing (the write itself is a single
 * INSERT against a local table, so a failure means the disk is gone —
 * in which case the request is failing anyway).
 */
export function recordAudit(input: AuditInput): void {
  try {
    const metadata = input.metadata
      ? clampMetadata(redact(input.metadata) as Record<string, unknown>)
      : null;
    sqlRun(
      `INSERT INTO audit_events
         (id, workspace_id, actor_id, action, resource_type, resource_id, metadata, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `aud_${randomBytes(9).toString("base64url")}`,
      input.workspaceId ?? null,
      input.actorId ?? null,
      input.action,
      input.resourceType ?? null,
      input.resourceId ?? null,
      toJson(metadata),
      input.ip ?? null,
      input.userAgent ? input.userAgent.slice(0, 300) : null,
      now(),
    );
  } catch {
    /* auditing is best-effort by design — see doc comment */
  }
}

function clampMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(value);
  if (text.length <= MAX_METADATA_CHARS) return value;
  return { truncated: true, bytes: text.length };
}

/** Convenience: audit on behalf of an authenticated actor. */
export function auditAs(
  actor: ActorLike,
  action: AuditAction,
  fields: Omit<AuditInput, "action" | "actorId" | "workspaceId"> = {},
): void {
  recordAudit({ ...fields, action, actorId: actor.userId, workspaceId: actor.workspaceId });
}

export interface AuditView {
  id: string;
  action: string;
  actorId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface AuditQuery {
  limit?: number;
  action?: string | null;
}

const MAX_AUDIT_LIMIT = 200;

/** Workspace-scoped audit listing — only rows of the acting workspace. */
export function listAuditFor(actor: ActorLike, query: AuditQuery = {}): {
  events: AuditView[];
  total: number;
} {
  const limit = Math.min(
    Math.max(Math.trunc(Number(query.limit) || 50), 1),
    MAX_AUDIT_LIMIT,
  );
  const clauses = ["workspace_id = ?"];
  const params: Array<string | number> = [actor.workspaceId];
  if (query.action) {
    clauses.push("action = ?");
    params.push(query.action);
  }
  const where = clauses.join(" AND ");
  const total =
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM audit_events WHERE ${where}`,
      ...params,
    )?.total ?? 0;
  const rows = queryAll<{
    id: string;
    action: string;
    actor_id: string | null;
    resource_type: string | null;
    resource_id: string | null;
    metadata: string | null;
    ip: string | null;
    created_at: number;
  }>(
    `SELECT id, action, actor_id, resource_type, resource_id, metadata, ip, created_at
       FROM audit_events WHERE ${where}
      ORDER BY created_at DESC LIMIT ?`,
    ...params,
    limit,
  );
  return {
    total,
    events: rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorId: row.actor_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      metadata: row.metadata
        ? fromJson<Record<string, unknown> | null>(row.metadata, null)
        : null,
      ip: row.ip,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

/** Guard used by the audit tests: no field may hold a raw secret. */
export function auditMetadataIsSafe(metadata: Record<string, unknown> | null): boolean {
  if (!metadata) return true;
  const text = JSON.stringify(metadata);
  return !/(?:whsec_|sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|scrypt\$)/.test(text);
}
