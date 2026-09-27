"use client";

import * as React from "react";
import { Glyph } from "@/components/icons";
import { useClientValue } from "@/lib/react";
import { formatDuration, cn } from "@/lib/utils";

interface Step {
  icon: string;
  title: string;
  detail: string;
  durationMs: number;
  output: Array<[string, string]>;
}

const STEPS: Step[] = [
  {
    icon: "webhook",
    title: "Webhook",
    detail: "issue.opened · klyz/platform",
    durationMs: 14,
    output: [
      ["event", "issue.opened"],
      ["repository", "klyz/platform"],
      ["issue.number", "1042"],
    ],
  },
  {
    icon: "split",
    title: "Condition",
    detail: "priority equals high",
    durationMs: 3,
    output: [
      ["matched", "true"],
      ["branch", "true"],
      ["evaluated", "3 rules"],
    ],
  },
  {
    icon: "sparkle",
    title: "Extract fields",
    detail: "ai.extract · structured",
    durationMs: 486,
    output: [
      ["priority", "high"],
      ["team", "billing"],
      ["tokens", "184"],
    ],
  },
  {
    icon: "slack",
    title: "Notify #support",
    detail: "slack.postMessage",
    durationMs: 112,
    output: [
      ["channel", "#support"],
      ["ts", "1727248462.004100"],
      ["status", "200"],
    ],
  },
];

type StepState = "pending" | "running" | "successful";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The hero's living artefact: a real KLYZ-shaped run, replaying step by step.
 * It exists to show the product's core promise — every run is inspectable —
 * rather than to decorate the page.
 */
export function HeroFlow() {
  const reduced = useClientValue(false, prefersReducedMotion);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    if (reduced) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1050);
    return () => clearInterval(timer);
  }, [reduced]);

  const total = STEPS.length;
  const cycle = total + 2;
  const phase = reduced ? total + 1 : tick % cycle;

  const stateOf = (index: number): StepState => {
    if (phase === 0) return "pending";
    if (phase === index + 1) return "running";
    if (phase > index + 1) return "successful";
    return "pending";
  };

  const states = STEPS.map((_, index) => stateOf(index));
  const runningIndex = states.findIndex((state) => state === "running");
  const elapsed = STEPS.reduce(
    (sum, step, index) => (states[index] === "successful" ? sum + step.durationMs : sum),
    0,
  );

  const status =
    phase === 0 ? "Queued" : runningIndex >= 0 ? "Running" : "Successful";
  const statusTone =
    phase === 0
      ? "bg-raised text-muted"
      : runningIndex >= 0
        ? "bg-signal-soft text-signal-text"
        : "bg-ok-soft text-ok";

  const shownOutput =
    runningIndex > 0
      ? STEPS[runningIndex - 1]
      : runningIndex === -1
        ? STEPS[total - 1]
        : null;

  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-panel shadow-lg">
      {/* title bar ------------------------------------------------- */}
      <div className="flex items-center gap-3 border-b border-edge bg-raised px-3.5 py-2.5">
        <span className="kz-num text-[11px] text-subtle">run_8F2A</span>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[11px] font-medium leading-none",
            statusTone,
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              phase === 0 ? "bg-subtle" : runningIndex >= 0 ? "bg-signal kz-breathe" : "bg-ok",
            )}
            aria-hidden
          />
          {status}
        </span>
        <span className="kz-num ml-auto text-[11px] text-muted">
          {phase === 0 ? "—" : formatDuration(elapsed)}
        </span>
      </div>

      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,240px)]">
        {/* chain ---------------------------------------------------- */}
        <ol className="kz-canvas-grid relative -m-3 rounded-lg border border-hairline bg-canvas p-3 sm:m-0 sm:border-0 sm:bg-transparent sm:p-0">
          {STEPS.map((step, index) => {
            const state = states[index];
            const nextActive = index < total - 1 && states[index + 1] === "running";

            return (
              <li key={step.title} className="relative">
                <div
                  className={cn(
                    "flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-all duration-complex ease-out",
                    state === "running"
                      ? "border-signal/55 bg-surface shadow-[0_0_0_3px_var(--kz-signal-soft)]"
                      : state === "successful"
                        ? "border-edge bg-surface"
                        : "border-hairline bg-surface/60 opacity-70",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors",
                      state === "running"
                        ? "border-signal/40 bg-signal-soft text-signal-text"
                        : state === "successful"
                          ? "border-edge bg-raised text-ok"
                          : "border-edge bg-raised text-muted",
                    )}
                  >
                    <Glyph
                      name={step.icon}
                      className={cn("h-4 w-4", state === "running" && "kz-breathe")}
                    />
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium leading-tight text-fg">
                      {step.title}
                    </span>
                    <span className="mt-1 block truncate text-[11px] leading-tight text-subtle">
                      {step.detail}
                    </span>
                  </span>

                  <span className="shrink-0 pt-0.5 text-right">
                    {state === "running" ? (
                      <span className="kz-eyebrow text-[9px] text-signal-text">Running</span>
                    ) : state === "successful" ? (
                      <span className="kz-num text-[10.5px] text-ok">
                        {formatDuration(step.durationMs)}
                      </span>
                    ) : (
                      <span className="kz-eyebrow text-[9px]">Queued</span>
                    )}
                  </span>
                </div>

                {index < total - 1 && (
                  <span
                    aria-hidden
                    className={cn(
                      "relative ml-[26px] block h-5 w-px",
                      states[index] === "successful" ? "bg-strong" : "bg-line",
                    )}
                  >
                    {nextActive && (
                      <span className="kz-rail-packet absolute left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-signal" />
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        {/* output --------------------------------------------------- */}
        <div className="flex flex-col rounded-lg border border-edge bg-inset">
          <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
            <span className="kz-eyebrow text-[9px]">Output</span>
            <span className="kz-num ml-auto text-[10px] text-subtle">
              {shownOutput ? `{{${shownOutput.title.toLowerCase().replace(/\s+/g, "_")}}}` : "waiting"}
            </span>
          </div>

          <div className="min-h-[152px] flex-1 px-3 py-2.5 font-mono text-[11.5px] leading-[1.7]">
            {shownOutput ? (
              shownOutput.output.map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <span className="text-subtle">&quot;{key}&quot;</span>
                  <span className="text-subtle">:</span>
                  <span className="min-w-0 break-all text-ok">&quot;{value}&quot;</span>
                </div>
              ))
            ) : (
              <div className="text-subtle">
                <span className="text-subtle">$</span> klyz run --watch
                <span className="kz-caret ml-1 inline-block h-3 w-[7px] translate-y-[2px] bg-signal" />
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-hairline px-3 py-2">
            <span className="kz-eyebrow text-[9px]">Steps</span>
            <span className="kz-num text-[10.5px] text-muted">
              {states.filter((state) => state === "successful").length}/{total}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
