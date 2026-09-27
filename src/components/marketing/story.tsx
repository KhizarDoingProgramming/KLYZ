"use client";

import * as React from "react";
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
} from "motion/react";
import { Glyph } from "@/components/icons";
import { FadeUp } from "@/components/marketing/reveal";
import { CATEGORY_STYLE } from "@/lib/workflow/category";
import { MOTION } from "@/lib/motion";
import { cn } from "@/lib/utils";

type PhaseCategory = "trigger" | "logic" | "action" | "result";

interface Phase {
  idx: string;
  key: string;
  head: string;
  body: string;
  meta: string[];
  node: {
    icon: string;
    title: string;
    sub: string;
    category: PhaseCategory;
    time: string;
  };
}

const PHASES: Phase[] = [
  {
    idx: "01",
    key: "EVENT",
    head: "Something happened.",
    body: "A webhook lands, a cron fires, an issue opens. Triggers are ordinary nodes — same config surface, same visibility — and filters run before a single step executes.",
    meta: ["POST /api/webhooks/gh_9f2 · 202", "HMAC signature verified · 14ms"],
    node: {
      icon: "webhook",
      title: "Webhook",
      sub: "issue.opened · klyz/platform",
      category: "trigger",
      time: "14ms",
    },
  },
  {
    idx: "02",
    key: "PROCESS",
    head: "The data is shaped.",
    body: "Transform maps fields and expressions pull upstream values into exactly the shape the next step expects. Nothing is lost between steps.",
    meta: ["{{steps.0.payload}} → map", "4 fields rewritten · 3ms"],
    node: {
      icon: "braces",
      title: "Transform",
      sub: "logic.transform · map",
      category: "logic",
      time: "3ms",
    },
  },
  {
    idx: "03",
    key: "LOGIC",
    head: "A decision is made.",
    body: "Conditions branch, switches route, filters drop what doesn't match. Only one path continues — and the run records exactly which one.",
    meta: ["priority = \"high\" → true", "3 rules evaluated · branch A"],
    node: {
      icon: "git-branch",
      title: "Condition",
      sub: "priority equals high",
      category: "logic",
      time: "3ms",
    },
  },
  {
    idx: "04",
    key: "ACTION",
    head: "The world changes.",
    body: "HTTP calls, SQL writes, Slack messages — each with scoped credentials, a real response captured as output and a retry policy behind it.",
    meta: ["slack.postMessage → #support", "200 OK · 112ms"],
    node: {
      icon: "slack",
      title: "Notify #support",
      sub: "action.slack_message",
      category: "action",
      time: "112ms",
    },
  },
  {
    idx: "05",
    key: "RESULT",
    head: "Nothing is hidden.",
    body: "Input, output, cost and duration for every step. Replay the run, open any step, or re-run from the failure instead of from scratch.",
    meta: ["EXECUTION / 0148 · COMPLETED", "4/4 steps · 1.42s · 184 tokens"],
    node: {
      icon: "circleCheck",
      title: "Result",
      sub: "4 of 4 steps succeeded",
      category: "result",
      time: "1.42s",
    },
  },
];

