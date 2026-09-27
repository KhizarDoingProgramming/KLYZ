"use client";

import * as React from "react";
import { CircleDashed, Loader2 } from "lucide-react";
import { useExecutionStore } from "@/stores/execution";
import { useEditorStore } from "@/stores/editor";
import { statusMeta } from "@/lib/status";
import { formatDuration, cn } from "@/lib/utils";
import type { NodeStatus } from "@/lib/workflow/types";

function StatusDot({ status }: { status: NodeStatus }) {
  const meta = statusMeta(status);
  if (status === "running") {
    return (
      <span className="flex h-4 w-4 items-center justify-center">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-signal" />
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="flex h-4 w-4 items-center justify-center text-disabled">
        <CircleDashed className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)} aria-hidden />
  );
}

export function StepList() {
  const plan = useExecutionStore((state) => state.plan);
  const nodeStates = useExecutionStore((state) => state.nodeStates);
  const selectedStepId = useExecutionStore((state) => state.selectedStepId);
  const selectStep = useExecutionStore((state) => state.selectStep);
  const revealed = useExecutionStore((state) => state.revealed);
  const runStatus = useExecutionStore((state) => state.status);
  const runActive =
    runStatus === "queued" || runStatus === "running" || runStatus === "waiting";

  if (!plan) return null;

  return (
    <ol className="flex flex-col gap-px">
      {plan.steps.map((step, index) => {
        const status = nodeStates[step.nodeId] ?? "pending";
        const meta = statusMeta(status);
        const active = selectedStepId === step.nodeId;
        const pending = index >= revealed && status === "pending";

        return (
          <li key={`${step.nodeId}-${index}`}>
            <button
              type="button"
              onClick={() => {
                selectStep(step.nodeId);
                const editor = useEditorStore.getState();
                editor.select(step.nodeId, null);
                editor.focusNode(step.nodeId);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                active ? "bg-raised" : "hover:bg-raised/60",
              )}
              aria-current={active ? "step" : undefined}
            >
              <span className="kz-num w-4 shrink-0 text-right text-[10.5px] text-subtle">
                {index + 1}
              </span>

              <StatusDot status={status} />

              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-[12.5px] leading-snug",
                    status === "skipped" ? "text-disabled line-through" : "text-fg",
                  )}
                >
                  {step.nodeLabel}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10.5px] text-subtle">
                  {step.ref}
                </span>
              </span>

              <span className="shrink-0 text-right">
                {status === "running" ? (
                  <span className="kz-eyebrow text-[9.5px] text-signal-text">Running</span>
                ) : status === "waiting" ? (
                  <span className="kz-eyebrow text-[9.5px] text-warn">Waiting</span>
                ) : pending ? (
                  <span className="kz-eyebrow text-[9.5px]">
                    {runActive ? "Queued" : "—"}
                  </span>
                ) : (
                  <span
                    className={cn(
                      "kz-num text-[10.5px]",
                      status === "failed" ? "text-danger" : meta.text,
                    )}
                  >
                    {status === "skipped" ? "skipped" : formatDuration(step.durationMs)}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
