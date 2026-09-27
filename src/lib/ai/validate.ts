import { errorCount, validateWorkflow } from "@/lib/workflow/validation";
import { getDefinition } from "@/lib/workflow/registry";
import { planToWorkflow } from "./graph";
import type { PlanConnection, WorkflowPlan } from "./plan";
import type { ConfigField, ValidationIssue, Workflow } from "@/lib/workflow/types";

/**
 * Plan validation — the model is never trusted.
 *
 * A proposal is untrusted input like any other: it is converted to a
 * real graph and pushed through the *existing* `validateWorkflow`, which
 * is the same authority the editor and the execution API use. This layer
 * only adds two plan-specific reclassifications:
 *
 *  1. unknown node types get an "unsupported capability" message instead
 *     of the editor's generic unknown-node text (the model was told the
 *     catalog — this is a contract violation, worth saying precisely);
 *  2. *required connection* fields are pulled out of the error list and
 *     returned as `connections` — the AI must never invent credential
 *     ids, so an empty credential is not a broken plan, it is a step the
 *     user completes by connecting the integration.
 *
 * Everything else — cycles, orphans, broken `{{refs}}`, missing required
 * config, bad branch shapes — is reported exactly as the editor would.
 */

export interface PlanValidation {
  /** True when the graph would open in the editor without any errors. */
  ok: boolean;
  /**
   * True when the graph may enter the editor at all.
   *
   * Blocking = the structure is wrong (unknown capability, cycle,
   * orphan, dangling edge, duplicate ref) — an AI mistake a human
   * should not have to repair by hand. Non-blocking = configuration the
   * editor already surfaces and the user completes there (empty
   * required fields, a connection to pick, a mapping to fix).
   */
  applyable: boolean;
  issues: ValidationIssue[];
  /** The subset that blocks applying the plan. */
  blocking: ValidationIssue[];
  workflow: Workflow | null;
  /** Integrations the user still has to connect before this can run. */
  connections: PlanConnection[];
}

/** Issue ids that mean "this graph is structurally unusable". */
const BLOCKING_PREFIXES = [
  "capability_",
  "unknown_",
  "graph_cycle",
  "no_trigger",
  "edge_missing_",
  "edge_self_",
  "orphan_",
  "dup_ref_",
];

function isBlocking(issue: ValidationIssue): boolean {
  return BLOCKING_PREFIXES.some((prefix) => issue.id.startsWith(prefix));
}

function credentialFields(definition: { fields: ConfigField[] }): ConfigField[] {
  return definition.fields.filter((field) => field.kind === "credential");
}

function isCredentialIssue(issue: ValidationIssue, workflow: Workflow): boolean {
  if (issue.severity !== "error" || !issue.nodeId) return false;
  if (!issue.id.startsWith("missing_")) return false;
  const node = workflow.nodes.find((candidate) => candidate.id === issue.nodeId);
  if (!node) return false;
  const definition = getDefinition(node.type);
  if (!definition) return false;
  return credentialFields(definition).some((field) => issue.id === `missing_${node.id}_${field.key}`);
}

/** Connections derived from the graph itself — never from model claims alone. */
function deriveConnections(workflow: Workflow): PlanConnection[] {
  const connections: PlanConnection[] = [];
  const seen = new Set<string>();
  for (const node of workflow.nodes) {
    const definition = getDefinition(node.type);
    if (!definition?.credentials?.length) continue;
    const fields = credentialFields(definition).filter((field) => field.required);
    for (const field of fields) {
      const value = node.data.config[field.key];
      if (typeof value === "string" && value.trim()) continue;
      /* Single-kind integrations are unambiguous; multi-kind pickers
         (HTTP auth modes) are optional by construction. */
      if (definition.credentials.length !== 1) continue;
      const credential = definition.credentials[0];
      if (!credential || seen.has(`${node.id}:${credential}`)) continue;
      seen.add(`${node.id}:${credential}`);
      connections.push({
        credential,
        label: `${definition.title} connection required`,
        reason: `“${node.data.label ?? definition.title}” needs a ${credential.replace(/_/g, " ")} connection before it can run.`,
        nodeId: node.id,
      });
    }
  }
  return connections;
}

export function validatePlan(
  plan: WorkflowPlan,
  options: { workflowId?: string } = {},
): PlanValidation {
  const workflow = planToWorkflow(plan, { workflowId: options.workflowId });
  const issues: ValidationIssue[] = [];
  const connections: PlanConnection[] = deriveConnections(workflow);

  const unknownNodeIds = new Set<string>();
  for (const node of plan.nodes) {
    if (getDefinition(node.type)) continue;
    unknownNodeIds.add(node.id);
    issues.push({
      id: `capability_${node.id}`,
      severity: "error",
      nodeId: node.id,
      message: `“${node.type}” is not a capability KLYZ has.`,
      hint: "Only node types from the capability catalog can be used.",
    });
  }

  const reportedUnknown = (issue: ValidationIssue): boolean =>
    issue.id.startsWith("unknown_") && !!issue.nodeId && unknownNodeIds.has(issue.nodeId);

  for (const issue of validateWorkflow(workflow)) {
    if (reportedUnknown(issue)) continue;
    if (isCredentialIssue(issue, workflow)) continue;
    issues.push(issue);
  }

  /* The model's own connection list is advisory; the graph's is fact.
     Union them so a model-declared need is never lost. */
  for (const connection of plan.requiredConnections) {
    const known = connections.some(
      (item) => item.nodeId === connection.nodeId && item.credential === connection.credential,
    );
    if (!known) connections.push(connection);
  }

  return {
    ok: errorCount(issues) === 0,
    applyable: !issues.some(isBlocking),
    issues,
    blocking: issues.filter(isBlocking),
    workflow,
    connections,
  };
}
