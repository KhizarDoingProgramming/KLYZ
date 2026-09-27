"use client";

import * as React from "react";
import { CircleCheck, CircleX, Link2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { PlanCanvas } from "./plan-canvas";
import { PlanDiff } from "./plan-diff";
import { ExplainWorkflowPanel } from "./explain-panel";
import { diffWorkflow } from "@/lib/ai/diff";
import type { PlanResult } from "@/lib/ai/result";
import { CATEGORY_LABEL, CATEGORY_STYLE } from "@/lib/workflow/category";
import { getDefinition } from "@/lib/workflow/registry";
import type { ValidationIssue, Workflow } from "@/lib/workflow/types";
import { cn } from "@/lib/utils";

/**
 * The review surface for a generated plan.
 *
 * Three things have to be legible before anything can be approved: what
 * the plan does (structure + canvas), what is wrong with it (real
 * registry/graph validation, not model self-assessment), and what it
 * changes (diff against the current workflow).
 */

export function PlanReview({
  result,
  contextWorkflow,
  selectedNodeId,
  onSelectNode,
  feedback,
  onFeedbackChange,
  onRefine,
  refineBusy,
}: {
  result: PlanResult;
  contextWorkflow: Workflow | null;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  feedback: string;
  onFeedbackChange: (value: string) => void;
  onRefine: () => void;
  refineBusy: boolean;
}) {
  const { plan, validation, workflow, connections, meta } = result;
  const diff = React.useMemo(
    () => (contextWorkflow && workflow ? diffWorkflow(contextWorkflow, workflow) : null),
    [contextWorkflow, workflow],
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,300px)]">
      {/* ---------------------------------------------- structure */}
      <section className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h2 className="kz-display text-[17px] text-fg">{plan.title}</h2>
          <p className="text-[12px] leading-relaxed text-subtle">{plan.summary}</p>
        </header>

        {plan.intent.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h3 className="kz-eyebrow text-[9.5px] text-muted">Intent</h3>
            <ol className="flex flex-col gap-1">
              {plan.intent.map((stage, index) => (
                <li key={`${stage.stage}-${index}`} className="flex gap-2 text-[12px] leading-relaxed text-subtle">
                  <span className="font-mono text-[10px] text-muted">{index + 1}.</span>
                  <span>
                    <span className="text-muted">{stage.label}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <h3 className="kz-eyebrow text-[9.5px] text-muted">
            Steps · {plan.nodes.length}
          </h3>
          <ol className="flex flex-col">
            {plan.nodes.map((node, index) => {
              const definition = getDefinition(node.type);
              const category = definition?.category ?? "utility";
              const style = CATEGORY_STYLE[category];
              const isBlocked = validation.blocking.some((issue) => issue.nodeId === node.id);
              const isSelected = selectedNodeId === node.id;
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => onSelectNode(isSelected ? null : node.id)}
                    className={cn(
                      "flex w-full items-start gap-2.5 border-l-2 py-2 pl-2.5 pr-1 text-left transition-colors",
                      isSelected
                        ? "border-l-fg bg-raised"
                        : "border-l-transparent hover:bg-raised/60",
                    )}
                  >
                    <span
                      className={cn(
                        "kz-eyebrow mt-0.5 w-4 shrink-0 text-right font-mono text-[9.5px]",
                        style.text,
                      )}
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-medium text-fg">
                          {node.label ?? node.ref ?? definition?.title ?? node.type}
                        </span>
                        {isBlocked && <CircleX className="h-3 w-3 shrink-0 text-danger" />}
                      </span>
                      <span className="kz-eyebrow block text-[9.5px] text-muted">
                        {definition?.title ?? node.type} · {CATEGORY_LABEL[category]}
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-relaxed text-subtle">
                        {node.why}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {/* ------------------------------------------------- canvas */}
      <section className="flex min-w-0 flex-col gap-5">
        <div className="h-[440px] border border-line bg-surface xl:h-[520px]">
          {workflow && (
            <PlanCanvas
              workflow={workflow}
              selectedNodeId={selectedNodeId}
              onSelect={onSelectNode}
              focusNodeId={selectedNodeId}
            />
          )}
        </div>

        {(plan.assumptions.length > 0 ||
          plan.unresolved.length > 0 ||
          plan.warnings.length > 0 ||
          plan.sideEffects.length > 0) && (
          <div className="grid gap-5 sm:grid-cols-2">
            {plan.assumptions.length > 0 && (
              <NoteBlock title="Assumptions" items={plan.assumptions} />
            )}
            {plan.unresolved.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <h3 className="kz-eyebrow text-[9.5px] text-muted">Open questions</h3>
                <ul className="flex flex-col gap-1.5">
                  {plan.unresolved.map((item) => (
                    <li
                      key={`${item.label}-${item.nodeId ?? ""}-${item.field ?? ""}`}
                      className={cn(
                        "flex flex-col gap-0.5 border-l-2 pl-2.5",
                        item.severity === "unsupported"
                          ? "border-l-danger"
                          : item.severity === "ambiguous"
                            ? "border-l-warn"
                            : "border-l-line",
                      )}
                    >
                      <span className="text-[12px] leading-snug text-fg">{item.label}</span>
                      <span className="text-[11.5px] leading-relaxed text-subtle">{item.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {plan.warnings.length > 0 && (
              <NoteBlock title="Warnings" items={plan.warnings} tone="warn" />
            )}
            {plan.sideEffects.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <h3 className="kz-eyebrow text-[9.5px] text-muted">What this will do</h3>
                <ul className="flex flex-col gap-1.5">
                  {plan.sideEffects.map((item) => (
                    <li
                      key={`${item.label}-${item.nodeId ?? ""}`}
                      className="flex flex-col gap-0.5 border-l-2 border-l-warn pl-2.5"
                    >
                      <span className="text-[12px] leading-snug text-fg">{item.label}</span>
                      <span className="text-[11.5px] leading-relaxed text-subtle">{item.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {diff && <PlanDiff diff={diff} baselineName={contextWorkflow?.name} />}
        {workflow && <ExplainWorkflowPanel workflow={workflow} />}
      </section>

      {/* -------------------------------------------------- checks */}
      <section className="flex min-w-0 flex-col gap-5">
        <ValidationBlock validation={validation} />

        {connections.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h3 className="kz-eyebrow text-[9.5px] text-muted">
              Integrations to connect · {connections.length}
            </h3>
            <ul className="flex flex-col gap-2">
              {connections.map((connection) => (
                <li
                  key={`${connection.credential}-${connection.nodeId ?? ""}`}
                  className="flex gap-2 border-l-2 border-l-line pl-2.5"
                >
                  <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                  <span className="min-w-0">
                    <span className="block text-[12.5px] text-fg">{connection.label}</span>
                    <span className="block text-[11.5px] leading-relaxed text-subtle">
                      {connection.reason}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <a
              href="/integrations"
              className="kz-eyebrow mt-1 self-start text-[9.5px] text-subtle underline underline-offset-2 transition-colors hover:text-fg"
            >
              Open integrations →
            </a>
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-edge pt-4">
          <h3 className="kz-eyebrow text-[9.5px] text-muted">Refine this plan</h3>
          <Textarea
            value={feedback}
            onChange={(event) => onFeedbackChange(event.target.value)}
            rows={3}
            aria-label="Feedback for the plan"
            placeholder="e.g. Use the #support channel instead, and skip the enrichment step"
            className="min-h-[70px] resize-y text-[12.5px]"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRefine}
            disabled={refineBusy || !feedback.trim()}
            className="self-start"
          >
            {refineBusy ? "Refining…" : "Refine plan"}
          </Button>
        </div>

        <p className="kz-eyebrow border-t border-edge pt-3 text-[9.5px] text-muted">
          {meta.model} · {(meta.durationMs / 1000).toFixed(1)}s · pass {meta.attempts}
          {meta.repaired ? " (repaired)" : ""}
          {meta.usage?.totalTokens ? ` · ${meta.usage.totalTokens} tok` : ""}
          <br />
          catalog {meta.catalog}
        </p>
      </section>
    </div>
  );
}

function NoteBlock({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone?: "warn";
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className={cn("kz-eyebrow text-[9.5px]", tone === "warn" ? "text-warn" : "text-muted")}>
        {title}
      </h3>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-[12px] leading-relaxed text-subtle">
            <span className="font-mono text-[10px] text-muted">·</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ValidationBlock({
  validation,
}: {
  validation: PlanResult["validation"];
}) {
  const errors = validation.issues.filter((issue) => issue.severity === "error");
  const warnings = validation.issues.filter((issue) => issue.severity === "warning");

  const state = !validation.applyable
    ? {
        icon: <CircleX className="h-3.5 w-3.5 text-danger" />,
        label: "Cannot apply yet",
        text: "text-danger",
        detail: "The structure is wrong — these have to be fixed first.",
      }
    : validation.ok
      ? {
          icon: <CircleCheck className="h-3.5 w-3.5 text-ok" />,
          label: "Ready to apply",
          text: "text-ok",
          detail: "Validated against the node registry and graph rules.",
        }
      : {
          icon: <TriangleAlert className="h-3.5 w-3.5 text-warn" />,
          label: "Needs configuration",
          text: "text-warn",
          detail: "You can open it in the editor and fill in the gaps.",
        };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {state.icon}
        <h3 className={cn("kz-eyebrow text-[9.5px]", state.text)}>{state.label}</h3>
        <span className="kz-eyebrow ml-auto text-[9.5px] text-muted">
          {errors.length} err · {warnings.length} warn
        </span>
      </div>
      <p className="text-[11.5px] leading-relaxed text-muted">{state.detail}</p>

      {validation.issues.length > 0 && (
        <ul className="flex flex-col gap-2">
          {validation.issues.map((issue) => (
            <IssueRow key={`${issue.id}-${issue.nodeId ?? ""}`} issue={issue} />
          ))}
        </ul>
      )}
    </section>
  );
}

function IssueRow({ issue }: { issue: ValidationIssue }) {
  const isError = issue.severity === "error";
  const blocking = issue.id.startsWith("capability_") || issue.id.startsWith("unknown_");
  return (
    <li
      className={cn(
        "flex gap-2 border-l-2 pl-2.5",
        isError && blocking ? "border-l-danger" : isError ? "border-l-warn" : "border-l-line",
      )}
    >
      {isError ? (
        <CircleX className={cn("mt-0.5 h-3 w-3 shrink-0", blocking ? "text-danger" : "text-warn")} />
      ) : (
        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-muted" />
      )}
      <span className="min-w-0">
        <span className="block text-[12px] leading-snug text-fg">{issue.message}</span>
        {issue.hint && (
          <span className="block text-[11.5px] leading-relaxed text-subtle">{issue.hint}</span>
        )}
      </span>
    </li>
  );
}
