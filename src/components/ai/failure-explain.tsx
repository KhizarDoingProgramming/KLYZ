"use client";

import * as React from "react";
import { OctagonX, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiApiError, explainExecution } from "@/lib/ai/api";
import type { FailureExplanation } from "@/lib/ai/explain";
import type { AiMeta } from "@/lib/ai/result";
import { MetaLine } from "./explain-panel";
import { cn } from "@/lib/utils";

/**
 * Explain a failed run from the server's own record of it.
 *
 * Cause lines that the run data does not corroborate are labelled as
 * hypotheses — the model never gets to present a guess as an observed
 * fact, and no payload it receives contains secrets (redaction happens
 * before the execution is ever assembled for this call).
 */

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; explanation: FailureExplanation; meta: AiMeta }
  | { phase: "error"; message: string };

export function FailureExplainCard({
  executionId,
  className,
  label = "Explain this failure",
}: {
  executionId: string;
  className?: string;
  label?: string;
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
      const result = await explainExecution(executionId, controller.signal);
      setState({ phase: "done", explanation: result.explanation, meta: result.meta });
    } catch (error) {
      if (error instanceof AiApiError && error.code === "ABORTED") return;
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : "The explanation failed.",
      });
    }
  }, [executionId]);

  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={run} disabled={state.phase === "loading"}>
          <OctagonX className="h-3.5 w-3.5" />
          {state.phase === "loading"
            ? "Reading the run…"
            : state.phase === "done"
              ? "Explain again"
              : label}
        </Button>
        {state.phase === "done" && <MetaLine meta={state.meta} />}
      </div>

      {state.phase === "error" && (
        <div className="flex items-start gap-2 border-l-2 border-l-danger pl-2.5">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
          <p className="text-[12px] leading-relaxed text-danger">{state.message}</p>
        </div>
      )}

      {state.phase === "done" && <FailureBody explanation={state.explanation} />}
    </section>
  );
}

export function FailureBody({ explanation }: { explanation: FailureExplanation }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-relaxed text-fg">{explanation.summary}</p>

      {explanation.observed.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="kz-eyebrow text-[9.5px] text-muted">Observed in this run</h4>
          <ul className="flex flex-col gap-1">
            {explanation.observed.map((line) => (
              <li key={line} className="flex gap-2 text-[12px] leading-relaxed text-subtle">
                <span className="font-mono text-[10px] text-muted">·</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {explanation.causes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="kz-eyebrow text-[9.5px] text-muted">Likely causes</h4>
          <ul className="flex flex-col gap-1.5">
            {explanation.causes.map((cause) => (
              <li key={cause.text} className="flex gap-2 text-[12px] leading-relaxed">
                <span className="font-mono text-[10px] text-muted">→</span>
                <span className="text-subtle">
                  {cause.text}
                  {!cause.supported && (
                    <span className="kz-eyebrow ml-1.5 text-[9px] text-muted">
                      hypothesis — not confirmed by this run
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {explanation.nextSteps.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="kz-eyebrow text-[9.5px] text-muted">What to check</h4>
          <ol className="flex flex-col gap-1">
            {explanation.nextSteps.map((line, index) => (
              <li key={line} className="flex gap-2 text-[12px] leading-relaxed text-subtle">
                <span className="font-mono text-[10px] text-muted">{index + 1}.</span>
                <span>{line}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
