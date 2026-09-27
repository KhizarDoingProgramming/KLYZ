"use client";

import * as React from "react";
import { Sparkle, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiApiError, explainWorkflow } from "@/lib/ai/api";
import type { WorkflowExplanation } from "@/lib/ai/explain";
import type { AiMeta } from "@/lib/ai/result";
import type { Workflow } from "@/lib/workflow/types";
import { cn } from "@/lib/utils";

/**
 * "Explain this workflow" (or one node of it) — user-initiated, one
 * round-trip, rendered from the model's structured answer.
 *
 * It fetches on click rather than on mount so it can be dropped next to
 * a graph that changes identity every render (the live editor) without
 * ever refetching behind the user's back.
 */

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; explanation: WorkflowExplanation; meta: AiMeta }
  | { phase: "error"; message: string };

export function ExplainWorkflowPanel({
  workflow,
  nodeId,
  label,
  className,
}: {
  workflow: Workflow;
  nodeId?: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = React.useState<State>({ phase: "idle" });
  const controllerRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => controllerRef.current?.abort(), []);

  const run = React.useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ phase: "loading" });
    try {
      const result = await explainWorkflow(
        { workflow, ...(nodeId ? { nodeId } : {}) },
        controller.signal,
      );
      setState({ phase: "done", explanation: result.explanation, meta: result.meta });
    } catch (error) {
      if (error instanceof AiApiError && error.code === "ABORTED") return;
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : "The explanation failed.",
      });
    }
  }, [workflow, nodeId]);

  const heading = label ?? (nodeId ? "Explain this node" : "Explain this workflow");

  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={run} disabled={state.phase === "loading"}>
          <Sparkle className="h-3.5 w-3.5" />
          {state.phase === "loading" ? "Explaining…" : state.phase === "done" ? "Explain again" : heading}
        </Button>
        {state.phase === "done" && (
          <MetaLine meta={state.meta} />
        )}
      </div>

      {state.phase === "loading" && (
        <p className="text-[12px] text-muted">Reading the graph and composing an explanation…</p>
      )}

      {state.phase === "error" && (
        <div className="flex items-start gap-2 border-l-2 border-l-danger pl-2.5">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
          <p className="text-[12px] leading-relaxed text-danger">{state.message}</p>
        </div>
      )}

      {state.phase === "done" && <ExplanationBody explanation={state.explanation} />}
    </section>
  );
}

export function ExplanationBody({ explanation }: { explanation: WorkflowExplanation }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-relaxed text-fg">{explanation.summary}</p>
      {explanation.sections.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {explanation.sections.map((section) => (
            <div key={section.title} className="flex flex-col gap-1.5">
              <h4 className="kz-eyebrow text-[9.5px] text-muted">{section.title}</h4>
              <ul className="flex flex-col gap-1">
                {section.items.map((item) => (
                  <li key={item} className="flex gap-2 text-[12px] leading-relaxed text-subtle">
                    <span className="font-mono text-[10px] text-muted">·</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MetaLine({ meta }: { meta: AiMeta }) {
  return (
    <span className="kz-eyebrow text-[9.5px] text-muted">
      {meta.model} · {(meta.durationMs / 1000).toFixed(1)}s
      {meta.usage?.totalTokens ? ` · ${meta.usage.totalTokens} tok` : ""}
      {meta.repaired ? " · repaired once" : ""}
    </span>
  );
}
