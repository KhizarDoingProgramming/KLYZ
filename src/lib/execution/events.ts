import type { ExecutionError, ExecutionStatus } from "@/lib/workflow/types";
import type { ExecutionStepView } from "./types";

/**
 * Engine event stream.
 *
 * These events are the contract between the execution engine and
 * everything downstream: they are persisted (history is real), pushed
 * over SSE (the editor is live) and folded by the projector (canvas
 * state derives from data, never from timers). Transport-agnostic by
 * design — a queue can forward the same events later.
 */

export interface ExecutionStartedEvent {
  type: "execution.started";
  executionId: string;
  workflowId: string;
  workflowName: string;
  workspaceId: string;
  workflowVersionId: string;
  workflowVersion: number;
  trigger: { type: string; label: string };
  input: unknown;
  startedAt: string;
  at: number;
}

export interface ExecutionStatusEvent {
  type: "execution.status";
  executionId: string;
  status: Extract<ExecutionStatus, "queued" | "running" | "waiting">;
  at: number;
}

export interface NodeStartedEvent {
  type: "execution.node.started";
  executionId: string;
  step: ExecutionStepView;
  at: number;
}

export interface NodeCompletedEvent {
  type: "execution.node.completed";
  executionId: string;
  stepId: string;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  ref: string;
  durationMs: number;
  output: Record<string, unknown>;
  branch: string | null;
  attempt: number;
  /** Step telemetry (provider calls, timings) gathered while running. */
  metadata?: Record<string, unknown>;
  at: number;
}

export interface NodeFailedEvent {
  type: "execution.node.failed";
  executionId: string;
  stepId: string;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  ref: string;
  durationMs: number;
  error: ExecutionError;
  attempt: number;
  /** Step telemetry (provider calls, timings) gathered for this attempt. */
  metadata?: Record<string, unknown>;
  at: number;
}

/**
 * The engine is about to try this step again.
 *
 * Emitted from the real attempt loop, between the failure that triggered
 * it and the sleep that paces it — so the debugger can show *why* a step
 * is still running, which attempt is in flight and how long the wait is.
 */
export interface NodeRetryingEvent {
  type: "execution.node.retrying";
  executionId: string;
  stepId: string;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  ref: string;
  /** Attempt that just failed (1-based). */
  attempt: number;
  /** Attempt that is about to start. */
  nextAttempt: number;
  delayMs: number;
  error: ExecutionError;
  at: number;
}

/**
 * A step parked itself (delay, rate-limit wait, external job).
 *
 * `waiting: true` when it parks, `false` the moment it resumes — the
 * projector uses it to move the node between `running` and `waiting`
 * without inventing a state the engine never reported.
 */
export interface NodeWaitingEvent {
  type: "execution.node.waiting";
  executionId: string;
  stepId: string;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  ref: string;
  waiting: boolean;
  at: number;
}

export interface NodeSkippedEvent {
  type: "execution.node.skipped";
  executionId: string;
  stepId: string;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  ref: string;
  /** Which loop iteration this step belongs to, when it has one. */
  metadata?: Record<string, unknown>;
  at: number;
}

export interface ExecutionFinishedEvent {
  type: "execution.completed" | "execution.failed" | "execution.cancelled";
  executionId: string;
  status: Extract<ExecutionStatus, "completed" | "failed" | "cancelled">;
  durationMs: number;
  output: unknown;
  error?: ExecutionError;
  metadata: Record<string, unknown>;
  completedAt: string;
  at: number;
}

export type EngineEvent =
  | ExecutionStartedEvent
  | ExecutionStatusEvent
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeRetryingEvent
  | NodeWaitingEvent
  | NodeFailedEvent
  | NodeSkippedEvent
  | ExecutionFinishedEvent;

export function isEngineEvent(value: unknown): value is EngineEvent {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("execution.");
}

export function isFinishedEvent(
  event: EngineEvent,
): event is ExecutionFinishedEvent {
  return (
    event.type === "execution.completed" ||
    event.type === "execution.failed" ||
    event.type === "execution.cancelled"
  );
}
