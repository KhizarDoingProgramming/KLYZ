"use client";

import * as React from "react";
import { Radio, Wrench } from "lucide-react";
import { ErrorPanel } from "@/components/workflow/execution/data-view";
import { DataViewer } from "./data-viewer";
import {
  attemptsOf,
  formatOffset,
  stepOffset,
  stepVisualState,
  type StepVisualState,
} from "@/lib/execution/debugger";
import { statusMeta } from "@/lib/status";
import { formatDuration, cn } from "@/lib/utils";
import type { ExecutionStepView } from "@/lib/execution/types";

/**
 * Step inspector — the answer to "what did this step do?".
 *
 * Overview first (state, timings, attempts, outbound calls), then the
 * raw payloads. Every number comes from the recorded step; nothing here
 * re-runs or re-derives work.
 */

type Tab = "overview" | "input" | "output" | "error" | "metadata";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "error", label: "Error" },
  { key: "metadata", label: "Metadata" },
];

const STATE_TEXT: Record<StepVisualState, string> = {
  idle: "text-subtle",
  pending: "text-subtle",
  running: "text-signal-text",
  retrying: "text-warn",
  waiting: "text-info",
  completed: "text-ok",
  failed: "text-danger",
  skipped: "text-idle",
  cancelled: "text-muted",
};

interface ProviderCall {
  provider?: unknown;
  operation?: unknown;
  method?: unknown;
  url?: unknown;
  status?: unknown;
  ok?: unknown;
  durationMs?: unknown;
  requestId?: unknown;
  error?: unknown;
}

function providerCallsOf(step: ExecutionStepView): ProviderCall[] {
  const metadata = step.metadata;
  if (!metadata || typeof metadata !== "object") return [];
  const calls = (metadata as { providerCalls?: unknown }).providerCalls;
  return Array.isArray(calls) ? (calls as ProviderCall[]) : [];
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <dt className="w-[92px] shrink-0 text-[10.5px] text-subtle">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-[12px] text-fg">{value}</dd>
    </div>
  );
}

