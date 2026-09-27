import type {
  EdgeStatus,
  ExecutionError,
  ExecutionStatus,
  NodeStatus,
} from "@/lib/workflow/types";

/**
 * Shared shapes for what actually happened during an execution.
 *
 * The API returns these, the SSE stream carries events that fold into
 * them, and the editor, dashboard and history pages all render them —
 * one vocabulary from the engine to the pixels.
 */

export interface ExecutionStepView {
  /** Stable per-execution step id (`st_…`). Skeleton steps use `pending:<nodeId>`. */
  id: string;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  ref: string;
  status: NodeStatus;
  /** 1-based attempt counter for the step's last start. */
  attempt: number;
  /** Epoch ms — null while pending. */
  startedAtMs: number | null;
  /** Epoch ms — null until settled. */
  completedAtMs: number | null;
  durationMs: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error?: ExecutionError;
  /**
   * What the step did behind the scenes — provider calls (method, path,
   * status, duration), attempt timings, truncation markers. Never holds
   * credentials: events are redacted on the way out of the engine.
   */
  metadata?: Record<string, unknown> | null;
  /** Named branch this step routed to (`true`/`false`/case), when it has branch edges. */
  branch?: string | null;
}

export interface ExecutionPlanEdge {
  id: string;
  source: string;
  target: string;
  branch?: string;
}

/** Live view-model of one execution, as the editor renders it. */
export interface ExecutionPlan {
  edges: ExecutionPlanEdge[];
  steps: ExecutionStepView[];
  nodeStates: Record<string, NodeStatus>;
  edgeStates: Record<string, EdgeStatus>;
  durationMs: number;
  status: ExecutionStatus;
  /** Count of settled steps — the index of the step currently running. */
  revealed: number;
}

/** Execution summary — what list rows and dashboard panels render. */
export interface ExecutionView {
  id: string;
  workflowId: string;
  workflowName: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  trigger: { type: string; label: string };
  /** How the run was started: `manual` = launched from the editor, `webhook` = delivered by an endpoint, `schedule` = fired by the schedule loop, `seed` = clearly marked development seed data. */
  source: "manual" | "webhook" | "schedule" | "seed";
  stepCount: number;
  failedStepCount: number;
  /** Failure summary for the row — the same shape the step inspector renders. */
  error?: ExecutionError;
  /** A cancel has been requested but the run has not settled yet. */
  cancelRequested?: boolean;
  note?: string;
}

/** Full execution record with per-step detail. */
export interface ExecutionDetail extends ExecutionView {
  input: unknown;
  output: unknown;
  workflowVersion: number;
  /** The immutable `workflow_versions` row this run is pinned to. Set on every row read back from the database. */
  workflowVersionId?: string;
  metadata: Record<string, unknown>;
  steps: ExecutionStepView[];
}
