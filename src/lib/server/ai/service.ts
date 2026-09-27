import { aiMaxIntentChars, aiModel } from "@/lib/config/env";
import { PlanParseError, parseWorkflowPlan, type WorkflowPlan } from "@/lib/ai/plan";
import {
  ExplanationParseError,
  parseFailureExplanation,
  parseWorkflowExplanation,
} from "@/lib/ai/explain";
import { capabilityDigest } from "@/lib/ai/catalog";
import { validatePlan } from "@/lib/ai/validate";
import type {
  AiMeta,
  ExplainExecutionResult,
  ExplainWorkflowResult,
  PlanResult,
} from "@/lib/ai/result";
import type { Workflow } from "@/lib/workflow/types";
import type { Actor } from "@/lib/server/identity";
import { getExecutionDetailFor, parseDefinition } from "@/lib/server/execution-service";
import { HttpError, isRecord } from "@/lib/server/http";
import { AI_CODES, aiError } from "./errors";
import { aiProvider, type AiCompletion, type AiMessage } from "./provider";
import {
  explainExecutionSystemPrompt,
  explainExecutionUserMessage,
  explainWorkflowSystemPrompt,
  explainWorkflowUserMessage,
  planSystemPrompt,
  planUserMessage,
} from "./prompt";
import { assertAiRateLimit } from "./rate-limit";

/**
 * The AI service: intent in, reviewed plan out.
 *
 * Pipeline (identical for generate and refine):
 *   rate limit → bounds checks → context assembly (redacted) → model
 *   call → strict parse (one repair attempt) → registry + graph
 *   validation → response.
 *
 * Nothing here persists anything. The plan only reaches the editor when
 * a human presses Apply, and the workflow only reaches the engine when
 * somebody runs it — the same path a hand-built workflow takes.
 */


/** Longest workflow/execution JSON we will read off the wire. */
const MAX_CONTEXT_BODY = 256_000;

/* ------------------------------------------------------------------ */
/* Request helpers                                                     */
/* ------------------------------------------------------------------ */

function requireBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
  }
  return body;
}

function readIntent(body: Record<string, unknown>): string {
  const intent = typeof body.intent === "string" ? body.intent.trim() : "";
  if (!intent) {
    throw new HttpError(400, "BAD_REQUEST", "Describe the automation you want to build.");
  }
  const max = aiMaxIntentChars();
  if (intent.length > max) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      `That description is ${intent.length} characters; the limit is ${max}.`,
      { limit: max },
    );
  }
  return intent;
}

function readWorkflowContext(body: Record<string, unknown>): Workflow | null {
  const raw = body.workflow;
  if (raw === undefined || raw === null) return null;
  if (JSON.stringify(raw).length > MAX_CONTEXT_BODY) {
    throw new HttpError(400, "BAD_REQUEST", "The workflow context is too large to send to the AI builder.");
  }
  return parseDefinition(raw);
}

function readPreviousPlan(body: Record<string, unknown>): WorkflowPlan | null {
  const raw = body.plan;
  if (raw === undefined || raw === null) return null;
  try {
    return parseWorkflowPlan(raw);
  } catch (error) {
    if (error instanceof PlanParseError) {
      throw new HttpError(400, "BAD_REQUEST", "The previous plan could not be read.", {
        issues: error.issues,
      });
    }
    throw error;
  }
}

function readFeedback(body: Record<string, unknown>): string | undefined {
  if (typeof body.feedback !== "string") return undefined;
  const trimmed = body.feedback.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 2_000) {
    throw new HttpError(400, "BAD_REQUEST", "The feedback must be under 2000 characters.");
  }
  return trimmed;
}

/* ------------------------------------------------------------------ */
/* Model round-trip                                                    */
/* ------------------------------------------------------------------ */

/** Tolerant extraction: some models wrap JSON in fences or prose. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  try {
    return JSON.parse(candidate);
  } catch {
    /* Return the raw text so the parse error names the real problem. */
    return candidate;
  }
}

interface PlanRoundTrip {
  plan: WorkflowPlan;
  completion: AiCompletion;
  attempts: number;
  repaired: boolean;
}

function metaFrom(completion: AiCompletion, attempts: number, repaired: boolean): AiMeta {
  return {
    provider: completion.provider,
    model: completion.model || aiModel(),
    durationMs: completion.durationMs,
    ...(completion.usage ? { usage: completion.usage } : {}),
    catalog: capabilityDigest(),
    attempts,
    repaired,
  };
}

/** Audit line: metadata only — never prompts, completions or keys. */
function logAi(operation: string, meta: AiMeta, extra: Record<string, unknown> = {}): void {
  console.info(
    "[ai]",
    JSON.stringify({
      op: operation,
      provider: meta.provider,
      model: meta.model,
      ms: meta.durationMs,
      attempts: meta.attempts,
      repaired: meta.repaired,
      tokens: meta.usage?.totalTokens ?? null,
      catalog: meta.catalog,
      ...extra,
    }),
  );
}

