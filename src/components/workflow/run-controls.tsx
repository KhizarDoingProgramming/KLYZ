"use client";

import * as React from "react";
import { Play, Square } from "lucide-react";
import { useEditorStore, snapshotWorkflow } from "@/stores/editor";
import { useExecutionStore } from "@/stores/execution";
import { useWorkflowsStore } from "@/stores/workflows";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { validateWorkflow } from "@/lib/workflow/validation";
import { formatDuration, cn } from "@/lib/utils";
import { parseRunInput } from "@/lib/execution/run-input";

export function useRun() {
  const isRunning = useExecutionStore((state) => state.isRunning);
  const status = useExecutionStore((state) => state.status);
  const elapsedMs = useExecutionStore((state) => state.elapsedMs);
  const start = useExecutionStore((state) => state.start);
  const cancel = useExecutionStore((state) => state.cancel);
  const setTab = useExecutionStore((state) => state.setInspectorTab);
  const setBlocked = useExecutionStore((state) => state.setBlocked);
  const setRunInputError = useExecutionStore(
    (state) => state.setRunInputError,
  );

  const run = React.useCallback(() => {
    const state = useEditorStore.getState();
    const workflow = snapshotWorkflow(state);
    if (workflow.nodes.length === 0) return;
    const issues = validateWorkflow(workflow);
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      setBlocked({
        message: "Fix these issues before running the workflow.",
        issues: errors,
      });
      setTab("run");
      return;
    }

    /* Refuse an unparseable payload before anything is saved or started. */
    const payload = parseRunInput(useExecutionStore.getState().runInputText);
    if (!payload.ok) {
      setRunInputError(payload.error);
      setBlocked({ message: payload.error, issues: [] });
      setTab("run");
      return;
    }

    setTab("run");

    /* The server runs its own copy of this graph, pinned to a version
       it mints. Push the draft first so what you see is what runs. */
    void (async () => {
      try {
        const saved = await useWorkflowsStore.getState().sync(workflow);
        if (saved.conflict) {
          setBlocked({
            message: "This workflow changed in another tab. Reload before running it.",
            issues: [],
          });
          return;
        }
        useEditorStore.getState().markSaved();
        await start(saved.workflow, payload.input);
      } catch (error) {
        setBlocked({
          message:
            error instanceof Error ? error.message : "Could not save this workflow.",
          issues: [],
        });
      }
    })();
  }, [start, setTab, setBlocked, setRunInputError]);

  const stop = React.useCallback(() => cancel(), [cancel]);

  return { run, stop, isRunning, status, elapsedMs };
}

export function RunButton({ className }: { className?: string }) {
  const { run, isRunning } = useRun();

  if (isRunning) {
    return (
      <Button variant="secondary" disabled className={className}>
        <span className="kz-breathe h-1.5 w-1.5 rounded-full bg-signal" />
        Running
      </Button>
    );
  }

  return (
    <Button variant="primary" onClick={run} className={className}>
      <Play className="h-3.5 w-3.5" />
      Run
    </Button>
  );
}

export function StopButton({ className }: { className?: string }) {
  const { stop, isRunning, elapsedMs } = useRun();
  if (!isRunning) return null;

  return (
    <Button variant="danger" onClick={stop} className={className}>
      <Square className="h-3.5 w-3.5" />
      Stop
      <span className="kz-num text-[10.5px] opacity-70">
        {formatDuration(elapsedMs)}
      </span>
    </Button>
  );
}

/**
 * Compact JSON payload box. The text is parsed by `useRun` when the run
 * starts, so a bad payload is refused before anything is saved or queued.
 */
export function RunPayloadEditor({ rows = 3 }: { rows?: number }) {
  const text = useExecutionStore((state) => state.runInputText);
  const error = useExecutionStore((state) => state.runInputError);
  const setRunInput = useExecutionStore((state) => state.setRunInput);
  const isRunning = useExecutionStore((state) => state.isRunning);

  return (
    <div className="flex w-full flex-col gap-1.5 text-left">
      <label htmlFor="kz-run-input" className="kz-eyebrow text-[9.5px]">
        Run input
      </label>
      <Textarea
        id="kz-run-input"
        mono
        rows={rows}
        spellCheck={false}
        value={text}
        disabled={isRunning}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "kz-run-input-error" : undefined}
        onChange={(event) => setRunInput(event.target.value)}
        className={cn(
          "min-h-0 w-full text-[11.5px]",
          error && "border-danger/70",
        )}
      />
      {error ? (
        <p id="kz-run-input-error" className="text-[11px] leading-relaxed text-danger">
          {error}
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-subtle">
          JSON object — every node reads it as{" "}
          <code className="kz-num text-[10.5px]">trigger.payload</code>.
        </p>
      )}
    </div>
  );
}
