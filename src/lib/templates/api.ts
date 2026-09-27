import {
  request,
  type ImportOutcome,
  type TemplateSummary,
} from "@/lib/workflows/api";

/**
 * Client for the workspace template library.
 *
 * Templates are the same artifact as an exported file, so the shapes
 * here are the portable ones — there is no second schema to keep in
 * sync with the server.
 */

export type { TemplateSummary };

const BASE = "/api/templates";

function url(id?: string): string {
  return id ? `${BASE}/${encodeURIComponent(id)}` : BASE;
}

export interface TemplateDetail {
  template: TemplateSummary;
  portable: import("@/lib/workflow/portable").PortableWorkflow;
}

export async function listTemplates(options: {
  category?: string;
  query?: string;
} = {}): Promise<TemplateSummary[]> {
  const params = new URLSearchParams();
  if (options.category && options.category !== "all") params.set("category", options.category);
  if (options.query) params.set("q", options.query);
  const query = params.toString();
  const payload = await request<{ templates: TemplateSummary[] }>(
    `${BASE}${query ? `?${query}` : ""}`,
  );
  return payload.templates ?? [];
}

export async function getTemplate(id: string): Promise<TemplateDetail> {
  return request<TemplateDetail>(url(id));
}

export async function createTemplate(input: {
  name?: string;
  description?: string;
  category?: string;
  definition?: unknown;
  workflowId?: string;
}): Promise<TemplateSummary> {
  const payload = await request<{ template: TemplateSummary }>(BASE, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.template;
}

export async function updateTemplate(
  id: string,
  patch: { name?: string; description?: string; category?: string; icon?: string },
): Promise<TemplateSummary> {
  const payload = await request<{ template: TemplateSummary }>(url(id), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return payload.template;
}

export async function deleteTemplate(id: string): Promise<void> {
  await request<{ ok: boolean }>(url(id), { method: "DELETE" });
}

/** Turn a blueprint into a fresh, unpublished draft workflow. */
export async function createWorkflowFromTemplate(
  id: string,
  input: { name?: string; credentials?: Record<string, string> } = {},
): Promise<ImportOutcome> {
  return request<ImportOutcome>(`${url(id)}/create-workflow`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
