"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { HeroFlow } from "@/components/marketing/hero-flow";
import { SplitHeading } from "@/components/marketing/reveal";
import { Roll } from "@/components/ui/roll";
import { MOTION } from "@/lib/motion";
import { cn } from "@/lib/utils";

const METRICS = [
  { value: "26", label: "node types in the registry" },
  { value: "06", label: "node categories" },
  { value: "SSE", label: "live run events to the canvas" },
  { value: "100%", label: "of steps logged with I/O" },
];

/** A restrained magnetic pull on the primary CTA — pointer-only, capped. */
function MagneticCta({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLAnchorElement>(null);
  const reduced = useReducedMotion();

  const move = (event: React.PointerEvent) => {
    if (reduced || event.pointerType !== "mouse" || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    const x = Math.max(-9, Math.min(9, dx * 0.16));
    const y = Math.max(-7, Math.min(7, dy * 0.3));
    ref.current.style.transform = `translate(${x}px, ${y}px)`;
  };

  const leave = () => {
    if (!ref.current) return;
    ref.current.style.transition = "transform 420ms cubic-bezier(0.16,1,0.3,1)";
    ref.current.style.transform = "translate(0px, 0px)";
    window.setTimeout(() => {
      if (ref.current) ref.current.style.transition = "";
    }, 440);
  };

  return (
    <span className="inline-block" onPointerMove={move} onPointerLeave={leave}>
      <Link ref={ref} href={href} className={className}>
        {children}
      </Link>
    </span>
  );
}

export function Hero() {
  const reduced = useReducedMotion();

  return (
    <section className="relative overflow-hidden border-b border-edge">
      {/* quiet canvas grid, right-anchored */}
      <div
        aria-hidden
        className="kz-canvas-grid pointer-events-none absolute inset-y-0 right-0 w-[58%] opacity-45 [mask-image:linear-gradient(90deg,transparent,black_35%)]"
      />

      <div className="kz-frame relative flex min-h-[calc(100dvh-57px)] flex-col">
        {/* meta row ---------------------------------------------------- */}
        <motion.div
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, ease: MOTION.reveal.ease }}
          className="flex items-center justify-between border-b border-hairline py-3.5"
        >
          <span className="kz-eyebrow text-muted">Visual workflow automation</span>
          <span className="kz-eyebrow hidden text-subtle sm:block">
            Local runtime · 2026.09
          </span>
        </motion.div>

        {/* main -------------------------------------------------------- */}
        <div className="grid flex-1 items-center gap-12 py-14 lg:grid-cols-[minmax(0,1.06fr)_minmax(0,0.94fr)] lg:gap-16 lg:py-16">
          <div>
            <SplitHeading
              as="h1"
              text="AUTOMATE WHAT HAPPENS NEXT."
              className="max-w-[13ch] text-display-lg font-semibold uppercase text-fg [font-stretch:96%]"
              stagger={0.075}
            />

            <motion.p
              initial={reduced ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: MOTION.reveal.ease, delay: 0.45 }}
              className="mt-7 max-w-[46ch] text-[16px] leading-relaxed text-muted"
            >
              KLYZ turns events, data, logic, APIs and AI into workflows you can
              actually watch. Every step shows its input, its output, its cost
              and exactly how long it took — no black boxes, no guessing which
              branch ran.
            </motion.p>

            <motion.div
              initial={reduced ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: MOTION.reveal.ease, delay: 0.6 }}
              className="mt-9 flex flex-wrap items-center gap-3"
            >
              <MagneticCta
                href="/workflows?new=1"
                className="group inline-flex h-11 select-none items-center justify-center gap-2 rounded-md bg-signal px-5 text-[13.5px] font-medium text-on-signal transition-colors duration-micro hover:bg-signal-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              >
                <Roll>Start building</Roll>
                <ArrowRight className="h-4 w-4 transition-transform duration-standard ease-out group-hover:translate-x-0.5" />
              </MagneticCta>
              <Link
                href="/executions"
                className="group inline-flex h-11 select-none items-center justify-center rounded-md border border-line bg-surface px-5 text-[13.5px] text-fg transition-colors duration-micro hover:border-strong hover:bg-raised"
              >
                <Roll>Inspect a live run</Roll>
              </Link>
            </motion.div>
          </div>

          {/* living artefact ------------------------------------------- */}
          <motion.div
            initial={reduced ? false : { opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, ease: MOTION.reveal.ease, delay: 0.35 }}
            className="lg:pt-4"
          >
            <HeroFlow />
            <div className="mt-3 flex items-center justify-between">
              <span className="kz-eyebrow text-[9px]">
                Run replay · every step inspectable
              </span>
              <span className="kz-num text-[10.5px] text-subtle">run_8F2A</span>
            </div>
          </motion.div>
        </div>

        {/* metrics + scroll cue ---------------------------------------- */}
        <motion.div
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.7, ease: MOTION.reveal.ease, delay: 0.8 }}
          className="flex items-end justify-between border-t border-edge"
        >
          <ul className="grid flex-1 grid-cols-2 sm:grid-cols-4">
            {METRICS.map((metric, index) => (
              <li
                key={metric.label}
                className={cn(
                  "border-hairline px-4 py-5 sm:px-5",
                  index > 0 && "sm:border-l",
                  index % 2 === 1 && "border-l sm:border-l",
                  index >= 2 && "border-t sm:border-t-0",
                )}
              >
                <p className="kz-display text-[26px] leading-none text-fg [font-variant-numeric:tabular-nums]">
                  {metric.value}
                </p>
                <p className="mt-2 max-w-[22ch] text-[11.5px] leading-snug text-subtle">
                  {metric.label}
                </p>
              </li>
            ))}
          </ul>

          <div className="hidden shrink-0 items-center gap-3 border-l border-hairline pl-6 lg:flex">
            <span className="kz-eyebrow text-[9px]">Scroll · Event</span>
            <span className="relative block h-12 w-px overflow-hidden bg-line">
              <span className="kz-rail-packet absolute left-1/2 block h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-signal" />
            </span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
