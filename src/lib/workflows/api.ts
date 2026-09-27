import type {
  PortableIssue,
  PortableWorkflow,
  CredentialRequirement,
} from "@/lib/workflow/portable";
import type {
  ValidationIssue,
  Workflow,
  WorkflowDocument,
  WorkflowVersionInfo,
} from "@/lib/workflow/types";

/**
 * Typed client for the workflow API.
 *
 * The server owns workflow records: this module never keeps a
 * definition that the API has not acknowledged. Every call returns the
 * server's copy so the editor can adopt it (including the revision it
 * must send back next time).
 */

export class WorkflowApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[];
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkflowApiError";
    this.status = status;
    this.code = code;
    this.issues = Array.isArray(details.issues)
      ? (details.issues as ValidationIssue[])
      : [];
    this.details = details;
  }
}

interface ErrorPayload {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch {
    throw new WorkflowApiError(0, "NETWORK", "Could not reach the workflow service.");
  }
  const payload = (await response.json().catch(() => null)) as (ErrorPayload & T) | null;
  if (!response.ok) {
    const error = payload?.error;
    throw new WorkflowApiError(
      response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? `Request failed (${response.status}).`,
      error?.details ?? {},
    );
  }
  return payload as T;
}

const BASE = "/api/workflows";

function url(id?: string): string {
  return id ? `${BASE}/${encodeURIComponent(id)}` : BASE;
}

export type SaveDraftResult =
  | { workflow: WorkflowDocument; conflict: null }
  | { workflow: null; conflict: { revision: number; workflow: WorkflowDocument } };

export async function listWorkflows(): Promise<WorkflowDocument[]> {
  const payload = await request<{ workflows: WorkflowDocument[] }>(url());
  return payload.workflows ?? [];
}

export async function getWorkflow(id: string): Promise<WorkflowDocument> {
  const payload = await request<{ workflow: WorkflowDocument }>(url(id));
  return payload.workflow;
}

export async function createWorkflow(input: {
  name?: string;
  definition?: Workflow;
}): Promise<WorkflowDocument> {
  const payload = await request<{ workflow: WorkflowDocument }>(url(), {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.workflow;
}

export async function saveDraft(
  id: string,
  definition: Workflow,
  revision: number,
): Promise<SaveDraftResult> {
  try {
    const payload = await request<{ workflow: WorkflowDocument }>(`${url(id)}/draft`, {
      method: "PUT",
      body: JSON.stringify({ definition, revision }),
    });
    return { workflow: payload.workflow, conflict: null };
  } catch (error) {
    if (error instanceof WorkflowApiError && error.code === "REVISION_CONFLICT") {
      const workflow = error.details.workflow as WorkflowDocument | undefined;
      if (workflow) {
        return { workflow: null, conflict: { revision: workflow.revision, workflow } };
      }
    }
    throw error;
  }
}

export async function updateWorkflow(
  id: string,
  patch: Record<string, unknown>,
): Promise<WorkflowDocument> {
  const payload = await request<{ workflow: WorkflowDocument }>(url(id), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return payload.workflow;
}

export async function archiveWorkflow(id: string): Promise<void> {
  await request<{ ok: boolean }>(url(id), { method: "DELETE" });
}

export async function duplicateWorkflow(id: string): Promise<WorkflowDocument> {
  const payload = await request<{ workflow: WorkflowDocument }>(`${url(id)}/duplicate`, {
    method: "POST",
  });
  return payload.workflow;
}

export async function publishWorkflow(
  id: string,
): Promise<{ workflow: WorkflowDocument; version: WorkflowVersionInfo }> {
  return request(`${url(id)}/publish`, { method: "POST" });
}

export async function listVersions(id: string): Promise<WorkflowVersionInfo[]> {
  const payload = await request<{ versions: WorkflowVersionInfo[] }>(`${url(id)}/versions`);
  return payload.versions ?? [];
}

export async function restoreVersion(
  id: string,
  versionId: string,
): Promise<WorkflowDocument> {
  const payload = await request<{ workflow: WorkflowDocument }>(`${url(id)}/versions`, {
    method: "POST",
    body: JSON.stringify({ versionId }),
  });
  return payload.workflow;
}

/* ------------------------------------------------------------------ */
/* Portability                                                         */
/* ------------------------------------------------------------------ */

export interface WorkflowExport {
  portable: PortableWorkflow;
  filename: string;
  source: "draft" | "version";
  nodeCount: number;
  warnings: PortableIssue[];
}

export interface ImportSummary {
  name: string;
  description: string;
  triggerType: string;
  nodeCount: number;
  edgeCount: number;
  integrations: string[];
  credentialKinds: string[];
  steps: Array<{ id: string; type: string; label: string }>;
}

export interface ImportOutcome {
  workflow: WorkflowDocument | null;
  summary: ImportSummary;
  requirements: CredentialRequirement[];
  warnings: PortableIssue[];
  dryRun: boolean;
}

/** Download the portable document for a draft or one published version. */
export async function exportWorkflow(
  id: string,
  versionId?: string,
): Promise<WorkflowExport> {
  const query = versionId ? `?version=${encodeURIComponent(versionId)}` : "";
  const payload = await request<{ export: WorkflowExport }>(
    `${url(id)}/export${query}`,
  );
  return payload.export;
}

/** Read a portable document without writing anything. */
export async function previewImport(
  definition: unknown,
): Promise<ImportOutcome> {
  return request<ImportOutcome>("/api/workflows/import", {
    method: "POST",
    body: JSON.stringify({ definition, dryRun: true }),
  });
}

/** Import a portable document as a new, unpublished draft. */
export async function importWorkflow(input: {
  definition: unknown;
  name?: string;
  credentials?: Record<string, string>;
}): Promise<ImportOutcome> {
  return request<ImportOutcome>("/api/workflows/import", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Store a workflow's draft in this workspace's template library. */
export async function saveWorkflowAsTemplate(
  id: string,
  input: { name?: string; description?: string; category?: string },
): Promise<TemplateSummary> {
  const payload = await request<{ template: TemplateSummary }>(`${url(id)}/template`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.template;
}

/** The part of a template the list UI needs. */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  system: boolean;
  nodeCount: number;
  triggerType: string;
  integrations: string[];
  requiredCredentials: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
