import type { PlanConnection, WorkflowPlan } from "./plan";
import type { FailureExplanation, WorkflowExplanation } from "./explain";
import type { ValidationIssue, Workflow } from "@/lib/workflow/types";

/**
 * Wire types shared by the AI API and its client.
 *
 * They live here (not in the server module) because the builder UI
 * renders them directly — the browser never imports server code, and the
 * routes never re-declare shapes the client already understands.
 */

export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiMeta {
  /** Provider host, e.g. `openrouter.ai`. Never the key. */
  provider: string;
  model: string;
  durationMs: number;
  usage?: AiUsage;
  /** Digest of the capability catalog the plan was validated against. */
  catalog: string;
  attempts: number;
  /** True when the model needed one repair round to return valid JSON. */
  repaired: boolean;
}

export interface PlanValidationView {
  /** No validation errors at all. */
  ok: boolean;
  /** Safe to put in the editor (structure is sound). */
  applyable: boolean;
  issues: ValidationIssue[];
  blocking: ValidationIssue[];
}

export interface PlanResult {
  plan: WorkflowPlan;
  validation: PlanValidationView;
  /** The plan as a real KLYZ graph — what Apply writes. */
  workflow: Workflow | null;
  /** Integrations the user still has to connect. */
  connections: PlanConnection[];
  meta: AiMeta;
}

export interface ExplainWorkflowResult {
  explanation: WorkflowExplanation;
  meta: AiMeta;
}

export interface ExplainExecutionResult {
  explanation: FailureExplanation;
  meta: AiMeta;
}

export interface AiStatusResult {
  ai: { enabled: boolean; model: string; baseUrl: string };
  catalog: string;
}