function useDesktop() {
  const [desktop, setDesktop] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => setDesktop(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return desktop;
}

function categoryClasses(category: PhaseCategory) {
  if (category === "result") {
    return {
      text: "text-ok",
      chip: "bg-ok/12",
      border: "border-ok/35",
      dot: "bg-ok",
    };
  }
  return CATEGORY_STYLE[category];
}

function NodeChip({
  phase,
  state,
}: {
  phase: Phase;
  state: "pending" | "active" | "done";
}) {
  const style = categoryClasses(phase.node.category);
  return (
    <div
      className={cn(
        "w-[176px] shrink-0 rounded-lg border bg-surface p-3 transition-all duration-complex ease-out sm:w-[200px]",
        state === "active"
          ? "border-signal/55 shadow-[0_0_0_3px_var(--kz-signal-soft)]"
          : state === "done"
            ? "border-edge"
            : "border-hairline opacity-55",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border",
            style.border,
            style.chip,
            style.text,
          )}
        >
          <Glyph name={phase.node.icon} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium leading-tight text-fg">
            {phase.node.title}
          </span>
          <span className="kz-num mt-0.5 block truncate text-[10px] leading-tight text-subtle">
            {phase.node.sub}
          </span>
        </span>
      </div>
      <div className="mt-2.5 flex items-center justify-between border-t border-hairline pt-2">
        <span
          className={cn(
            "kz-eyebrow text-[9px]",
            state === "active" ? "text-signal-text" : "",
          )}
        >
          {state === "active" ? "Running" : state === "done" ? "Complete" : "Queued"}
        </span>
        <span
          className={cn(
            "kz-num text-[10.5px]",
            state === "done" ? "text-ok" : "text-subtle",
          )}
        >
          {state === "pending" ? "—" : phase.node.time}
        </span>
      </div>
    </div>
  );
}

function Edge({ active, flowing }: { active: boolean; flowing: boolean }) {
  return (
    <span
      aria-hidden
      className="relative mx-1 hidden h-px w-full min-w-8 flex-1 overflow-visible sm:block"
    >
      <span
        className={cn(
          "absolute inset-0 block origin-left transition-transform duration-700 ease-out",
          active ? "scale-x-100 bg-strong" : "scale-x-0 bg-line",
        )}
        style={{ transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)" }}
      />
      {flowing && (
        <span className="kz-packet-x absolute top-1/2 block h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-signal" />
      )}
    </span>
  );
}

export function Story() {
  const ref = React.useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const desktop = useDesktop();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });
  const [active, setActive] = React.useState(0);

  useMotionValueEvent(scrollYProgress, "change", (value) => {
    const next = Math.max(0, Math.min(PHASES.length - 1, Math.floor(value * 5)));
    setActive(next);
  });

  const phase = (PHASES[active] ?? PHASES[0])!;
  const slide = reduced
    ? { initial: false as const, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, y: 22 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -14 },
      };

  if (!desktop) {
    return (
      <section id="story" ref={ref} className="border-b border-edge bg-canvas">
        <div className="kz-frame py-16">
          <FadeUp className="border-b border-edge pb-10">
            <p className="kz-eyebrow mb-4">The run</p>
            <h2 className="max-w-[16ch] text-display-sm font-semibold text-fg">
              One run, start to finish.
            </h2>
          </FadeUp>

          <ol className="mt-10 space-y-14">
            {PHASES.map((item) => (
              <FadeUp as="li" key={item.key}>
                <div className="flex items-baseline gap-4">
                  <span className="kz-num text-[13px] text-signal-text">{item.idx}</span>
                  <span className="kz-display text-[34px] font-semibold uppercase leading-none tracking-[-0.03em] text-fg">
                    {item.key}
                  </span>
                </div>
                <p className="kz-display mt-4 text-[19px] font-semibold text-fg">
                  {item.head}
                </p>
                <p className="mt-2 max-w-[54ch] text-[14.5px] leading-relaxed text-muted">
                  {item.body}
                </p>
                <ul className="mt-4 space-y-1">
                  {item.meta.map((line) => (
                    <li key={line} className="kz-num text-[11.5px] text-subtle">
                      → {line}
                    </li>
                  ))}
                </ul>
                <div className="mt-5">
                  <NodeChip phase={item} state="done" />
                </div>
              </FadeUp>
            ))}
          </ol>
        </div>
      </section>
    );
  }

  return (
    <section
      id="story"
      ref={ref}
      aria-label="How a run moves through KLYZ"
      className="relative border-b border-edge bg-canvas"
      style={{ height: "480vh" }}
    >
      <div className="sticky top-0 h-dvh overflow-hidden">
        {/* scroll progress */}
        <motion.div
          aria-hidden
          className="absolute inset-x-0 top-0 z-10 h-[2px] origin-left bg-signal"
          style={{ scaleX: scrollYProgress }}
        />

        <div className="kz-frame flex h-dvh flex-col">
          {/* kicker row */}
          <div className="flex items-center justify-between border-b border-hairline py-3">
            <span className="kz-eyebrow text-muted">The run · event to result</span>
            <span className="kz-num text-[10.5px] text-subtle">
              {phase.idx} / 05 — {phase.key}
            </span>
          </div>

          <div className="grid min-h-0 flex-1 lg:grid-cols-[264px_minmax(0,1fr)]">
            {/* phase rail */}
            <ol className="hidden min-h-0 flex-col justify-center border-r border-hairline pr-8 lg:flex">
              {PHASES.map((item, index) => {
                const isActive = index === active;
                const isDone = index < active;
                return (
                  <li
                    key={item.key}
                    className={cn(
                      "relative flex items-center gap-3.5 py-3 transition-colors duration-standard",
                      isActive ? "text-fg" : isDone ? "text-muted" : "text-disabled",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-standard",
                        isActive
                          ? "bg-signal"
                          : isDone
                            ? "bg-strong"
                            : "bg-line",
                      )}
                    />
                    <span className="kz-num text-[11px]">{item.idx}</span>
                    <span
                      className={cn(
                        "kz-display text-[15px] font-semibold uppercase tracking-[0.02em]",
                        isActive && "[font-stretch:88%]",
                      )}
                    >
                      {item.key}
                    </span>
                    {isActive && (
                      <motion.span
                        layoutId="story-marker"
                        className="absolute -left-[calc(2rem+1px)] h-6 w-[2px] bg-signal"
                        transition={MOTION.standard}
                      />
                    )}
                  </li>
                );
              })}
            </ol>

            {/* phase copy */}
            <div className="flex min-h-0 flex-col justify-center px-0 py-8 lg:pl-14">
              <AnimatePresence mode="wait">
                <motion.div
                  key={phase.key}
                  initial={slide.initial}
                  animate={slide.animate}
                  exit={slide.exit}
                  transition={{
                    duration: MOTION.standard.duration,
                    ease: MOTION.reveal.ease,
                  }}
                >
                  <div className="flex items-baseline gap-5">
                    <span className="kz-num text-[13px] text-signal-text">
                      {phase.idx}
                    </span>
                    <h2 className="kz-display text-display-md font-semibold uppercase text-fg [font-stretch:92%]">
                      {phase.key}
                    </h2>
                  </div>
                  <p className="kz-display mt-6 text-[22px] font-semibold leading-snug text-fg">
                    {phase.head}
                  </p>
                  <p className="mt-3 max-w-[54ch] text-[15px] leading-relaxed text-muted">
                    {phase.body}
                  </p>
                  <ul className="mt-6 border-t border-hairline">
                    {phase.meta.map((line) => (
                      <li
                        key={line}
                        className="kz-num flex items-center gap-3 border-b border-hairline py-2.5 text-[11.5px] text-subtle"
                      >
                        <span className="text-signal-text">→</span>
                        {line}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              </AnimatePresence>
            </div>
          </div>

          {/* assembling chain */}
          <div className="kz-canvas-grid border-t border-edge">
            <div className="flex items-center overflow-x-auto px-4 py-6 lg:px-0">
              {PHASES.map((item, index) => (
                <React.Fragment key={item.key}>
                  {index > 0 && (
                    <Edge
                      active={index <= active}
                      flowing={index === active}
                    />
                  )}
                  <NodeChip
                    phase={item}
                    state={
                      index < active
                        ? "done"
                        : index === active
                          ? "active"
                          : "pending"
                    }
                  />
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
