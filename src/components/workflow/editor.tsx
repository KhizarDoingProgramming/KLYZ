"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  FileJson,
  History,
  Layers,
  Network,
  PanelRight,
  Plus,
  Redo2,
  Rocket,
  Save,
  Undo2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu } from "@/components/ui/menu";
import { WorkflowCanvas } from "./canvas";
import { NodePalette } from "./palette";
import { Inspector } from "./inspector";
import { RunButton, StopButton, useRun } from "./run-controls";
import {
  snapshotWorkflow,
  selectCanRedo,
  selectCanUndo,
  useEditorStore,
} from "@/stores/editor";
import { useWorkflowsStore } from "@/stores/workflows";
import { useExecutionStore } from "@/stores/execution";
import { listExecutions } from "@/lib/execution/api";
import {
  exportWorkflow,
  getWorkflow,
  listVersions,
  publishWorkflow,
  restoreVersion,
  saveWorkflowAsTemplate,
} from "@/lib/workflows/api";
import { statusMeta } from "@/lib/status";
import { WORKFLOW_STATUSES, type WorkflowVersionInfo } from "@/lib/workflow/types";
import { cn } from "@/lib/utils";

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable === true
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
  active,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
        disabled
          ? "text-disabled"
          : active
            ? "bg-raised text-signal-text"
            : "text-subtle hover:bg-raised hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