function planResponse(
  plan: WorkflowPlan,
  completion: AiCompletion,
  attempts: number,
  repaired: boolean,
  workflowId?: string,
): PlanResult {
  const validation = validatePlan(plan, workflowId ? { workflowId } : {});

  /* A reply that used no real capability at all is not a plan — it is a
     contract failure, and there is nothing meaningful to review. */
  if (validation.workflow && validation.workflow.nodes.length > 0) {
    const usable = plan.nodes.length - validation.blocking.filter((issue) =>
      issue.id.startsWith("capability_"),
    ).length;
    if (usable === 0) {
      throw aiError(
        422,
        AI_CODES.VALIDATION_FAILED,
        "The response did not use any capability from the KLYZ catalog.",
        { issues: validation.issues },
      );
    }
  }

  const meta = metaFrom(completion, attempts, repaired);
  logAi("plan", meta, {
    nodes: plan.nodes.length,
    edges: plan.edges.length,
    ok: validation.ok,
    applyable: validation.applyable,
  });

  return {
    plan,
    validation: {
      ok: validation.ok,
      applyable: validation.applyable,
      issues: validation.issues,
      blocking: validation.blocking,
    },
    workflow: validation.workflow,
    connections: validation.connections,
    meta,
  };
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

export async function generateAiPlan(
  actor: Actor,
  body: unknown,
  signal?: AbortSignal,
): Promise<PlanResult> {
  const request = requireBody(body);
  assertAiRateLimit(actor.workspaceId);
  const intent = readIntent(request);
  const workflow = readWorkflowContext(request);

  const messages: AiMessage[] = [
    { role: "system", content: planSystemPrompt() },
    { role: "user", content: planUserMessage({ intent, workflow }) },
  ];
  const result = await planRoundTrip(messages, signal);
  return planResponse(
    result.plan,
    result.completion,
    result.attempts,
    result.repaired,
    workflow?.id,
  );
}

export async function refineAiPlan(
  actor: Actor,
  body: unknown,
  signal?: AbortSignal,
): Promise<PlanResult> {
  const request = requireBody(body);
  assertAiRateLimit(actor.workspaceId);
  const intent = readIntent(request);
  const previous = readPreviousPlan(request);
  if (!previous) {
    throw new HttpError(400, "BAD_REQUEST", "Send the plan you want to refine.");
  }
  const feedback = readFeedback(request);
  if (!feedback) {
    throw new HttpError(400, "BAD_REQUEST", "Say what should change about the plan.");
  }
  const workflow = readWorkflowContext(request);

  const messages: AiMessage[] = [
    { role: "system", content: planSystemPrompt() },
    {
      role: "user",
      content: planUserMessage({ intent, workflow, plan: previous, feedback }),
    },
  ];
  const result = await planRoundTrip(messages, signal);
  return planResponse(
    result.plan,
    result.completion,
    result.attempts,
    result.repaired,
    workflow?.id,
  );
}

/* Kept separate so generate/refine share the repair loop verbatim. */
async function planRoundTrip(
  messages: AiMessage[],
  signal: AbortSignal | undefined,
): Promise<PlanRoundTrip> {
  const provider = aiProvider();
  let history = messages;
  let issues: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const completion = await provider.complete({
      messages: history,
      ...(signal ? { signal } : {}),
    });
    try {
      const plan = parseWorkflowPlan(extractJson(completion.text));
      return { plan, completion, attempts: attempt, repaired: attempt > 1 };
    } catch (error) {
      issues = error instanceof PlanParseError ? error.issues : [String(error)];
      history = [
        ...messages,
        { role: "assistant", content: completion.text.slice(0, 4_000) },
        {
          role: "user",
          content: `That response could not be used: ${issues.join("; ")}. Return ONLY the corrected JSON object, with no other text.`,
        },
      ];
    }
  }

  throw aiError(422, AI_CODES.INVALID_OUTPUT, "The AI did not return a usable workflow plan.", {
    issues,
  });
}

export async function explainWorkflowAi(
  actor: Actor,
  body: unknown,
  signal?: AbortSignal,
): Promise<ExplainWorkflowResult> {
  const request = requireBody(body);
  assertAiRateLimit(actor.workspaceId);
  const workflow = readWorkflowContext(request);
  if (!workflow) {
    throw new HttpError(400, "BAD_REQUEST", "Send the workflow to explain.");
  }
  const nodeId = typeof request.nodeId === "string" && request.nodeId ? request.nodeId : undefined;
  if (nodeId && !workflow.nodes.some((node) => node.id === nodeId)) {
    throw new HttpError(400, "BAD_REQUEST", "That node is not part of the workflow.");
  }

  const provider = aiProvider();
  const completion = await provider.complete({
    messages: [
      { role: "system", content: explainWorkflowSystemPrompt() },
      { role: "user", content: explainWorkflowUserMessage({ workflow, ...(nodeId ? { nodeId } : {}) }) },
    ],
    ...(signal ? { signal } : {}),
  });

  const explanation = parseExplanation(() =>
    parseWorkflowExplanation(extractJson(completion.text)),
  );
  const meta = metaFrom(completion, 1, false);
  logAi("explain_workflow", meta, { nodes: workflow.nodes.length, nodeId: nodeId ?? null });
  return { explanation, meta };
}

export async function explainExecutionAi(
  actor: Actor,
  executionId: string,
  signal?: AbortSignal,
): Promise<ExplainExecutionResult> {
  assertAiRateLimit(actor.workspaceId);
  /* Workspace-scoped read: the ownership check lives in the store. */
  const execution = getExecutionDetailFor(actor, executionId);

  const provider = aiProvider();
  const completion = await provider.complete({
    messages: [
      { role: "system", content: explainExecutionSystemPrompt() },
      { role: "user", content: explainExecutionUserMessage(execution) },
    ],
    ...(signal ? { signal } : {}),
  });

  const explanation = parseExplanation(() =>
    parseFailureExplanation(extractJson(completion.text)),
  );
  const meta = metaFrom(completion, 1, false);
  logAi("explain_execution", meta, {
    status: execution.status,
    steps: execution.steps.length,
    failed: execution.status === "failed",
  });
  return { explanation, meta };
}

function parseExplanation<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ExplanationParseError) {
      throw aiError(422, AI_CODES.INVALID_OUTPUT, "The AI did not return a usable explanation.", {
        issues: error.issues,
      });
    }
    throw error;
  }
}
