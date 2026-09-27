"use client";

import { create } from "zustand";
import { DEMO_WORKFLOWS } from "@/lib/demo/workflows";
import {
  clearSavedWorkflows,
  readSavedWorkflows,
  writeWorkflows,
} from "@/lib/local/storage";
import {
  WorkflowApiError,
  archiveWorkflow,
  createWorkflow,
  duplicateWorkflow,
  listWorkflows,
  saveDraft,
  updateWorkflow,
} from "@/lib/workflows/api";
import type { Workflow, WorkflowDocument, WorkflowStatus } from "@/lib/workflow/types";

/**
 * The workflow list in the browser.
 *
 * The API is authoritative: every entry here is something the server
 * acknowledged. localStorage is only a recovery copy, used when the
 * workspace cannot be reached, plus a one-way import for drafts written
 * by older versions of KLYZ that never met a server.
 */

interface WorkflowsStore {
  workflows: WorkflowDocument[];
  ready: boolean;
  /** Set when the workspace could not be loaded — the list is then a cache. */
  error: string | null;
  cachedCount: number;
  init: () => Promise<void>;
  reload: () => Promise<void>;
  get: (id: string) => WorkflowDocument | undefined;
  /** Adopt a workflow the API just returned. */
  put: (workflow: WorkflowDocument) => void;
  /** Push a locally edited definition; resolves to the server's copy. */
  sync: (
    definition: Workflow,
  ) => Promise<{ workflow: WorkflowDocument; conflict: boolean }>;
  create: (input?: { name?: string; definition?: Workflow }) => Promise<string>;
  duplicate: (id: string) => Promise<string | null>;
  remove: (id: string) => Promise<void>;
  setStatus: (id: string, status: WorkflowStatus) => Promise<void>;
  clearLocalCache: () => void;
}

function withDefaults(workflow: Workflow): WorkflowDocument {
  const document = workflow as WorkflowDocument;
  return {
    ...document,
    revision: Number.isFinite(document.revision) ? document.revision : 0,
    publishedVersionId: document.publishedVersionId ?? null,
    publishedVersion: document.publishedVersion ?? 0,
    hasUnpublishedChanges: document.hasUnpublishedChanges ?? true,
  };
}

function localOnly(): WorkflowDocument[] {
  return Object.values(readSavedWorkflows()).map(withDefaults);
}

let inflight: Promise<void> | null = null;
let loaded = false;

export const useWorkflowsStore = create<WorkflowsStore>((set, get) => {
  async function hydrate(force: boolean): Promise<void> {
    if (inflight) return inflight;
    if (loaded && !force) return;

    inflight = (async () => {
      const local = readSavedWorkflows();
      const cachedCount = Object.keys(local).length;
      try {
        const remote = await listWorkflows();
        const merged = [...remote];
        const byId = new Map(remote.map((workflow) => [workflow.id, workflow]));

        /* One-way import: drafts an older, server-less build left in
           this browser. Anything newer than the server copy becomes a
           draft revision; anything new becomes a workflow. */
        for (const draft of Object.values(local)) {
          const server = byId.get(draft.id);
          if (!server) {
            try {
              const created = await createWorkflow({
                name: draft.name,
                definition: draft,
              });
              merged.push(created);
              byId.set(created.id, created);
            } catch {
              /* leave it in the cache — it is still readable offline */
            }
            continue;
          }
          if (draft.updatedAt && server.updatedAt && draft.updatedAt > server.updatedAt) {
            try {
              const result = await saveDraft(server.id, draft, server.revision);
              const saved = result.conflict ? server : result.workflow;
              merged[merged.indexOf(server)] = saved;
            } catch {
              /* another tab won the race; the server copy stands */
            }
          }
        }

        writeWorkflows(merged);
        set({ workflows: merged, ready: true, error: null, cachedCount });
      } catch (error) {
        const fallback = cachedCount > 0 ? localOnly() : DEMO_WORKFLOWS.map(withDefaults);
        set({
          workflows: fallback,
          ready: true,
          cachedCount,
          error:
            error instanceof WorkflowApiError && error.status === 0
              ? "Showing the local recovery copy — the workspace could not be reached."
              : error instanceof Error
                ? error.message
                : "The workspace could not be loaded.",
        });
      } finally {
        loaded = true;
        inflight = null;
      }
    })();

    return inflight;
  }

  return {
    workflows: [],
    ready: false,
    error: null,
    cachedCount: 0,

    init: () => hydrate(false),
    reload: () => hydrate(true),

    get: (id) => get().workflows.find((workflow) => workflow.id === id),

    put: (workflow) => {
      const next = get().workflows.some((item) => item.id === workflow.id)
        ? get().workflows.map((item) => (item.id === workflow.id ? workflow : item))
        : [workflow, ...get().workflows];
      set({ workflows: next });
      writeWorkflows(next);
    },

    sync: async (definition) => {
      const current = get().get(definition.id);
      if (!current) {
        throw new WorkflowApiError(404, "NOT_FOUND", "That workflow does not exist.");
      }
      const result = await saveDraft(current.id, definition, current.revision);
      if (result.conflict) {
        get().put(result.conflict.workflow);
        return { workflow: result.conflict.workflow, conflict: true };
      }
      get().put(result.workflow);
      return { workflow: result.workflow, conflict: false };
    },

    create: async (input) => {
      const workflow = await createWorkflow(input ?? {});
      get().put(workflow);
      return workflow.id;
    },

    duplicate: async (id) => {
      try {
        const copy = await duplicateWorkflow(id);
        get().put(copy);
        return copy.id;
      } catch {
        return null;
      }
    },

    remove: async (id) => {
      await archiveWorkflow(id);
      const next = get().workflows.filter((workflow) => workflow.id !== id);
      set({ workflows: next });
      writeWorkflows(next);
    },

    setStatus: async (id, status) => {
      const current = get().get(id);
      if (!current) return;
      try {
        const workflow = await updateWorkflow(id, { status, revision: current.revision });
        get().put(workflow);
      } catch (error) {
        set({ error: error instanceof Error ? error.message : "Could not save the status." });
        throw error;
      }
    },

    clearLocalCache: () => {
      clearSavedWorkflows();
      set({ cachedCount: 0 });
      void hydrate(true);
    },
  };
});
