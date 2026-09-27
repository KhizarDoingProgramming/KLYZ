import { redact } from "@/lib/server/redact";
import type { Workflow } from "@/lib/workflow/types";
import type { ExecutionDetail } from "@/lib/execution/types";

/**
 * Model-facing context.
 *
 * Workflow and execution contents are *untrusted data*: they may contain
 * text written by third parties (an email body, a Slack message, a
 * webhook payload) that tries to impersonate instructions. Everything
 * sent to the model goes through this module, which:
 *
 *  1. redacts with the same server-side rules the debugger uses, so
 *     tokens/headers/credentials never leave the process;
 *  2. clips strings and caps array lengths, so one pathological payload
 *     cannot blow up the request;
 *  3. escapes `<` so data cannot close or open a context tag and be
 *     read as markup by the prompt.
 *
 * The result is a plain JSON string — no HTML, no executable content.
 */

const MAX_NODES = 80;
const MAX_STEPS = 24;
const MAX_STRING = 1_500;
const MAX_ARRAY = 40;
const MAX_CONTEXT_CHARS = 40_000;
const MAX_DEPTH = 8;

function clipDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => clipDeep(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more items omitted]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = clipDeep(item, depth + 1);
  }
  return out;
}

/** JSON with `<` escaped so data cannot impersonate a context tag. */
function toBlock(value: unknown, label: string): string {
  const json = JSON.stringify(redact(clipDeep(value))) ?? "null";
  const safe = json.replace(/</g, "\\u003C");
  if (safe.length <= MAX_CONTEXT_CHARS) return `<${label}>\n${safe}\n</${label}>`;
  return `<${label}>\n${safe.slice(0, MAX_CONTEXT_CHARS)}…\n</${label}>`;
}

/** Compact, redacted view of a workflow for prompting. */
export function workflowContext(workflow: Workflow): string {
  return toBlock(
    {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      triggerType: workflow.triggerType,
      nodes: workflow.nodes.slice(0, MAX_NODES).map((node) => ({
        id: node.id,
        type: node.type,
        ref: node.data.ref,
        ...(node.data.label ? { label: node.data.label } : {}),
        config: node.data.config,
      })),
      edges: workflow.edges.slice(0, MAX_NODES * 2).map((edge) => ({
        source: edge.source,
        target: edge.target,
        ...(edge.data?.branch ? { branch: edge.data.branch } : {}),
      })),
    },
    "workflow_data",
  );
}

/**
 * Compact, redacted view of a finished (or failed) run.
 *
 * Only what explains behaviour: statuses, errors, attempt history and
 * provider-call metadata the debugger already redacted at write time.
 */
export function executionContext(execution: ExecutionDetail): string {
  return toBlock(
    {
      id: execution.id,
      workflowId: execution.workflowId,
      workflowName: execution.workflowName,
      status: execution.status,
      source: execution.source,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      durationMs: execution.durationMs,
      trigger: execution.trigger,
      input: execution.input,
      output: execution.output,
      error: execution.error,
      steps: execution.steps.slice(0, MAX_STEPS).map((step) => ({
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        nodeLabel: step.nodeLabel,
        ref: step.ref,
        status: step.status,
        attempt: step.attempt,
        durationMs: step.durationMs,
        error: step.error ?? null,
        input: step.input,
        output: step.output,
        metadata: step.metadata ?? null,
      })),
    },
    "execution_data",
  );
}

/** The user's own request — trusted as intent, still length-checked upstream. */
export function intentContext(intent: string): string {
  return `<intent>\n${intent.trim()}\n</intent>`;
}

export function feedbackContext(feedback: string): string {
  return `<feedback>\n${feedback.trim()}\n</feedback>`;
}
