import type {
  ExecutionStatus,
  NodeStatus,
  WorkflowStatus,
} from "@/lib/workflow/types";

type StatusKey =
  | WorkflowStatus
  | ExecutionStatus
  | NodeStatus
  | "unknown";

interface StatusMeta {
  label: string;
  /** Text colour utility for the label. */
  text: string;
  /** Solid dot / glyph colour. */
  dot: string;
  /** Tinted background utility. */
  chip: string;
  /** Ring utility used by live nodes on the canvas. */
  ring: string;
}

/**
 * Single source of truth for how every state in KLYZ is presented.
 * The editor, the inspector, the dashboard and the run list all read
 * from here so a status can never look different in two places.
 */
const STATUS_META: Record<StatusKey, StatusMeta> = {
  /* workflow */
  draft: {
    label: "Draft",
    text: "text-subtle",
    dot: "bg-subtle",
    chip: "bg-raised text-muted",
    ring: "ring-strong",
  },
  active: {
    label: "Active",
    text: "text-ok",
    dot: "bg-ok",
    chip: "bg-ok-soft text-ok",
    ring: "ring-ok/50",
  },
  paused: {
    label: "Paused",
    text: "text-warn",
    dot: "bg-warn",
    chip: "bg-warn-soft text-warn",
    ring: "ring-warn/50",
  },
  disabled: {
    label: "Disabled",
    text: "text-disabled",
    dot: "bg-disabled",
    chip: "bg-raised text-disabled",
    ring: "ring-strong",
  },

  /* execution */
  queued: {
    label: "Queued",
    text: "text-subtle",
    dot: "bg-subtle",
    chip: "bg-raised text-muted",
    ring: "ring-strong",
  },
  running: {
    label: "Running",
    text: "text-live",
    dot: "bg-live",
    chip: "bg-live-soft text-live",
    ring: "ring-live/60",
  },
  waiting: {
    label: "Waiting",
    text: "text-info",
    dot: "bg-info",
    chip: "bg-info-soft text-info",
    ring: "ring-info/50",
  },
  completed: {
    label: "Completed",
    text: "text-ok",
    dot: "bg-ok",
    chip: "bg-ok-soft text-ok",
    ring: "ring-ok/50",
  },
  failed: {
    label: "Failed",
    text: "text-danger",
    dot: "bg-danger",
    chip: "bg-danger-soft text-danger",
    ring: "ring-danger/60",
  },
  cancelled: {
    label: "Cancelled",
    text: "text-subtle",
    dot: "bg-subtle",
    chip: "bg-raised text-muted",
    ring: "ring-strong",
  },
  /* node */
  idle: {
    label: "Idle",
    text: "text-subtle",
    dot: "bg-subtle",
    chip: "bg-raised text-muted",
    ring: "ring-strong",
  },
  pending: {
    label: "Pending",
    text: "text-subtle",
    dot: "bg-subtle",
    chip: "bg-raised text-muted",
    ring: "ring-strong",
  },
  skipped: {
    label: "Skipped",
    text: "text-idle",
    dot: "bg-idle",
    chip: "bg-raised text-idle",
    ring: "ring-strong",
  },

  unknown: {
    label: "Unknown",
    text: "text-subtle",
    dot: "bg-subtle",
    chip: "bg-raised text-muted",
    ring: "ring-strong",
  },
};

export function statusMeta(key: string): StatusMeta {
  return STATUS_META[key as StatusKey] ?? STATUS_META.unknown;
}

/** Edge states reuse node semantics; these are the only extras. */
export type EdgeVisualState = "idle" | "active" | "completed" | "failed" | "skipped" | "waiting";

export const EDGE_STROKE: Record<EdgeVisualState, string> = {
  idle: "var(--kz-line)",
  active: "var(--kz-signal)",
  completed: "var(--kz-ok)",
  failed: "var(--kz-danger)",
  skipped: "var(--kz-idle)",
  waiting: "var(--kz-info)",
};