export function WorkflowEditor({ id }: { id: string }) {
  const router = useRouter();

  const name = useEditorStore((state) => state.name);
  const status = useEditorStore((state) => state.status);
  const dirty = useEditorStore((state) => state.dirty);
  const nodeCount = useEditorStore((state) => state.nodes.length);
  const inspectorOpen = useEditorStore((state) => state.inspectorOpen);
  const canUndo = useEditorStore(selectCanUndo);
  const canRedo = useEditorStore(selectCanRedo);
  const rename = useEditorStore((state) => state.rename);
  const setStatus = useEditorStore((state) => state.setStatus);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const setPaletteOpen = useEditorStore((state) => state.setPaletteOpen);
  const setInspectorOpen = useEditorStore((state) => state.setInspectorOpen);
  const { run } = useRun();

  const ready = useWorkflowsStore((state) => state.ready);
  const init = useWorkflowsStore((state) => state.init);
  const workflowDoc = useWorkflowsStore((state) => state.get(id));
  const editorId = useEditorStore((state) => state.workflowId);
  const [saveState, setSaveState] = React.useState<
    "idle" | "saving" | "saved" | "conflict" | "error"
  >("idle");
  const [saveNote, setSaveNote] = React.useState<string | null>(null);
  const [versions, setVersions] = React.useState<WorkflowVersionInfo[]>([]);
  const [publishing, setPublishing] = React.useState(false);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);

  const refreshVersions = React.useCallback(async () => {
    try {
      setVersions(await listVersions(id));
    } catch {
      setVersions([]);
    }
  }, [id]);

  /* ---- hydrate from the server -------------------------------- */
  React.useEffect(() => {
    void init();
  }, [init]);

  React.useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      let workflow = useWorkflowsStore.getState().get(id);
      try {
        const fresh = await getWorkflow(id);
        if (cancelled) return;
        useWorkflowsStore.getState().put(fresh);
        workflow = fresh;
      } catch {
        /* offline — the cached copy still opens the editor */
      }
      if (cancelled) return;
      if (!workflow) {
        router.replace("/workflows");
        return;
      }
      const editor = useEditorStore.getState();
      editor.load(workflow);
      editor.requestFit();
      useExecutionStore.getState().reset();
      setSaveState("idle");
      setSaveNote(null);
      void refreshVersions();
    })();
    return () => {
      cancelled = true;
    };
  }, [id, ready, router, refreshVersions]);

  /* ---- palette “Run workflow” lands here with ?run=1 ------------ */
  const didAutoRun = React.useRef(false);
  React.useEffect(() => {
    if (!ready || didAutoRun.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("run") !== "1") return;
    didAutoRun.current = true;
    params.delete("run");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
    run();
  }, [ready, run]);

  /* ---- re-attach to a run that outlived the last tab ------------ */
  const didAutoAttach = React.useRef(false);
  React.useEffect(() => {
    if (!ready || didAutoAttach.current) return;
    if (useEditorStore.getState().workflowId !== id) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("run") === "1") return;
    didAutoAttach.current = true;

    let cancelled = false;
    const workflow = snapshotWorkflow(useEditorStore.getState());
    void (async () => {
      try {
        const { executions } = await listExecutions({
          workflowId: id,
          active: true,
          limit: 1,
        });
        const active = executions[0];
        if (cancelled || !active) return;
        if (useExecutionStore.getState().runId) return;
        await useExecutionStore.getState().attach(active.id, workflow);
      } catch {
        /* nothing running — the empty Run tab stays as-is */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, id]);

  /* ---- save ---------------------------------------------------- */
  const save = React.useCallback(async (): Promise<boolean> => {
    const state = useEditorStore.getState();
    if (state.workflowId !== id) return false;
    setSaveState("saving");
    try {
      const result = await useWorkflowsStore.getState().sync(snapshotWorkflow(state));
      if (result.conflict) {
        setSaveState("conflict");
        setSaveNote("This workflow changed in another tab. Reload before editing further.");
        return false;
      }
      useEditorStore.getState().markSaved();
      setSaveState("saved");
      setSaveNote(null);
      void refreshVersions();
      return true;
    } catch (error) {
      setSaveState("error");
      setSaveNote(error instanceof Error ? error.message : "Could not save this workflow.");
      return false;
    }
  }, [id, refreshVersions]);

  /* Debounced save: the draft lives on the server, not in this tab. */
  React.useEffect(() => {
    if (!dirty || saveState === "saving" || saveState === "conflict") return;
    const timer = window.setTimeout(() => void save(), 1200);
    return () => window.clearTimeout(timer);
  }, [dirty, save, saveState]);

  /* ---- publish ------------------------------------------------- */
  const publish = React.useCallback(async () => {
    if (publishing) return;
    if (useEditorStore.getState().dirty && !(await save())) return;
    setPublishing(true);
    try {
      const result = await publishWorkflow(id);
      useWorkflowsStore.getState().put(result.workflow);
      setSaveState("saved");
      setSaveNote(null);
      await refreshVersions();
    } catch (error) {
      setSaveState("error");
      setSaveNote(error instanceof Error ? error.message : "Could not publish.");
    } finally {
      setPublishing(false);
    }
  }, [id, publishing, save, refreshVersions]);

  const restore = React.useCallback(
    async (versionId: string) => {
      try {
        const workflow = await restoreVersion(id, versionId);
        useWorkflowsStore.getState().put(workflow);
        useEditorStore.getState().load(workflow);
        setSaveState("saved");
        setSaveNote(null);
        await refreshVersions();
      } catch (error) {
        setSaveState("error");
        setSaveNote(error instanceof Error ? error.message : "Could not restore that version.");
      }
    },
    [id, refreshVersions],
  );

  /* ---- shortcuts ----------------------------------------------- */
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const typing = isTypingTarget(event.target);
      const key = event.key.toLowerCase();

      if (modifier && key === "s") {
        event.preventDefault();
        void save();
        return;
      }
      if (modifier && event.key === "Enter") {
        event.preventDefault();
        run();
        return;
      }
      if (modifier && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (modifier && key === "d" && !typing) {
        event.preventDefault();
        useEditorStore.getState().duplicateSelection();
        return;
      }
      if (!typing && !modifier && event.key === "0") {
        event.preventDefault();
        useEditorStore.getState().requestFit();
        return;
      }
      if (event.key === "Escape") {
        const editor = useEditorStore.getState();
        if (editor.paletteOpen) {
          editor.setPaletteOpen(false);
          return;
        }
        if (editor.selectedNodeId || editor.selectedEdgeId) {
          editor.select(null, null);
          return;
        }
        if (editor.inspectorOpen && window.innerWidth < 1024) {
          editor.setInspectorOpen(false);
        }
        return;
      }
      if (!typing && !modifier && (key === "n" || key === "p")) {
        event.preventDefault();
        useEditorStore.getState().setPaletteOpen(true);
        return;
      }
      if (event.key === "Tab" && !typing && !modifier) {
        const target = event.target as HTMLElement | null;
        const onPane =
          target === null ||
          target === document.body ||
          target.classList.contains("react-flow__pane") ||
          target.classList.contains("react-flow");
        if (!onPane) return;
        event.preventDefault();
        useEditorStore.getState().setPaletteOpen(true);
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        !typing &&
        !modifier
      ) {
        event.preventDefault();
        useEditorStore.getState().removeSelection();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, undo, save, run]);

  /* ---- unsaved guard ------------------------------------------- */
  React.useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!useEditorStore.getState().dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  if (!ready || editorId !== id) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <p className="kz-eyebrow text-[10px]">Opening workflow…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <h1 className="sr-only">{name || "Untitled workflow"}</h1>

      {/* -------------------------------------------------- header */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge bg-app px-3">
        <Link
          href="/workflows"
          aria-label="Back to workflows"
          className="flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-raised hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>

        <span className="h-5 w-px bg-edge" aria-hidden />

        <input
          value={name}
          onChange={(event) => rename(event.target.value)}
          aria-label="Workflow name"
          className="kz-display w-[min(280px,32vw)] min-w-0 rounded-sm bg-transparent px-1.5 py-1 text-[15px] font-semibold tracking-[-0.01em] text-fg outline-none transition-colors hover:bg-raised focus:bg-raised"
        />

        <Menu
          label="Workflow status"
          align="start"
          trigger={(props) => (
            <button
              {...props}
              type="button"
              className="flex items-center gap-1 rounded-md px-1 py-1 transition-colors hover:bg-raised"
            >
              <Badge status={status} />
              <ChevronDown className="h-3 w-3 text-subtle" />
            </button>
          )}
          items={WORKFLOW_STATUSES.map((value) => ({
            id: value,
            label: statusMeta(value).label,
            disabled: value === status,
            onSelect: () => {
              setStatus(value);
              void save();
            },
          }))}
        />

        {busyAction ? (
          <span className="kz-eyebrow hidden items-center gap-1.5 text-[9.5px] text-muted sm:flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
            {busyAction}…
          </span>
        ) : saveState === "conflict" || saveState === "error" ? (
          <span
            className="kz-eyebrow hidden items-center gap-1.5 text-[9.5px] text-danger sm:flex"
            title={saveNote ?? undefined}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-danger" />
            {saveState === "conflict" ? "Conflict" : "Not saved"}
          </span>
        ) : dirty ? (
          <span className="kz-eyebrow hidden items-center gap-1.5 text-[9.5px] text-warn sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-warn" />
            {saveState === "saving" ? "Saving…" : "Unsaved"}
          </span>
        ) : saveState === "saved" ? (
          <span className="kz-eyebrow hidden text-[9.5px] sm:block">Saved</span>
        ) : null}

        <span className="ml-auto flex items-center gap-1">
          <span className="hidden items-center gap-1 sm:flex">
            <IconButton label="Undo" disabled={!canUndo} onClick={undo}>
              <Undo2 className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label="Redo" disabled={!canRedo} onClick={redo}>
              <Redo2 className="h-3.5 w-3.5" />
            </IconButton>

            <span className="mx-1 h-5 w-px bg-edge" aria-hidden />
          </span>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden h-7 items-center gap-2 rounded-sm border border-line px-2.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted transition-colors hover:border-strong hover:text-fg sm:flex"
          >
            <Plus className="h-3.5 w-3.5" />
            Add node
            <kbd className="kz-eyebrow rounded-sm border border-edge bg-raised px-1 py-[1px] text-[9px]">
              Tab
            </kbd>
          </button>

          <Link
            href={`/ai?workflow=${encodeURIComponent(id)}`}
            title="Revise this workflow with the AI builder"
            className="hidden h-7 items-center gap-2 rounded-sm border border-line px-2.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted transition-colors hover:border-strong hover:text-fg sm:flex"
          >
            <Network className="h-3.5 w-3.5" />
            Build with AI
          </Link>

          <IconButton
            label="Toggle inspector"
            active={inspectorOpen}
            onClick={() => setInspectorOpen(!inspectorOpen)}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </IconButton>

          <span className="mx-1 hidden h-5 w-px bg-edge sm:block" aria-hidden />

          <Button
            variant="ghost"
            size="sm"
            onClick={() => void save()}
            disabled={!dirty || saveState === "saving"}
            className="hidden sm:inline-flex"
          >
            <Save className="h-3.5 w-3.5" />
            {saveState === "saving" ? "Saving" : "Save"}
          </Button>

          <Menu
            label="Version history"
            items={[
              { id: "head", label: "Version history", disabled: true, onSelect: () => {} },
              ...(versions.length === 0
                ? [
                    {
                      id: "empty",
                      label: "Nothing published yet",
                      disabled: true,
                      onSelect: () => {},
                    },
                  ]
                : versions.map((version) => ({
                    id: version.id,
                    label: `v${version.version} · ${version.nodeCount} steps${
                      version.isPublished ? " · live" : ""
                    }`,
                    onSelect: () => void restore(version.id),
                  }))),
            ]}
            trigger={(props) => (
              <button
                {...props}
                type="button"
                title="Published version history"
                className="flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              >
                <History className="h-3.5 w-3.5" />
              </button>
            )}
          />

          <Menu
            label="Workflow file actions"
            items={[
              {
                id: "export",
                label: "Export as file…",
                icon: <FileJson className="h-3.5 w-3.5" />,
                onSelect: () => {
                  setBusyAction("Exporting");
                  void exportWorkflow(id)
                    .then((result) => {
                      const blob = new Blob([JSON.stringify(result.portable, null, 2)], {
                        type: "application/json",
                      });
                      const href = URL.createObjectURL(blob);
                      const link = document.createElement("a");
                      link.href = href;
                      link.download = result.filename;
                      link.click();
                      URL.revokeObjectURL(href);
                      setSaveNote(`Exported ${result.nodeCount} steps as ${result.filename}`);
                    })
                    .catch((cause: unknown) =>
                      setSaveNote(cause instanceof Error ? cause.message : "Export failed."),
                    )
                    .finally(() => setBusyAction(null));
                },
              },
              {
                id: "template",
                label: "Save as template",
                icon: <Layers className="h-3.5 w-3.5" />,
                onSelect: () => {
                  const chosen = window.prompt("Template name", name);
                  if (!chosen || !chosen.trim()) return;
                  setBusyAction("Saving template");
                  void saveWorkflowAsTemplate(id, { name: chosen.trim() })
                    .then(() => setSaveNote(`Saved “${chosen.trim()}” to the template library`))
                    .catch((cause: unknown) =>
                      setSaveNote(
                        cause instanceof Error ? cause.message : "Could not save that template.",
                      ),
                    )
                    .finally(() => setBusyAction(null));
                },
              },
            ]}
            trigger={(props) => (
              <button
                {...props}
                type="button"
                title="Export or save as template"
                className="flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
              >
                <FileJson className="h-3.5 w-3.5" />
              </button>
            )}
          />

          <Button
            variant="primary"
            size="sm"
            onClick={() => void publish()}
            disabled={publishing || (!dirty && !workflowDoc?.hasUnpublishedChanges)}
          >
            <Rocket className="h-3.5 w-3.5" />
            {publishing ? "Publishing" : "Publish"}
          </Button>

          <StopButton />
          <RunButton />
        </span>
      </header>

      {/* --------------------------------------------------- body */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <WorkflowCanvas />
        </div>

        <Inspector />
        <NodePalette />
      </div>

      {/* ------------------------------------------------- statusbar */}
      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-edge bg-app px-3.5">
        <span className="kz-eyebrow text-[9.5px]">
          {nodeCount} node{nodeCount === 1 ? "" : "s"}
        </span>
        <span className="kz-eyebrow hidden text-[9.5px] sm:block">
          {workflowDoc?.hasUnpublishedChanges
            ? "Draft — publish to create a version"
            : workflowDoc?.publishedVersion
              ? `Published · v${workflowDoc.publishedVersion}`
              : "Draft — not published yet"}
        </span>
        <span
          className="kz-eyebrow ml-auto max-w-[45%] truncate text-[9.5px]"
          title={saveNote ?? undefined}
        >
          {saveNote ?? (dirty ? "Not saved" : "Saved")}
        </span>
      </footer>
    </div>
  );
}
