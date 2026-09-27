import type { NodeStatus, Workflow } from "@/lib/workflow/types";
import type { ExecutionStepView } from "./types";

/**
 * Pure helpers behind the execution debugger.
 *
 * Everything here is data in → data out: no React, no clocks, no
 * network. The UI stays thin and the interesting decisions — what a step
 * is *really* doing (retrying? parked? cancelled?), where it sits on the
 * timeline, what re-running it would touch — are unit-testable.
 */

export type StepVisualState =
  | "idle"
  | "pending"
  | "running"
  | "retrying"
  | "waiting"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

/**
 * The state a step is actually in.
 *
 * The engine reports `running` with an error attached while it is in
 * backoff, and a cancelled step is stored as `failed` with a `CANCELLED`
 * code — both are collapsed here so no screen has to re-derive them.
 */
export function stepVisualState(step: ExecutionStepView | undefined): StepVisualState {
  if (!step) return "idle";
  if (step.status === "failed" && step.error?.code === "CANCELLED") return "cancelled";
  if (step.status === "running" && step.error) return "retrying";
  return step.status;
}

export function isLiveState(state: StepVisualState): boolean {
  return state === "running" || state === "retrying" || state === "waiting";
}

/**
 * Map a debugger state onto the canvas vocabulary.
 *
 * `retrying` and `cancelled` exist only in the debugger — the canvas
 * paints them as the nearest real node status, so the editor's shared
 * status maps stay exhaustive and unchanged.
 */
export function nodeStatusOf(state: StepVisualState): NodeStatus {
  if (state === "retrying") return "running";
  if (state === "cancelled") return "failed";
  return state;
}

/** Timeline offset as `MM:SS.mmm` — stable width, sortable by eye. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Offset of a step from the run's start, or null when it never started. */
export function stepOffset(
  step: ExecutionStepView,
  runStartedAtMs: number | null,
): number | null {
  if (step.startedAtMs === null || runStartedAtMs === null) return null;
  return Math.max(0, step.startedAtMs - runStartedAtMs);
}

export function failedStepOf(steps: ExecutionStepView[]): ExecutionStepView | null {
  return steps.find((step) => step.status === "failed") ?? null;
}

export function waitingStepOf(steps: ExecutionStepView[]): ExecutionStepView | null {
  return steps.find((step) => step.status === "waiting") ?? null;
}

/** One row per attempt: what failed, how long the engine waited, what happened next. */
export interface AttemptTrace {
  attempt: number;
  outcome: "retrying" | "failed" | "completed" | "skipped";
  /** The attempt the engine scheduled next (retry rows only). */
  nextAttempt?: number;
  /** Delay the engine imposed before the next attempt, when it retried. */
  delayMs?: number;
  code?: string;
  message?: string;
  durationMs?: number;
  at?: number;
}

export function attemptsOf(step: ExecutionStepView | null): AttemptTrace[] {
  if (!step) return [];
  const metadata = step.metadata && typeof step.metadata === "object" ? step.metadata : {};
  const raw = (metadata as { retries?: unknown }).retries;
  const retries: AttemptTrace[] = Array.isArray(raw)
    ? raw
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({
          attempt: Number(item.attempt ?? 1),
          outcome: "retrying" as const,
          nextAttempt: Number(item.nextAttempt ?? Number(item.attempt ?? 1) + 1),
          delayMs: Number(item.delayMs ?? 0),
          code: typeof item.code === "string" ? item.code : undefined,
          message: typeof item.message === "string" ? item.message : undefined,
          at: typeof item.at === "number" ? item.at : undefined,
        }))
    : [];

  const final: AttemptTrace = {
    attempt: step.attempt || 1,
    outcome:
      step.status === "completed"
        ? "completed"
        : step.status === "skipped"
          ? "skipped"
          : retries.length > 0 && step.status === "running"
            ? "retrying"
            : "failed",
    code: step.error?.code,
    message: step.error?.message,
    durationMs: step.durationMs,
    at: step.completedAtMs ?? undefined,
  };

  if (retries.length === 0 && final.outcome === "failed" && step.attempt <= 1) {
    return [final];
  }
  return [...retries, final];
}

/* ------------------------------------------------------------------ */
/* Re-running                                                           */
/* ------------------------------------------------------------------ */

/** Node types that change something outside KLYZ. */
const WRITE_TYPE_REASON: Record<string, string> = {
  "action.slack_message": "Posts a message to Slack",
  "action.slack_channel": "Creates or configures a Slack channel",
  "action.gmail_send": "Sends an email",
  "action.gmail_reply": "Sends a reply",
  "action.gmail_label": "Changes labels on Gmail messages",
  "action.github_issue": "Creates or updates a GitHub issue",
  "action.github_comment": "Posts a comment on GitHub",
  "action.notion_page": "Creates or updates a Notion page",
  "action.sheets_append": "Appends rows to Google Sheets",
  "action.sheets_write": "Writes cells to Google Sheets",
  "action.postgres": "Writes to your database",
  "action.log": "",
};

const HTTP_WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface SideEffect {
  nodeId: string;
  label: string;
  reason: string;
}

/**
 * What re-running this graph would do *again*.
 *
 * A rerun replays the definition from the top, so any step with an
 * outward effect fires a second time. The dialog shows this list before
 * the run starts — the user confirms a real consequence, not a vague one.
 */
export function sideEffectsFor(
  nodes: Array<{ id: string; type: string; data?: { label?: unknown; config?: unknown } }>,
): SideEffect[] {
  const effects: SideEffect[] = [];

  for (const node of nodes) {
    const label =
      (typeof node.data?.label === "string" && node.data.label.trim()) || node.type;
    let reason = WRITE_TYPE_REASON[node.type] ?? null;

    if (node.type === "action.http") {
      const config = (node.data?.config ?? {}) as Record<string, unknown>;
      const method = String(config.method ?? "GET").toUpperCase();
      reason = HTTP_WRITE_METHODS.has(method)
        ? `Sends a ${method} request to an external service`
        : null;
    }

    if (reason) effects.push({ nodeId: node.id, label, reason });
  }

  return effects;
}

/** Convenience: derive side effects from a stored workflow definition. */
export function sideEffectsOfWorkflow(definition: Workflow): SideEffect[] {
  return sideEffectsFor(definition.nodes);
}
