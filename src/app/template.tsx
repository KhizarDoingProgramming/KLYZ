"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { MOTION } from "@/lib/motion";

/**
 * One restrained route transition: a short lift + fade on the signature
 * ease. Under reduced motion the new page renders instantly.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();

  if (reduced) return <>{children}</>;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: MOTION.page.duration, ease: MOTION.page.ease }}
      className="h-full"
    >
      {children}
    </motion.div>
  );
}
