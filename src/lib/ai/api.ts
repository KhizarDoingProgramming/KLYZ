import type {
  AiStatusResult,
  ExplainExecutionResult,
  ExplainWorkflowResult,
  PlanResult,
} from "./result";
import type { WorkflowPlan } from "./plan";
import type { Workflow } from "@/lib/workflow/types";

/**
 * Typed client for the AI builder API.
 *
 * Same shape as the execution client: one request helper, one error
 * type, every call cancellable via `AbortSignal` so leaving the page (or
 * pressing Stop) really aborts the round-trip instead of leaving the UI
 * pretending to think.
 */

export class AiApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AiApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ErrorPayload {
  error?: { code?: string; message?: string; details?: unknown };
}

async function request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw new AiApiError(0, "ABORTED", "The request was cancelled.");
    throw new AiApiError(
      0,
      "NETWORK",
      `Could not reach the AI service: ${error instanceof Error ? error.message : "network error"}`,
    );
  }

  const payload = (await response.json().catch(() => null)) as (ErrorPayload & T) | null;
  if (!response.ok) {
    const error = payload?.error;
    throw new AiApiError(
      response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? `Request failed (${response.status}).`,
      error?.details,
    );
  }
  return payload as T;
}

export interface GenerateBody {
  intent: string;
  workflow?: Workflow;
}

export function generatePlan(body: GenerateBody, signal?: AbortSignal): Promise<PlanResult> {
  return request<PlanResult>("/api/ai/workflows/generate", body, signal);
}

export interface RefineBody {
  intent: string;
  plan: WorkflowPlan;
  feedback: string;
  workflow?: Workflow;
}

export function refinePlan(body: RefineBody, signal?: AbortSignal): Promise<PlanResult> {
  return request<PlanResult>("/api/ai/workflows/refine", body, signal);
}

export interface ExplainWorkflowBody {
  workflow: Workflow;
  nodeId?: string;
}

export function explainWorkflow(
  body: ExplainWorkflowBody,
  signal?: AbortSignal,
): Promise<ExplainWorkflowResult> {
  return request<ExplainWorkflowResult>("/api/ai/workflows/explain", body, signal);
}

export function explainExecution(
  executionId: string,
  signal?: AbortSignal,
): Promise<ExplainExecutionResult> {
  return request<ExplainExecutionResult>(
    `/api/ai/executions/${encodeURIComponent(executionId)}/explain`,
    {},
    signal,
  );
}

/** Configuration state. Uses GET, so it has its own tiny helper. */
export async function getAiStatus(signal?: AbortSignal): Promise<AiStatusResult> {
  let response: Response;
  try {
    response = await fetch("/api/ai/status", { cache: "no-store", ...(signal ? { signal } : {}) });
  } catch {
    throw new AiApiError(0, "NETWORK", "Could not reach the AI service.");
  }
  const payload = (await response.json().catch(() => null)) as (ErrorPayload & AiStatusResult) | null;
  if (!response.ok) {
    const error = payload?.error;
    throw new AiApiError(
      response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? `Request failed (${response.status}).`,
      error?.details,
    );
  }
  return payload as AiStatusResult;
}
