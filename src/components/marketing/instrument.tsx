"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { SplitHeading, FadeUp } from "@/components/marketing/reveal";
import { Glyph } from "@/components/icons";
import { MOTION } from "@/lib/motion";

const RAIL = [
  { phase: "TRIGGER", step: "webhook.receive", ms: "14ms", icon: "webhook" },
  { phase: "PROCESS", step: "transform.map", ms: "3ms", icon: "braces" },
  { phase: "LOGIC", step: "condition.eval", ms: "3ms", icon: "git-branch" },
  { phase: "ACTION", step: "slack.postMessage", ms: "112ms", icon: "slack" },
  { phase: "RESULT", step: "log.write", ms: "4ms", icon: "terminal" },
];

const FACTS = [
  ["Run", "EXECUTION / 0148"],
  ["Workflow", "Partner Event Relay"],
  ["Trigger", "Webhook · POST /hooks/relay"],
  ["Duration", "1.42s (queued 1.29s)"],
  ["Steps", "4 of 4 completed"],
  ["Tokens", "184 · $0.0011"],
];

/** Execution detail as an instrument reading — editorial, not a card. */
export function Instrument() {
  const reduced = useReducedMotion();

  return (
    <section id="execution" className="border-b border-edge">
      <div className="kz-frame py-20 lg:py-28">
        <div className="grid gap-14 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-20">
          {/* left: statement + facts */}
          <div>
            <p className="kz-eyebrow mb-5">Execution — visible end to end</p>
            <SplitHeading
              text="Input and output for every single step."
              className="max-w-[15ch] text-display-sm font-semibold text-fg"
            />
            <FadeUp delay={0.15}>
              <p className="mt-6 max-w-[52ch] text-[15px] leading-relaxed text-muted">
                Select a step and see exactly what it received and exactly what
                it returned — nested objects included, secrets redacted.
                Reference any upstream value with{" "}
                <code className="kz-num text-[13px] text-signal-text">{`{{ref.path}}`}</code>
                , the same syntax the data picker, the config panel and
                validation use.
              </p>

              <dl className="mt-9 border-t border-edge">
                {FACTS.map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-6 border-b border-hairline py-3"
                  >
                    <dt className="kz-eyebrow">{label}</dt>
                    <dd className="kz-num min-w-0 truncate text-right text-[12.5px] text-fg">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </FadeUp>
          </div>

          {/* right: the instrument */}
          <FadeUp delay={0.1} y={26}>
            <div className="border border-line bg-panel">
              {/* header band */}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-raised px-5 py-3.5">
                <span className="kz-num text-[12px] text-fg">EXECUTION / 0148</span>
                <span className="inline-flex items-center gap-1.5 rounded-sm bg-ok-soft px-2 py-1 text-[11px] font-medium leading-none text-ok">
                  <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
                  COMPLETED
                </span>
                <span className="kz-display ml-auto text-[20px] font-semibold leading-none text-fg [font-variant-numeric:tabular-nums]">
                  1.42s
                </span>
              </div>

              {/* phase rail */}
              <ol className="relative px-5 py-5">
                <motion.span
                  aria-hidden
                  className="absolute bottom-8 left-[30px] top-8 w-px origin-top bg-signal"
                  initial={reduced ? false : { scaleY: 0 }}
                  whileInView={{ scaleY: 1 }}
                  viewport={{ once: true, margin: "-15% 0px" }}
                  transition={{
                    duration: MOTION.reveal.duration * 1.4,
                    ease: MOTION.reveal.ease,
                  }}
                />
                {RAIL.map((row, index) => (
                  <li
                    key={row.phase}
                    className="relative flex items-center gap-4 py-2.5"
                  >
                    <span className="relative z-[1] flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-signal/40 bg-panel text-signal-text">
                      <Glyph name={row.icon} className="h-3 w-3" />
                    </span>
                    <span className="kz-eyebrow w-[74px] shrink-0 text-[9px]">
                      {row.phase}
                    </span>
                    <span className="kz-num min-w-0 flex-1 truncate text-[12.5px] text-fg">
                      {row.step}
                    </span>
                    <span className="kz-eyebrow hidden shrink-0 text-[9px] text-ok sm:block">
                      Done
                    </span>
                    <span className="kz-num w-14 shrink-0 text-right text-[11.5px] text-muted">
                      {row.ms}
                    </span>
                    <span className="sr-only">
                      Phase {index + 1} of {RAIL.length}
                    </span>
                  </li>
                ))}
              </ol>

              {/* input / output split */}
              <div className="grid gap-px border-t border-line bg-line sm:grid-cols-2">
                <div className="bg-inset p-4">
                  <p className="kz-eyebrow mb-2.5 text-[9px]">Input</p>
                  <pre className="font-mono text-[11.5px] leading-[1.75] text-muted">
{`{
  "body": { "title": "…" },
  "priority": "high",
  "thread": {{steps.1.thread}}
}`}
                  </pre>
                </div>
                <div className="bg-inset p-4">
                  <p className="kz-eyebrow mb-2.5 text-[9px]">Output</p>
                  <pre className="font-mono text-[11.5px] leading-[1.75] text-ok">
{`{
  "team": "billing",
  "owner": "mira",
  "tokens": 184
}`}
                  </pre>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-line px-5 py-3">
                <span className="kz-num text-[11px] text-subtle">
                  step · ai.extract
                </span>
                <span className="flex items-center gap-2 text-[11.5px] text-subtle">
                  Expression picker inserts
                  <code className="kz-num rounded-sm bg-inset px-1.5 py-0.5 text-[10.5px] text-signal-text">
                    {`{{ref.path}}`}
                  </code>
                </span>
              </div>
            </div>
          </FadeUp>
        </div>
      </div>
    </section>
  );
}
