"use client";

import * as React from "react";
import { AlertTriangle, RotateCcw, Unplug, Wrench } from "lucide-react";
import { JsonView } from "./json-view";
import type { ExecutionError } from "@/lib/workflow/types";
import type { ExecutionStepView } from "@/lib/execution/types";
import { formatDuration, cn } from "@/lib/utils";
import { buttonClassName } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";

const REMEDIATION_ICON = {
  reconnect: Unplug,
  retry: RotateCcw,
  inspect: Wrench,
} as const;

export function ErrorPanel({ error }: { error: ExecutionError }) {
  const Icon =
    error.remediation ? REMEDIATION_ICON[error.remediation.kind] : AlertTriangle;

  return (
    <div className="m-3 rounded-lg border border-danger/45 bg-danger-soft p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-danger text-white">
          <AlertTriangle className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="kz-num rounded-sm bg-raised px-1.5 py-[2px] text-[10px] text-danger">
              {error.code}
            </span>
            {error.status !== undefined && (
              <span className="kz-num text-[10px] text-subtle">HTTP {error.status}</span>
            )}
          </div>
          <p className="mt-1.5 text-[13px] font-medium leading-snug text-fg">
            {error.message}
          </p>
          {error.detail && (
            <p className="mt-1 text-[12px] leading-relaxed text-muted">{error.detail}</p>
          )}
          {error.hint && (
            <p className="mt-2 text-[11.5px] text-warn">{error.hint}</p>
          )}

          {error.remediation && (
            <button
              type="button"
              className={buttonClassName("secondary", "sm", "mt-3")}
            >
              <Icon className="h-3.5 w-3.5 text-danger" />
              {error.remediation.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function DataView({ step }: { step: ExecutionStepView | null }) {
  const [tab, setTab] = React.useState<"input" | "output">("output");
  const [prevStep, setPrevStep] = React.useState(step);
  if (step !== prevStep) {
    setPrevStep(step);
    setTab(step?.error ? "input" : "output");
  }

  if (!step) {
    return (
      <div className="border-t border-edge px-4 py-8 text-center">
        <p className="text-[12.5px] text-muted">Select a step to inspect its data</p>
        <p className="mt-1 text-[11.5px] text-subtle">
          Input, output and errors appear here during a run.
        </p>
      </div>
    );
  }

  const payload = tab === "input" ? step.input : step.output;

  return (
    <div className="flex min-h-0 flex-col">
      {step.error && <ErrorPanel error={step.error} />}

      <div className="flex items-center gap-1 border-y border-edge bg-panel px-3 py-1.5">
        <div className="flex items-center gap-0.5">
          {(["input", "output"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "rounded-sm px-2 py-1 text-[11.5px] font-medium capitalize transition-colors",
                tab === key
                  ? "bg-raised text-fg"
                  : "text-subtle hover:text-muted",
              )}
            >
              {key}
            </button>
          ))}
        </div>
        <span className="kz-num ml-auto text-[10.5px] text-subtle">
          {step.status === "pending" || step.status === "waiting"
            ? "—"
            : formatDuration(step.durationMs)}
        </span>
        <CopyButton value={payload} />
      </div>

      <div className="max-h-[340px] overflow-auto">
        <JsonView value={payload} />
      </div>
    </div>
  );
}
