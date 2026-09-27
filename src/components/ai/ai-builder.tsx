"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleX, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IntentComposer } from "./intent-composer";
import { PlanReview } from "./plan-review";
import { FailureExplainCard } from "./failure-explain";
import { AiApiError, generatePlan, getAiStatus, refinePlan } from "@/lib/ai/api";
import type { AiStatusResult, PlanResult } from "@/lib/ai/result";
import { useEditorStore, snapshotWorkflow } from "@/stores/editor";
import { useWorkflowsStore } from "@/stores/workflows";
import { createWorkflow } from "@/lib/workflows/api";
import { cn } from "@/lib/utils";
import type { Workflow } from "@/lib/workflow/types";

/**
 * The AI workflow builder.
 *
 * Three phases, no shortcuts: describe → review a validated plan →
 * apply it through the normal editor path (or discard it). Nothing is
 * written, published or executed from here; the model's answer only
 * becomes a workflow when a human presses Apply, and only becomes a run
 * when somebody presses Run in the editor.
 */

type Phase = "idle" | "working" | "review";
type Operation = "generate" | "refine";

interface ShownError {
  message: string;
  code?: string;
  issues?: string[];
}

function describeError(error: unknown): ShownError {
  if (error instanceof AiApiError) {
    const details = error.details as { issues?: unknown } | undefined;
    const raw = details?.issues;
    const issues = Array.isArray(raw) ? raw.map((item) => String(item)) : undefined;
    switch (error.code) {
      case "CONFIGURATION_MISSING":
        return {
          message: "The AI builder is not configured. Set KLYZ_AI_API_KEY (and optionally KLYZ_AI_MODEL / KLYZ_AI_BASE_URL) on the server, then reload.",
          code: error.code,
        };
      case "RATE_LIMITED":
        return { message: `${error.message} Wait a moment and try again.`, code: error.code };
      case "ABORTED":
        return { message: "Cancelled.", code: error.code };
      default:
        return { message: error.message, code: error.code, ...(issues ? { issues } : {}) };
    }
  }
  return { message: error instanceof Error ? error.message : "Something went wrong." };
}

