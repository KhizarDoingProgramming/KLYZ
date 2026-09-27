import type { ExecutionError, Workflow } from "@/lib/workflow/types";
import type { DataScope } from "@/lib/workflow/expressions";
import type { ExecutionStepView } from "@/lib/execution/types";
import type { EngineEvent } from "@/lib/execution/events";

/**
 * Engine-internal types.
 *
 * The executor is transport- and framework-independent: it receives a
 * workflow definition, an input payload, an abort signal and an event
 * sink, and returns a result. Route handlers, queues and tests all
 * drive it the same way.
 */

/** Structured, non-retryable-by-default failure raised inside the engine. */
export class EngineError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly httpStatus?: number;
  readonly hint?: string;
  readonly remediation?: ExecutionError["remediation"];
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: {
      detail?: string;
      httpStatus?: number;
      hint?: string;
      remediation?: ExecutionError["remediation"];
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EngineError";
    this.code = code;
    this.detail = options.detail;
    this.httpStatus = options.httpStatus;
    this.hint = options.hint;
    this.remediation = options.remediation;
    this.retryable = options.retryable ?? false;
  }

  toExecutionError(): ExecutionError {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail,
      status: this.httpStatus,
      hint: this.hint,
      remediation: this.remediation,
    };
  }
}

/** Raised cooperatively when the execution's abort signal fires. */
export class CancelledError extends Error {
  constructor() {
    super("The execution was cancelled.");
    this.name = "CancelledError";
  }
}

export interface NodeHandlerResult {
  output: Record<string, unknown>;
  /** Named outgoing branch to take, for nodes with branch edges. */
  branch?: string | null;
  /**
   * The step did not let data through (Filter with "Mark step as
   * skipped"). The engine records it as `skipped`, so every outgoing
   * edge reads as untaken and the branch silently stops — exactly the
   * state a hand-traced run would produce.
   */
  skipped?: boolean;
  /**
   * End the run here, successfully (Filter with "Stop the workflow").
   * Nothing downstream runs and no failure is recorded.
   */
  stop?: boolean;
}

export interface NodeRunContext {
  executionId: string;
  /** Workspace the run belongs to — credential lookups are scoped by it. */
  workspaceId: string;
  workflow: Workflow;
  nodeId: string;
  nodeType: string;
  /** Config with every `{{…}}` expression resolved against the run scope. */
  config: Record<string, unknown>;
  /**
   * The node's config exactly as authored. Handlers that evaluate
   * expressions per item (Transform operations) resolve from here — the
   * outer pass has already consumed `{{item.…}}` against a scope that
   * has no item yet.
   */
  rawConfig: Record<string, unknown>;
  /** Upstream step outputs by ref, plus `trigger` and `context`. */
  scope: DataScope;
  /** Payload supplied to this run (manual input). */
  triggerInput: unknown;
  attempt: number;
  signal: AbortSignal;
  /** Publishes a queued/running/waiting status transition for the execution. */
  publishStatus: (status: "queued" | "running" | "waiting") => void;
}

export type NodeHandler = (
  context: NodeRunContext,
) => Promise<NodeHandlerResult> | NodeHandlerResult;

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export interface ExecuteOptions {
  executionId: string;
  workspaceId: string;
  workflow: Workflow;
  workflowVersionId: string;
  workflowVersion: number;
  input: unknown;
  retry?: Partial<RetryPolicy>;
  stepTimeoutMs?: number;
  /** Who started this run (`manual`, `webhook`, `seed`) — surfaced in the run scope. */
  source?: string;
  emit: (event: EngineEvent) => void;
  signal: AbortSignal;
}

export type ExecuteStatus = "completed" | "failed" | "cancelled";

export interface ExecuteResult {
  status: ExecuteStatus;
  durationMs: number;
  output: unknown;
  error?: ExecutionError;
  metadata: Record<string, unknown>;
  steps: ExecutionStepView[];
}
