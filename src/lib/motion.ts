/**
 * Motion tokens — a single source of truth for KLYZ timing and easing.
 *
 * Hierarchy:
 *   micro     100–180ms   hover, focus, press, tooltip
 *   standard  180–280ms   panels, dropdowns, node state changes
 *   complex   280–450ms   layout shifts, drawer/modal transitions
 *   page      180–200ms   route transitions (template.tsx)
 *   reveal    500–900ms   scroll entrances, split-text reveals
 *   flow      400–1400ms  execution travel along an edge (reads as physical)
 */

const EASE = {
  out: [0.22, 1, 0.36, 1] as const,
  expo: [0.16, 1, 0.3, 1] as const,
  inOut: [0.65, 0, 0.35, 1] as const,
  emph: [0.2, 0, 0, 1] as const,
  spring: [0.34, 1.4, 0.64, 1] as const,
};

const DURATION = {
  instant: 0.08,
  micro: 0.14,
  standard: 0.22,
  complex: 0.36,
  reveal: 0.72,
  slow: 0.52,
  flow: 0.9,
} as const;

/** Shared Framer Motion transition presets. */
export const MOTION = {
  micro: { duration: DURATION.micro, ease: EASE.out },
  standard: { duration: DURATION.standard, ease: EASE.out },
  complex: { duration: DURATION.complex, ease: EASE.emph },
  page: { duration: 0.19, ease: EASE.expo },
  reveal: { duration: DURATION.reveal, ease: EASE.expo },
  slow: { duration: DURATION.slow, ease: EASE.expo },
  spring: { type: "spring", stiffness: 420, damping: 32, mass: 0.9 },
  springSoft: { type: "spring", stiffness: 260, damping: 30 },
} as const;

/** Stagger step for sequenced reveals (words, rows, nodes). */
export const STAGGER = {
  tight: 0.035,
  standard: 0.06,
  loose: 0.1,
} as const;
