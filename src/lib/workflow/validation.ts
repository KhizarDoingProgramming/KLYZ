import { getDefinition } from "./registry";
import { buildGraph } from "./graph";
import { findBrokenRefs } from "./expressions";
import { isVisible } from "./show-when";
import type {
  KlyzEdgeData,
  KlyzNodeData,
  ValidationIssue,
  Workflow,
} from "./types";

/**
 * Structural validation for a workflow definition.
 *
 * Runs in the editor while you build and again on the server before a
 * workflow can be executed. Errors block execution; warnings do not.
 */
export function validateWorkflow(workflow: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  for (const node of workflow.nodes) {
    incomingCount.set(node.id, 0);
    outgoingCount.set(node.id, 0);
  }

  const graph = buildGraph(workflow);
  if (graph.cyclic.length > 0) {
    issues.push({
      id: "graph_cycle",
      severity: "error",
      nodeId: graph.cyclic[0],
      message: "These steps form a loop, so they cannot be ordered.",
      hint: "Remove the connection that feeds a step back into itself.",
    });
  }


  for (const edge of workflow.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      issues.push({
        id: `edge_missing_${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Connection references a node that no longer exists.",
        hint: "Remove the connection and reconnect the nodes.",
      });
      continue;
    }
    if (edge.source === edge.target) {
      issues.push({
        id: `edge_self_${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "A node cannot connect to itself.",
      });
    }
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    outgoingCount.set(edge.source, (outgoingCount.get(edge.source) ?? 0) + 1);
  }

  const triggers = workflow.nodes.filter(
    (node) => getDefinition(node.type)?.trigger,
  );

  if (triggers.length === 0) {
    issues.push({
      id: "no_trigger",
      severity: "error",
      message: "This workflow has no trigger.",
      hint: "Add a webhook, schedule, manual or integration trigger to start it.",
    });
  }
  if (triggers.length > 1) {
    issues.push({
      id: "multiple_triggers",
      severity: "warning",
      message: `This workflow has ${triggers.length} triggers.`,
      hint: "Runs will start from whichever trigger fires first.",
    });
  }

  const seenRefs = new Map<string, string>();

  for (const node of workflow.nodes) {
    const definition = getDefinition(node.type);
    const data = node.data as KlyzNodeData;

    if (!definition) {
      issues.push({
        id: `unknown_${node.id}`,
        severity: "error",
        nodeId: node.id,
        message: `Unknown node type "${node.type}".`,
        hint: "This step cannot be executed until the integration is available.",
      });
      continue;
    }

    if (!definition.trigger && (incomingCount.get(node.id) ?? 0) === 0) {
      issues.push({
        id: `orphan_${node.id}`,
        severity: "error",
        nodeId: node.id,
        message: `"${definition.title}" is not connected to anything.`,
        hint: "Connect it to the step that should run before it.",
      });
    }

    if (
      definition.trigger &&
      (incomingCount.get(node.id) ?? 0) === 0 &&
      (outgoingCount.get(node.id) ?? 0) === 0
    ) {
      issues.push({
        id: `unused_trigger_${node.id}`,
        severity: "warning",
        nodeId: node.id,
        message: `"${definition.title}" does not start any steps.`,
        hint: "Connect it to the first action of the workflow.",
      });
    }

    if (data.ref) {
      const owner = seenRefs.get(data.ref);
      if (owner && owner !== node.id) {
        issues.push({
          id: `dup_ref_${node.id}`,
          severity: "error",
          nodeId: node.id,
          message: `Reference "{{${data.ref}}}" is used by more than one step.`,
          hint: "Give each step a unique reference so data lookups stay unambiguous.",
        });
      } else {
        seenRefs.set(data.ref, node.id);
      }
    }

    for (const field of definition.fields) {
      if (!field.required) continue;
      if (!isVisible(field, data.config)) continue;
      const value = data.config[field.key];
      const empty =
        value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "") ||
        (Array.isArray(value) && value.length === 0);
      if (empty) {
        issues.push({
          id: `missing_${node.id}_${field.key}`,
          severity: "error",
          nodeId: node.id,
          message: `"${definition.title}" is missing ${field.label.toLowerCase()}.`,
          hint: "Open the step and fill in the highlighted field.",
        });
      }
    }

    /* Connection state is deliberately not checked here: whether an OAuth
       account is still connected lives in the database and changes after
       a workflow is saved. The engine reports it per step as an
       actionable `integrationError` ("Reconnect …"), which stays true —
       unlike a badge computed from a constant. */
  }

  // Expression references must resolve to a step that exists upstream.
  // `trigger` and `context` are engine-provided roots available everywhere.
  const availableRefs = new Set(
    workflow.nodes
      .map((node) => (node.data as KlyzNodeData).ref)
      .filter(Boolean),
  );
  availableRefs.add("trigger");
  availableRefs.add("context");

  for (const node of workflow.nodes) {
    const definition = getDefinition(node.type);
    if (!definition) continue;
    const data = node.data as KlyzNodeData;
    for (const field of definition.fields) {
      const broken = findBrokenRefs(data.config[field.key], availableRefs);
      for (const path of broken) {
        issues.push({
          id: `ref_${node.id}_${field.key}_${path}`,
          severity: "error",
          nodeId: node.id,
          message: `{{${path}}} does not point at any step in this workflow.`,
          hint: "Pick another value from the data picker.",
        });
      }
    }
  }

  return issues;
}

export function errorCount(issues: ValidationIssue[]): number {
  return issues.filter((issue) => issue.severity === "error").length;
}

export type { KlyzEdgeData };
