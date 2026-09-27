"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { MOTION, STAGGER } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Word-by-word masked reveal for display headings.
 * Each word sits in a padded overflow-hidden wrapper (padding + negative
 * margin so ascenders/descenders never clip at line-height < 1), rises from
 * below the mask, and lands with a tight stagger. Reduced motion → static.
 */
export function SplitHeading({
  text,
  className,
  as: Tag = "h2",
  delay = 0,
  stagger,
}: {
  text: string;
  className?: string;
  as?: "h1" | "h2" | "h3" | "p" | "span";
  delay?: number;
  stagger?: number;
}) {
  const reduced = useReducedMotion();
  const words = text.split(" ");

  if (reduced) {
    return <Tag className={className}>{text}</Tag>;
  }

  return (
    <Tag className={className}>
      {words.map((word, index) => (
        <React.Fragment key={`${word}-${index}`}>
          {index > 0 ? " " : null}
          {/* The wrapper is the IntersectionObserver target: the inner word
              sits clipped below the mask, and a clipped element never
              intersects, so whileInView must live on the wrapper. Variants
              propagate down to the moving word. */}
          <motion.span
            className="inline-block overflow-hidden pt-[0.2em] pb-[0.22em] -mt-[0.2em] -mb-[0.22em] align-bottom"
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-8% 0px" }}
            variants={{ hidden: {}, show: {} }}
          >
            <motion.span
              className="inline-block will-change-transform"
              variants={{
                hidden: { y: "150%" },
                show: {
                  y: "0%",
                  transition: {
                    duration: MOTION.reveal.duration,
                    ease: MOTION.reveal.ease,
                    delay: delay + index * (stagger ?? STAGGER.standard),
                  },
                },
              }}
            >
              {word}
            </motion.span>
          </motion.span>
        </React.Fragment>
      ))}
    </Tag>
  );
}

const TAGS = {
  div: motion.div,
  section: motion.section,
  li: motion.li,
  p: motion.p,
} as const;

/** Quiet entrance for paragraphs, lists and composed blocks. */
export function FadeUp({
  children,
  className,
  delay = 0,
  y = 18,
  as = "div",
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  as?: keyof typeof TAGS;
}) {
  const reduced = useReducedMotion();
  const Comp = TAGS[as];

  return (
    <Comp
      className={cn(className)}
      initial={reduced ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-8% 0px" }}
      transition={{
        duration: MOTION.reveal.duration,
        ease: MOTION.reveal.ease,
        delay,
      }}
    >
      {children}
    </Comp>
  );
}
