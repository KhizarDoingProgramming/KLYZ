"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  CircleCheck,
  Info,
  Play,
  Trash2,
} from "lucide-react";
import { Glyph } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { useEditorStore, snapshotWorkflow } from "@/stores/editor";
import { useExecutionStore } from "@/stores/execution";
import { getDefinition } from "@/lib/workflow/registry";
import { CATEGORY_LABEL, CATEGORY_STYLE } from "@/lib/workflow/category";
import { validateWorkflow } from "@/lib/workflow/validation";
import { statusMeta } from "@/lib/status";
import { formatDuration, cn } from "@/lib/utils";
import type { ValidationIssue } from "@/lib/workflow/types";
import { ConfigPanel } from "./config-panel";
import { StepList } from "./execution/step-list";
import { DataView } from "./execution/data-view";
import { RunButton, RunPayloadEditor, StopButton, useRun } from "./run-controls";
import { WebhookEndpointCard } from "./webhook-card";
import { TriggerCard } from "./trigger-card";
import { ProviderEndpointCard } from "./provider-endpoint-card";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="kz-eyebrow text-[9.5px]">{children}</h2>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}

function ValidationRow({ issue }: { issue: ValidationIssue }) {
  const isError = issue.severity === "error";
  const Icon = isError ? AlertTriangle : Info;
  return (
    <li
      className={cn(
        "flex gap-2.5 rounded-md border px-2.5 py-2",
        isError ? "border-danger/35 bg-danger-soft" : "border-warn/30 bg-warn-soft",
      )}
    >
      <Icon
        className={cn(
          "mt-px h-3.5 w-3.5 shrink-0",
          isError ? "text-danger" : "text-warn",
        )}
      />
      <div className="min-w-0">
        <p className="text-[12px] leading-snug text-fg">{issue.message}</p>
        {issue.hint && (
          <p className="mt-0.5 text-[11px] leading-snug text-subtle">{issue.hint}</p>
        )}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */

function ConfigureTab({ issues }: { issues: ValidationIssue[] }) {
  const nodes = useEditorStore((state) => state.nodes);
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const workflowId = useEditorStore((state) => state.workflowId);
  const updateLabel = useEditorStore((state) => state.updateLabel);
  const updateRef = useEditorStore((state) => state.updateRef);
  const removeSelection = useEditorStore((state) => state.removeSelection);

  const node = nodes.find((item) => item.id === selectedNodeId);

  if (!node) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-edge bg-raised">
          <Glyph name="sliders" className="h-4.5 w-4.5 text-muted" />
        </span>
        <div>
          <p className="text-[13px] font-medium text-fg">Nothing selected</p>
          <p className="mt-1 text-[12px] leading-relaxed text-subtle">
            Pick a node on the canvas to configure it, or press{" "}
            <kbd className="kz-eyebrow rounded border border-edge bg-raised px-1 py-[1px] text-[9px]">
              Tab
            </kbd>{" "}
            to add one.
          </p>
        </div>

        {issues.length > 0 && (
          <div className="mt-4 w-full text-left">
            <SectionTitle>Checks</SectionTitle>
            <ul className="flex flex-col gap-1.5">
              {issues.map((issue) => (
                <ValidationRow key={issue.id} issue={issue} />
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  const definition = getDefinition(node.type);
  if (!definition) return null;

  const style = CATEGORY_STYLE[definition.category];
  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);
  const problemMessages = nodeIssues.map((issue) => issue.message);

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 py-4">
      {/* identity ------------------------------------------------- */}
      <section>
        <SectionTitle>Step</SectionTitle>
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge",
              style.chip,
              style.text,
            )}
          >
            <Glyph name={definition.icon} className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-semibold leading-tight text-fg">
              {definition.title}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-subtle">
              <span className="kz-eyebrow">{CATEGORY_LABEL[definition.category]}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{definition.summary}</span>
            </p>
          </div>
          <button
            type="button"
            aria-label="Delete this step"
            onClick={removeSelection}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-edge text-subtle transition-colors hover:border-danger/50 hover:bg-danger-soft hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <Field label="Display name" htmlFor={`${node.id}:label`}>
            <Input
              id={`${node.id}:label`}
              value={node.data.label ?? ""}
              placeholder={definition.title}
              onChange={(event) => updateLabel(node.id, event.target.value)}
            />
          </Field>
          <Field
            label="Reference name"
            htmlFor={`${node.id}:ref`}
            help="Used in expressions, e.g. {{ref.field}}."
          >
            <Input
              id={`${node.id}:ref`}
              mono
              value={node.data.ref}
              onChange={(event) => updateRef(node.id, event.target.value)}
            />
          </Field>
        </div>
      </section>

      {/* configuration -------------------------------------------- */}
      <section>
        <SectionTitle>Configuration</SectionTitle>
        <ConfigPanel
          nodeId={node.id}
          definition={definition}
          config={node.data.config}
          issues={problemMessages}
        />
      </section>

      {/* arming state (manual / webhook / schedule triggers) ------- */}
      {(node.type === "trigger.manual" ||
        node.type === "trigger.webhook" ||
        node.type === "trigger.schedule") && (
        <TriggerCard key={node.id} workflowId={workflowId} />
      )}

      {/* endpoint (webhook trigger) -------------------------------- */}
      {node.type === "trigger.webhook" && (
        <WebhookEndpointCard workflowId={workflowId} config={node.data.config} />
      )}

      {/* endpoint (GitHub hook / Gmail push / Slack events) ------- */}
      {(node.type === "trigger.github" ||
        node.type === "trigger.gmail" ||
        node.type === "trigger.slack") && (
        <ProviderEndpointCard workflowId={workflowId} nodeType={node.type} />
      )}

      {/* outputs -------------------------------------------------- */}
      {definition.outputs.length > 0 && (
        <section>
          <SectionTitle>Produces</SectionTitle>
          <ul className="flex flex-col gap-1">
            {definition.outputs.map((output) => (
              <li
                key={output.key}
                className="flex items-center gap-2 rounded-md border border-edge bg-inset px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
                  {output.key}
                </span>
                <span className="kz-eyebrow shrink-0 text-[9px]">
                  {output.type}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-subtle">
            Reference these from later steps with {"{{"} {node.data.ref}.
            {"}}"}.
          </p>
        </section>
      )}

      {nodeIssues.length > 0 && (
        <section>
          <SectionTitle>Checks</SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {nodeIssues.map((issue) => (
              <ValidationRow key={issue.id} issue={issue} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function BlockedNotice({
  message,
  issues,
  onDismiss,
}: {
  message: string;
  issues: ValidationIssue[];
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-danger/35 bg-danger-soft px-3 py-2.5">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-danger" />
          <p className="text-[12.5px] font-medium text-fg">Run blocked</p>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-1.5 text-[11px]"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{message}</p>
      </div>
      {issues.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {issues.map((issue) => (
            <ValidationRow key={issue.id} issue={issue} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RunTab() {
  const plan = useExecutionStore((state) => state.plan);
  const status = useExecutionStore((state) => state.status);
  const revealed = useExecutionStore((state) => state.revealed);
  const elapsedMs = useExecutionStore((state) => state.elapsedMs);
  const runId = useExecutionStore((state) => state.runId);
  const workflowId = useEditorStore((state) => state.workflowId);
  const selectedStepId = useExecutionStore((state) => state.selectedStepId);
  const blocked = useExecutionStore((state) => state.blocked);
  const setBlocked = useExecutionStore((state) => state.setBlocked);
  const { isRunning, run } = useRun();

  const step = React.useMemo(() => {
    if (!plan) return null;
    if (selectedStepId) {
      const found = plan.steps.find((item) => item.nodeId === selectedStepId);
      if (found) return found;
    }
    if (isRunning && plan.steps[revealed]) return plan.steps[revealed];
    const lastIndex = Math.max(0, Math.min(revealed, plan.steps.length) - 1);
    return plan.steps[lastIndex] ?? null;
  }, [plan, selectedStepId, revealed, isRunning]);

  if (!plan) {
    if (blocked) {
      return (
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <BlockedNotice
            message={blocked.message}
            issues={blocked.issues}
            onDismiss={() => setBlocked(null)}
          />
          <RunPayloadEditor />
          <RunButton />
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-edge bg-raised">
          <Play className="h-4 w-4 text-muted" />
        </span>
        <div>
          <p className="text-[13px] font-medium text-fg">No run yet</p>
          <p className="mt-1 text-[12px] leading-relaxed text-subtle">
            Run the workflow to watch every step, its input and its output as it
            happens.
          </p>
        </div>
        <RunPayloadEditor />
        <RunButton />
      </div>
    );
  }

  const meta = statusMeta(status);
  const done = Math.min(revealed, plan.steps.length);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {blocked && (
        <div className="border-b border-edge px-4 py-3">
          <BlockedNotice
            message={blocked.message}
            issues={blocked.issues}
            onDismiss={() => setBlocked(null)}
          />
        </div>
      )}
      {/* run header ---------------------------------------------- */}
      <div className="border-b border-edge px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={cn("h-2 w-2 rounded-full", meta.dot)} aria-hidden />
          <span className={cn("text-[12.5px] font-medium", meta.text)}>
            {meta.label}
          </span>
          <span className="kz-num ml-auto text-[11px] text-subtle">
            {formatDuration(elapsedMs)}
          </span>
          <StopButton />
          {!isRunning && (
            <Button variant="ghost" size="sm" onClick={run}>
              <Play className="h-3 w-3" />
              Again
            </Button>
          )}
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-inset">
            <div
              className="h-full rounded-full bg-signal transition-[width] duration-complex ease-out"
              style={{
                width: `${plan.steps.length ? (done / plan.steps.length) * 100 : 0}%`,
              }}
            />
          </div>
          <span className="kz-num text-[10.5px] text-subtle">
            {done}/{plan.steps.length}
          </span>
        </div>

        {runId &&
          (workflowId ? (
            <Link
              href={`/workflows/${workflowId}/executions/${runId}`}
              className="kz-eyebrow group/link mt-2 inline-flex items-center gap-1.5 text-[9.5px] transition-colors hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
            >
              Run {runId}
              <ArrowUpRight className="h-2.5 w-2.5 text-subtle transition-colors group-hover/link:text-fg" />
            </Link>
          ) : (
            <p className="kz-eyebrow mt-2 text-[9.5px]">Run {runId}</p>
          ))}

        {!isRunning && (
          <div className="mt-3">
            <RunPayloadEditor />
          </div>
        )}
      </div>

      {/* steps ---------------------------------------------------- */}
      <div className="max-h-[42%] overflow-y-auto border-b border-edge py-1">
        <StepList />
      </div>

      {/* data ----------------------------------------------------- */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DataView step={step} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function Inspector() {
  const open = useEditorStore((state) => state.inspectorOpen);
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const nodes = useEditorStore((state) => state.nodes);
  const edges = useEditorStore((state) => state.edges);
  const name = useEditorStore((state) => state.name);
  const description = useEditorStore((state) => state.description);
  const status = useEditorStore((state) => state.status);
  const tab = useExecutionStore((state) => state.inspectorTab);
  const setTab = useExecutionStore((state) => state.setInspectorTab);
  const setInspectorOpen = useEditorStore((state) => state.setInspectorOpen);

  /* Below lg the inspector is an overlay drawer — start closed so the
     canvas is what you land on. Runs before paint to avoid a flash. */
  React.useLayoutEffect(() => {
    if (window.innerWidth < 1024) setInspectorOpen(false);
  }, [setInspectorOpen]);

  const issues = React.useMemo(() => {
    if (nodes.length === 0) return [];
    const state = useEditorStore.getState();
    return validateWorkflow({
      ...snapshotWorkflow(state),
      name,
      description,
      status,
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: { x: node.position.x, y: node.position.y },
        data: node.data,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? undefined,
        targetHandle: edge.targetHandle ?? undefined,
        data: edge.data ?? undefined,
      })),
    });
  }, [nodes, edges, name, description, status]);

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;

  if (!open) return null;

  const definition = selectedNodeId
    ? getDefinition(nodes.find((node) => node.id === selectedNodeId)?.type ?? "")
    : undefined;

  return (
    <>
      <div
        aria-hidden
        onClick={() => useEditorStore.getState().setInspectorOpen(false)}
        className="kz-scrim fixed inset-0 z-40 lg:hidden"
      />
      <aside
        aria-label="Inspector"
        className="flex w-[356px] shrink-0 flex-col border-l border-edge bg-panel max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-50 max-lg:w-[min(360px,92vw)] max-lg:shadow-lg"
      >
        {/* tabs ------------------------------------------------------ */}
        <div className="flex items-center gap-1 border-b border-edge px-3 py-2">
          <div className="flex items-center gap-0.5">
            {(["configure", "run"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-pressed={tab === key}
                className={cn(
                  "rounded-sm px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] transition-colors",
                  tab === key
                    ? "bg-raised text-fg"
                    : "text-subtle hover:text-muted",
                )}
              >
                {key}
              </button>
            ))}
          </div>

          <span className="ml-auto flex items-center gap-1.5">
            {errorCount > 0 ? (
              <span className="kz-eyebrow flex items-center gap-1 rounded-sm bg-danger-soft px-1.5 py-[3px] text-[9px] text-danger">
                {errorCount} error{errorCount > 1 ? "s" : ""}
              </span>
            ) : warningCount > 0 ? (
              <span className="kz-eyebrow flex items-center gap-1 rounded-sm bg-warn-soft px-1.5 py-[3px] text-[9px] text-warn">
                {warningCount} warning{warningCount > 1 ? "s" : ""}
              </span>
            ) : nodes.length > 0 ? (
              <span className="kz-eyebrow flex items-center gap-1 rounded-sm bg-ok-soft px-1.5 py-[3px] text-[9px] text-ok">
                <CircleCheck className="h-3 w-3" />
                Ready
              </span>
            ) : null}
          </span>
        </div>

        {tab === "configure" ? (
          <ConfigureTab issues={issues} />
        ) : (
          <RunTab />
        )}

        {tab === "configure" && definition && (
          <div className="border-t border-edge px-4 py-2.5">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-[11.5px] text-subtle transition-colors hover:text-muted">
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:-rotate-90" />
                About {definition.title}
              </summary>
              <p className="mt-2 text-[12px] leading-relaxed text-subtle">
                {definition.description}
              </p>
            </details>
          </div>
        )}
      </aside>
    </>
  );

}
