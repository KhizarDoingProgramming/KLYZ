import type { ValidationIssue, Workflow } from "@/lib/workflow/types";
import type { ExecutionDetail, ExecutionStepView, ExecutionView } from "./types";

/**
 * Typed client for the execution API.
 *
 * Everything the browser knows about runs comes through here — start,
 * list, inspect, cancel, subscribe. No demo data, no local simulation.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[];

  constructor(status: number, code: string, message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

interface ErrorPayload {
  error?: { code?: string; message?: string; details?: { issues?: ValidationIssue[] } };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Could not reach the execution service.");
  }

  const payload = (await response.json().catch(() => null)) as (ErrorPayload & T) | null;
  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? `Request failed (${response.status}).`,
      error?.details?.issues ?? [],
    );
  }
  return payload as T;
}

export interface StartExecutionBody {
  /**
   * Run input. The workflow graph is deliberately absent: the server
   * resolves it from the workflow id and pins the run to a published
   * version, so a client can never ask the server to execute a
   * definition nobody has seen.
   */
  input?: unknown;
  options?: { maxAttempts?: number; stepTimeoutMs?: number };
}

export async function startExecution(
  workflowId: string,
  body: StartExecutionBody,
): Promise<ExecutionDetail> {
  const payload = await request<{ execution: ExecutionDetail }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/execute`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return payload.execution;
}

export interface ListParams {
  workflowId?: string;
  status?: string;
  active?: boolean;
  source?: "manual" | "seed";
  limit?: number;
}

export async function listExecutions(
  params: ListParams = {},
): Promise<{ executions: ExecutionView[]; total: number }> {
  const query = new URLSearchParams();
  if (params.workflowId) query.set("workflowId", params.workflowId);
  if (params.status) query.set("status", params.status);
  if (params.active) query.set("active", "1");
  if (params.source) query.set("source", params.source);
  if (params.limit) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return request(`/api/executions${suffix ? `?${suffix}` : ""}`);
}

export async function getExecution(id: string): Promise<ExecutionDetail> {
  const payload = await request<{ execution: ExecutionDetail }>(
    `/api/executions/${encodeURIComponent(id)}`,
  );
  return payload.execution;
}

export async function getExecutionSteps(id: string): Promise<ExecutionStepView[]> {
  const payload = await request<{ steps: ExecutionStepView[] }>(
    `/api/executions/${encodeURIComponent(id)}/steps`,
  );
  return payload.steps;
}

export async function cancelExecution(
  id: string,
): Promise<{ accepted: boolean; status: string }> {
  return request(`/api/executions/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
}

export function executionEventsUrl(id: string): string {
  return `/api/executions/${encodeURIComponent(id)}/events`;
}

/** The graph a run pinned — what the execution canvas draws. */
export interface ExecutionDefinition {
  workflowId: string;
  workflowVersion: number;
  workflowVersionId: string;
  name: string;
  nodes: Workflow["nodes"];
  edges: Workflow["edges"];
}

export async function getExecutionDefinition(
  id: string,
): Promise<ExecutionDefinition> {
  const payload = await request<{ definition: ExecutionDefinition }>(
    `/api/executions/${encodeURIComponent(id)}/definition`,
  );
  return payload.definition;
}

export interface RerunBody {
  options?: { maxAttempts?: number; stepTimeoutMs?: number };
}

/** Start a fresh execution from the version and input of an existing one. */
export async function rerunExecution(
  id: string,
  body: RerunBody = {},
): Promise<ExecutionDetail> {
  const payload = await request<{ execution: ExecutionDetail }>(
    `/api/executions/${encodeURIComponent(id)}/rerun`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return payload.execution;
}