function ProviderCalls({ calls }: { calls: ProviderCall[] }) {
  if (calls.length === 0) return null;
  return (
    <section className="mt-5">
      <div className="flex items-center gap-1.5">
        <Radio className="h-3 w-3 text-subtle" />
        <h3 className="kz-eyebrow text-[9.5px]">Outbound calls</h3>
        <span className="kz-num ml-auto text-[10px] text-subtle">{calls.length}</span>
      </div>
      <ul className="mt-2 divide-y divide-hairline border-y border-edge">
        {calls.map((call, index) => {
          const status = typeof call.status === "number" ? call.status : null;
          const failed = call.ok === false;
          return (
            <li key={index} className="flex items-start gap-2.5 py-2">
              <span
                className={cn(
                  "kz-num mt-px shrink-0 rounded-sm px-1.5 py-[1px] text-[9.5px]",
                  failed ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok",
                )}
              >
                {status === null ? "ERR" : status}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="kz-num text-[11px] uppercase tracking-[0.08em] text-muted">
                    {String(call.method ?? "GET")}
                  </span>
                  <span className="truncate text-[12px] text-fg">
                    {String(call.operation ?? call.provider ?? "request")}
                  </span>
                  <span className="kz-num ml-auto shrink-0 text-[10.5px] text-subtle">
                    {formatDuration(Number(call.durationMs ?? 0))}
                  </span>
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10.5px] text-subtle">
                  {String(call.url ?? "")}
                </span>
                {typeof call.error === "string" && call.error && (
                  <span className="mt-0.5 block truncate text-[11px] text-danger">
                    {call.error}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AttemptTraceList({ step }: { step: ExecutionStepView }) {
  const attempts = attemptsOf(step);
  if (attempts.length <= 1 && step.attempt <= 1) return null;

  return (
    <section className="mt-5">
      <div className="flex items-center gap-1.5">
        <Wrench className="h-3 w-3 text-subtle" />
        <h3 className="kz-eyebrow text-[9.5px]">Attempts</h3>
        <span className="kz-num ml-auto text-[10px] text-subtle">{attempts.length}</span>
      </div>
      <ol className="mt-2 divide-y divide-hairline border-y border-edge">
        {attempts.map((attempt, index) => (
          <li key={`${attempt.attempt}-${index}`} className="flex items-start gap-2.5 py-2">
            <span className="kz-num w-6 shrink-0 pt-0.5 text-[10.5px] text-subtle">
              #{attempt.attempt}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "text-[12px]",
                    attempt.outcome === "completed"
                      ? "text-ok"
                      : attempt.outcome === "retrying"
                        ? "text-warn"
                        : attempt.outcome === "failed"
                          ? "text-danger"
                          : "text-muted",
                  )}
                >
                  {attempt.outcome === "retrying"
                    ? `failed · retrying in ${formatDuration(attempt.delayMs ?? 0)}`
                    : attempt.outcome}
                </span>
                {attempt.durationMs !== undefined && (
                  <span className="kz-num ml-auto text-[10.5px] text-subtle">
                    {formatDuration(attempt.durationMs)}
                  </span>
                )}
              </span>
              {attempt.code && (
                <span className="mt-0.5 block truncate text-[11.5px] text-muted">
                  {attempt.code}
                  {attempt.message ? ` — ${attempt.message}` : ""}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function StepInspector({
  step,
  runStartedAtMs,
}: {
  step: ExecutionStepView | null;
  runStartedAtMs: number | null;
}) {
  const [tab, setTab] = React.useState<Tab>("overview");
  const [lastNode, setLastNode] = React.useState<string | null>(null);

  const nodeId = step?.nodeId ?? null;
  if (nodeId !== lastNode) {
    setLastNode(nodeId);
    setTab(step?.error ? "error" : "overview");
  }

  if (!step) {
    return (
      <div className="border-t border-line px-4 py-10 text-center">
        <p className="text-[12.5px] text-muted">Select a step</p>
        <p className="mt-1 text-[11.5px] text-subtle">
          Pick a node on the canvas or a row in the timeline to inspect what it did.
        </p>
      </div>
    );
  }

  const state = stepVisualState(step);
  const meta = statusMeta(
    state === "retrying" || state === "cancelled" ? "running" : state,
  );
  const offset = stepOffset(step, runStartedAtMs);
  const calls = providerCallsOf(step);

  return (
    <div className="flex min-h-0 flex-col">
      {/* header ---------------------------------------------------- */}
      <div className="border-b border-line px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="kz-display min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">
            {step.nodeLabel}
          </h2>
          <span
            className={cn(
              "kz-eyebrow rounded-sm px-1.5 py-[2px] text-[9px]",
              state === "retrying"
                ? "bg-warn-soft text-warn"
                : state === "cancelled"
                  ? "bg-raised text-muted"
                  : meta.chip,
            )}
          >
            {state}
          </span>
        </div>
        <p className="mt-1 truncate font-mono text-[11px] text-subtle">
          {step.ref} · {step.nodeType}
        </p>
        <dl className="mt-2 grid grid-cols-3 gap-2">
          <div>
            <dt className="kz-eyebrow text-[9px]">Offset</dt>
            <dd className="kz-num text-[12px] text-fg">
              {offset === null ? "—" : formatOffset(offset)}
            </dd>
          </div>
          <div>
            <dt className="kz-eyebrow text-[9px]">Duration</dt>
            <dd className="kz-num text-[12px] text-fg">
              {step.status === "pending" ? "—" : formatDuration(step.durationMs)}
            </dd>
          </div>
          <div>
            <dt className="kz-eyebrow text-[9px]">Attempt</dt>
            <dd className="kz-num text-[12px] text-fg">
              {step.attempt || 1}
              {step.metadata?.providerCallCount !== undefined && (
                <span className="text-subtle">
                  {" "}
                  · {Number(step.metadata.providerCallCount)} call
                  {Number(step.metadata.providerCallCount) === 1 ? "" : "s"}
                </span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      {/* tabs ------------------------------------------------------ */}
      <div className="flex items-center gap-0.5 overflow-x-auto border-b border-edge px-2 py-1.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              "shrink-0 rounded-sm px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors",
              tab === item.key ? "bg-raised text-fg" : "text-subtle hover:text-muted",
            )}
          >
            {item.label}
            {item.key === "error" && step.error && (
              <span className="ml-1 text-danger" aria-label="has error">
                •
              </span>
            )}
          </button>
        ))}
      </div>

      {/* body ------------------------------------------------------ */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "overview" && (
          <div className="px-3 py-3">
            <dl className="divide-y divide-hairline border-y border-edge">
              <Field label="State" value={<span className={STATE_TEXT[state]}>{state}</span>} />
              <Field label="Node type" value={<span className="font-mono text-[11.5px]">{step.nodeType}</span>} />
              <Field label="Reference" value={<span className="font-mono text-[11.5px]">{step.ref}</span>} />
              <Field label="Started" value={offset === null ? "—" : formatOffset(offset)} />
              <Field
                label="Branch"
                value={step.branch ? <span className="font-mono text-[11.5px]">{step.branch}</span> : "—"}
              />
              <Field
                label="Settled"
                value={
                  step.completedAtMs === null
                    ? "—"
                    : new Date(step.completedAtMs).toISOString()
                }
              />
            </dl>

            {step.error && (
              <div className="mt-4">
                <ErrorPanel error={step.error} />
              </div>
            )}

            <AttemptTraceList step={step} />
            <ProviderCalls calls={calls} />
          </div>
        )}

        {tab === "input" && <DataViewer value={step.input} resetKey={`input:${step.nodeId}`} />}

        {tab === "output" && (
          <DataViewer
            value={step.output}
            resetKey={`output:${step.nodeId}`}
            emptyLabel="No output recorded yet"
          />
        )}

        {tab === "error" &&
          (step.error ? (
            <ErrorPanel error={step.error} />
          ) : (
            <p className="px-3 py-6 text-center text-[12px] text-subtle">
              This step recorded no error.
            </p>
          ))}

        {tab === "metadata" && (
          <DataViewer
            value={step.metadata ?? null}
            resetKey={`metadata:${step.nodeId}`}
            emptyLabel="No metadata for this step"
          />
        )}
      </div>
    </div>
  );
}
