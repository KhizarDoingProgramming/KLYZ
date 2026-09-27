import type { Workflow } from "@/lib/workflow/types";

/**
 * Browser-local recovery cache.
 *
 * The workflow API owns workflow definitions. This module keeps the
 * last copy the browser saw so the workspace still opens when the
 * server cannot be reached, and so drafts written by older, server-less
 * builds of KLYZ can be imported once and never lost. Nothing reads
 * this as a source of truth when the API answers.
 */

const KEY = "klyz.workflows.v1";

export function readSavedWorkflows(): Record<string, Workflow> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, Workflow>;
  } catch {
    return {};
  }
}

export function writeWorkflows(workflows: Workflow[]): void {
  if (typeof window === "undefined") return;
  try {
    const map: Record<string, Workflow> = {};
    for (const workflow of workflows) map[workflow.id] = workflow;
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* quota or private mode — the in-memory copy still works */
  }
}

export function clearSavedWorkflows(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