export function AiBuilder({
  workflowId,
  executionId,
}: {
  workflowId?: string;
  executionId?: string;
}) {
  const router = useRouter();

  const workflows = useWorkflowsStore((state) => state.workflows);
  const storeInit = useWorkflowsStore((state) => state.init);

  const [intent, setIntent] = React.useState("");
  const [feedback, setFeedback] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [operation, setOperation] = React.useState<Operation>("generate");
  const [result, setResult] = React.useState<PlanResult | null>(null);
  const [error, setError] = React.useState<ShownError | null>(null);
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<AiStatusResult | null>(null);
  const [applying, setApplying] = React.useState(false);
  const [elapsedMs, setElapsedMs] = React.useState(0);

  const controllerRef = React.useRef<AbortController | null>(null);
  const timerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    storeInit();
  }, [storeInit]);

  /* Config state: lets the page say "not configured" before the first
     failed request, without ever asking the browser for a key. */
  React.useEffect(() => {
    const controller = new AbortController();
    getAiStatus(controller.signal)
      .then((value) => setStatus(value))
      .catch(() => setStatus(null));
    return () => controller.abort();
  }, []);

  React.useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    },
    [],
  );

  /* Baseline: the saved workflow, unless the editor holds a newer
     unsaved draft of the same id — that is what the diff must compare. */
  const contextWorkflow: Workflow | null = React.useMemo(() => {
    if (!workflowId) return null;
    const saved = workflows.find((item) => item.id === workflowId) ?? null;
    const editor = useEditorStore.getState();
    if (editor.workflowId === workflowId && editor.dirty) {
      try {
        return snapshotWorkflow(editor);
      } catch {
        return saved;
      }
    }
    return saved;
  }, [workflowId, workflows]);

  const busy = phase === "working";
  const enabled = status?.ai.enabled ?? true;

  const stopTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setElapsedMs(0);
  }, []);

  const startRequest = React.useCallback(
    (op: Operation) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const startedAt = performance.now();
      setElapsedMs(0);
      timerRef.current = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 100);
      setOperation(op);
      setPhase("working");
      setError(null);
      return controller;
    },
    [],
  );

  const finishRequest = React.useCallback(
    (next: Phase) => {
      stopTimer();
      setPhase(next);
    },
    [stopTimer],
  );

  const generate = React.useCallback(async () => {
    const trimmed = intent.trim();
    if (!trimmed || busy) return;
    const controller = startRequest("generate");
    try {
      const response = await generatePlan(
        { intent: trimmed, ...(contextWorkflow ? { workflow: contextWorkflow } : {}) },
        controller.signal,
      );
      setResult(response);
      setSelectedNodeId(null);
      setFeedback("");
      finishRequest("review");
    } catch (caught) {
      setError(describeError(caught));
      finishRequest(result ? "review" : "idle");
    }
  }, [intent, busy, contextWorkflow, startRequest, finishRequest, result]);

  const refine = React.useCallback(async () => {
    const trimmed = feedback.trim();
    if (!result || !trimmed || busy) return;
    const controller = startRequest("refine");
    try {
      const response = await refinePlan(
        {
          intent: intent.trim() || result.plan.title,
          plan: result.plan,
          feedback: trimmed,
          ...(contextWorkflow ? { workflow: contextWorkflow } : {}),
        },
        controller.signal,
      );
      setResult(response);
      setFeedback("");
      finishRequest("review");
    } catch (caught) {
      setError(describeError(caught));
      finishRequest("review");
    }
  }, [feedback, result, busy, intent, contextWorkflow, startRequest, finishRequest]);

  const cancel = React.useCallback(() => {
    controllerRef.current?.abort();
    setError({ message: "Cancelled." });
    finishRequest(result ? "review" : "idle");
  }, [finishRequest, result]);

  const discard = React.useCallback(() => {
    setResult(null);
    setError(null);
    setFeedback("");
    setSelectedNodeId(null);
    setPhase("idle");
  }, []);

  /* Apply: saves through the server's draft API — the same path the
     editor uses — then opens the editor. The plan is never executed
     from here, and nothing is published on the user's behalf. */
  const apply = React.useCallback(() => {
    if (!result?.workflow || !result.validation.applyable || applying) return;
    setApplying(true);
    const base = result.workflow;
    void (async () => {
      try {
        const store = useWorkflowsStore.getState();
        if (!store.ready) await store.init();
        const state = useWorkflowsStore.getState();

        let workflow;
        if (contextWorkflow) {
          const saved = await state.sync({
            ...base,
            id: contextWorkflow.id,
            name: contextWorkflow.name,
            description: contextWorkflow.description,
            status: contextWorkflow.status,
            createdAt: contextWorkflow.createdAt,
            lastExecutedAt: contextWorkflow.lastExecutedAt,
            executionCount: contextWorkflow.executionCount,
            successRate: contextWorkflow.successRate,
            avgDurationMs: contextWorkflow.avgDurationMs,
            updatedAt: new Date().toISOString(),
          });
          if (saved.conflict) {
            setError({
              message: "This workflow changed in another tab. Reload before applying the plan.",
            });
            return;
          }
          workflow = saved.workflow;
        } else {
          workflow = await createWorkflow({ name: base.name, definition: base });
          useWorkflowsStore.getState().put(workflow);
        }

        useEditorStore.getState().load(workflow);
        router.push(`/workflows/${workflow.id}`);
      } catch (cause) {
        setError({
          message: cause instanceof Error ? cause.message : "The plan could not be applied.",
        });
      } finally {
        setApplying(false);
      }
    })();
  }, [result, contextWorkflow, router, applying]);

  const disabledReason = !enabled
    ? "Not configured on this server."
    : !intent.trim()
      ? "Describe the automation first."
      : intent.length > 4_000
        ? "The description is over the 4,000 character limit."
        : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-5 py-7 sm:px-8">
        {/* ------------------------------------------------ header */}
        <header className="flex flex-col gap-2 border-b border-edge pb-5">
          <span className="kz-eyebrow text-[9.5px] text-muted">AI builder</span>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="kz-display text-[24px] tracking-[-0.02em] text-fg">
              Describe it. Review it. Then it ships.
            </h1>
          </div>
          <p className="max-w-[70ch] text-[13px] leading-relaxed text-subtle">
            Natural language becomes a strict workflow plan, checked against KLYZ&apos;s real node
            registry and graph rules. Nothing is saved, published or executed until you apply the
            plan and run it yourself.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {status && !status.ai.enabled && (
              <span className="kz-eyebrow flex items-center gap-1.5 text-[9.5px] text-warn">
                <Settings2 className="h-3 w-3" />
                not configured — set KLYZ_AI_API_KEY
              </span>
            )}
            {status?.ai.enabled && (
              <span className="kz-eyebrow text-[9.5px] text-muted">
                {status.ai.model} · {status.ai.baseUrl.replace(/^https?:\/\//, "")} · catalog{" "}
                {status.catalog}
              </span>
            )}
            {contextWorkflow && (
              <span className="kz-eyebrow text-[9.5px] text-muted">
                editing against · {contextWorkflow.name} ({contextWorkflow.nodes.length} nodes)
              </span>
            )}
            {executionId && <span className="kz-eyebrow text-[9.5px] text-muted">run · {executionId}</span>}
          </div>
        </header>

        {executionId && <FailureExplainCard executionId={executionId} />}

        {/* ----------------------------------------------- composer */}
        <IntentComposer
          value={intent}
          onChange={setIntent}
          onSubmit={generate}
          onCancel={cancel}
          busy={busy}
          error={error?.message ?? null}
          elapsedMs={elapsedMs}
          helper={contextWorkflow ? "Generated as a revision of the open workflow." : undefined}
        />

        {error?.issues && error.issues.length > 0 && (
          <ul className="flex flex-col gap-1 border-l-2 border-l-danger pl-2.5">
            {error.issues.map((issue) => (
              <li key={issue} className="font-mono text-[11px] leading-relaxed text-danger">
                {issue}
              </li>
            ))}
          </ul>
        )}

        {!enabled && status && (
          <section className="flex max-w-[70ch] flex-col gap-2 border-l-2 border-l-warn pl-3">
            <h2 className="text-h3 text-fg">The AI builder is switched off</h2>
            <p className="text-[12.5px] leading-relaxed text-subtle">
              The server has no AI provider configured, so every request would fail. Set these on the
              server and reload — the key never reaches the browser:
            </p>
            <ul className="flex flex-col gap-1 font-mono text-[11.5px] text-muted">
              <li>KLYZ_AI_API_KEY — required (any OpenAI-compatible provider)</li>
              <li>KLYZ_AI_MODEL — optional, default openai/gpt-4o-mini</li>
              <li>KLYZ_AI_BASE_URL — optional, default https://openrouter.ai/api/v1</li>
            </ul>
          </section>
        )}

        {/* -------------------------------------------------- review */}
        {phase === "review" && result && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 border-b border-edge pb-3">
              <span className="kz-eyebrow text-[9.5px] text-muted">
                {operation === "refine" ? "Refined plan" : "Generated plan"}
              </span>
              <span className="ml-auto flex items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={discard}>
                  Discard
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={apply}
                  disabled={!result.validation.applyable || applying}
                  title={
                    result.validation.applyable
                      ? "Open this plan in the editor"
                      : "Fix the blocking issues first"
                  }
                >
                  Apply to editor
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </span>
            </div>

            {!result.validation.applyable && (
              <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-danger">
                <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This plan cannot be applied yet — the structure does not match the node registry.
                Fix it with a refinement below.
              </p>
            )}

            <PlanReview
              result={result}
              contextWorkflow={contextWorkflow}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              feedback={feedback}
              onFeedbackChange={setFeedback}
              onRefine={refine}
              refineBusy={busy && operation === "refine"}
            />
          </div>
        )}

        {phase === "idle" && !result && (
          <p className={cn("max-w-[70ch] text-[12.5px] leading-relaxed text-muted", disabledReason && "text-warn")}>
            {disabledReason ??
              "Write what should happen, in order. The result is a plan you can read, diff and reject — not an auto-published workflow."}
          </p>
        )}

      </div>
    </div>
  );
}