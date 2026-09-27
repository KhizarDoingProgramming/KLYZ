import {
  getExecutionDetailFor,
  listExecutionsFor,
} from "./execution-service";
import type { Actor } from "./identity";
import { iso, queryAll } from "./db";
import type { ExecutionDetail } from "@/lib/execution/types";

/**
 * Server-side dashboard aggregates.
 *
 * Everything here reads the same tables the execution service writes —
 * no fixtures, no client-side demo arrays. Used by the dashboard server
 * component so first paint already carries real numbers.
 *
 * Every function takes the actor explicitly: the dashboard must never
 * fall back to a default tenant, or one workspace would see another
 * workspace's runs.
 */

export interface WorkspaceMetrics {
  activeWorkflows: number;
  totalWorkflows: number;
  runsToday: number;
  successRate: number | null;
  failures: number;
  oldestFailureHours: number | null;
}

export interface WorkflowHealthRow {
  id: string;
  name: string;
  status: string;
  triggerType: string;
  executionCount: number;
  successRate: number | null;
  lastExecutedAt: string | null;
}

export interface DashboardSnapshot {
  metrics: WorkspaceMetrics;
  latest: ExecutionDetail | null;
  attention: ExecutionDetail[];
  recent: ExecutionDetail[];
  health: WorkflowHealthRow[];
}

function startOfToday(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function getWorkspaceMetrics(actor: Actor): WorkspaceMetrics {
  const since = startOfToday();

  const workflowCounts = queryAll<{ total: number; active: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
     FROM workflows WHERE workspace_id = ?`,
    actor.workspaceId,
  )[0];

  const today = queryAll<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM executions
     WHERE workspace_id = ? AND started_at >= ?
     GROUP BY status`,
    actor.workspaceId,
    since,
  );
  const todayByStatus = new Map(today.map((row) => [row.status, row.count]));
  const completedToday = todayByStatus.get("completed") ?? 0;
  const failedToday = todayByStatus.get("failed") ?? 0;
  const finishedToday = completedToday + failedToday;

  const failures = queryAll<{ count: number; oldest: number | null }>(
    `SELECT COUNT(*) AS count, MIN(started_at) AS oldest FROM executions
     WHERE workspace_id = ? AND status = 'failed'`,
    actor.workspaceId,
  )[0];

  return {
    activeWorkflows: workflowCounts?.active ?? 0,
    totalWorkflows: workflowCounts?.total ?? 0,
    runsToday: today.reduce((sum, row) => sum + row.count, 0),
    successRate: finishedToday
      ? Math.round((completedToday / finishedToday) * 100)
      : null,
    failures: failures?.count ?? 0,
    oldestFailureHours:
      failures?.oldest != null
        ? Math.max(1, Math.round((Date.now() - failures.oldest) / 3_600_000))
        : null,
  };
}

export function getWorkflowHealth(actor: Actor, limit = 6): WorkflowHealthRow[] {
  const rows = queryAll<{
    id: string;
    name: string;
    status: string;
    trigger_type: string;
    execution_count: number;
    completed_count: number;
    finished_count: number;
    last_at: number | null;
  }>(
    `SELECT w.id, w.name, w.status, w.trigger_type,
            COUNT(e.id) AS execution_count,
            SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
            SUM(CASE WHEN e.status IN ('completed', 'failed') THEN 1 ELSE 0 END) AS finished_count,
            MAX(e.started_at) AS last_at
     FROM workflows w
     LEFT JOIN executions e ON e.workflow_id = w.id AND e.workspace_id = w.workspace_id
     WHERE w.workspace_id = ?
     GROUP BY w.id
     ORDER BY (last_at IS NULL), last_at DESC, w.updated_at DESC
     LIMIT ?`,
    actor.workspaceId,
    limit,
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    triggerType: row.trigger_type,
    executionCount: row.execution_count,
    successRate:
      row.finished_count > 0
        ? Math.round((row.completed_count / row.finished_count) * 1000) / 10
        : null,
    lastExecutedAt: iso(row.last_at),
  }));
}

/** Full dashboard payload: metrics + the runs the panels render. */
export function getDashboardSnapshot(actor: Actor): DashboardSnapshot {
  const { executions } = listExecutionsFor(
    actor,
    new URLSearchParams({ limit: "30" }),
  );

  const details = (ids: string[], limit: number): ExecutionDetail[] => {
    const out: ExecutionDetail[] = [];
    for (const id of ids) {
      if (out.length >= limit) break;
      try {
        out.push(getExecutionDetailFor(actor, id));
      } catch {
        /* row vanished between list and detail — skip */
      }
    }
    return out;
  };

  const recentIds = executions.slice(0, 7).map((row) => row.id);
  const latestId = executions[0]?.id ?? null;
  const attentionIds = executions
    .filter((row) => row.status === "failed")
    .slice(0, 3)
    .map((row) => row.id);

  const latest = latestId
    ? (details([latestId], 1)[0] ?? null)
    : null;

  return {
    metrics: getWorkspaceMetrics(actor),
    latest,
    attention: details(attentionIds, 3),
    recent: details(recentIds, 7),
    health: getWorkflowHealth(actor),
  };
}
