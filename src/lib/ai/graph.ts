import { getDefinition } from "@/lib/workflow/registry";
import { PLAN_LIMITS, type WorkflowPlan } from "./plan";
import type { Workflow, WorkflowStatus } from "@/lib/workflow/types";

/**
 * Plan → graph.
 *
 * The plan is transient review data; this is the only place it becomes
 * the real KLYZ `Workflow` shape — the same nodes/edges the editor,
 * validator and engine already consume. There is no second graph format:
 * once converted, an AI-generated workflow is indistinguishable from a
 * hand-built one (and must pass the same validation).
 */

const RESERVED_REFS = new Set(["trigger", "context"]);
const COLUMNS = 270;
const ROWS = 170;
const ORIGIN = { x: 80, y: 120 };

function refBaseFor(type: string, fallback: string): string {
  const withoutCategory = type.includes(".") ? type.slice(type.indexOf(".") + 1) : type;
  const cleaned = withoutCategory.replace(/[^A-Za-z0-9_]/g, "") || fallback;
  return /^[0-9]/.test(cleaned) ? `n_${cleaned}` : cleaned;
}

function stamp(): string {
  return new Date().toISOString();
}

/** Longest-path depth from any trigger, so diamonds and chains lay out sanely. */
function depths(plan: WorkflowPlan): Map<string, number> {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const node of plan.nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of plan.edges) {
    if (!incoming.has(edge.target) || !outgoing.has(edge.source)) continue;
    incoming.get(edge.target)!.push(edge.source);
    outgoing.get(edge.source)!.push(edge.target);
  }

  const triggers = plan.nodes.filter((node) => getDefinition(node.type)?.trigger);
  const roots = triggers.length > 0 ? triggers.map((node) => node.id) : [plan.nodes[0]?.id].filter(Boolean) as string[];

  const depth = new Map<string, number>(plan.nodes.map((node) => [node.id, 0]));
  /* Relax edges repeatedly — bounded by node count, no recursion. */
  for (let pass = 0; pass < plan.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of plan.edges) {
      const from = depth.get(edge.source);
      const to = depth.get(edge.target);
      if (from === undefined || to === undefined) continue;
      if (to < from + 1) {
        depth.set(edge.target, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  /* Unreachable nodes (orphaned in the proposal) still get a column. */
  for (const root of roots) if (!depth.has(root)) depth.set(root, 0);
  return depth;
}

export interface PlanToWorkflowOptions {
  workflowId?: string;
  name?: string;
  description?: string;
  status?: WorkflowStatus;
  createdAt?: string;
}

export function planToWorkflow(
  plan: WorkflowPlan,
  options: PlanToWorkflowOptions = {},
): Workflow {
  const depth = depths(plan);
  const perColumn = new Map<number, number>();
  const usedRefs = new Set<string>(RESERVED_REFS);

  const nodes: Workflow["nodes"] = plan.nodes.map((node) => {
    const column = depth.get(node.id) ?? 0;
    const row = perColumn.get(column) ?? 0;
    perColumn.set(column, row + 1);

    let ref = (node.ref ?? refBaseFor(node.type, node.id)).slice(0, PLAN_LIMITS.ref);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(ref) || RESERVED_REFS.has(ref)) {
      ref = refBaseFor(node.type, node.id);
    }
    let unique = ref;
    let suffix = 2;
    while (usedRefs.has(unique)) unique = `${ref}_${suffix++}`;
    usedRefs.add(unique);

    return {
      id: node.id,
      type: node.type,
      position: { x: ORIGIN.x + column * COLUMNS, y: ORIGIN.y + row * ROWS },
      data: {
        ref: unique,
        ...(node.label ? { label: node.label } : {}),
        config: node.config,
      },
    };
  });

  const edges: Workflow["edges"] = plan.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.branch ? { data: { branch: edge.branch } } : {}),
  }));

  const trigger =
    plan.nodes.find((node) => getDefinition(node.type)?.trigger)?.type ?? "trigger.manual";

  return {
    id: options.workflowId ?? "wf_ai_draft",
    name: options.name ?? clipTitle(plan.title),
    description: options.description ?? plan.description,
    status: options.status ?? "draft",
    tags: [],
    createdAt: options.createdAt ?? stamp(),
    updatedAt: stamp(),
    lastExecutedAt: null,
    executionCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    triggerType: trigger,
    nodeCount: nodes.length,
    nodes,
    edges,
  };
}

function clipTitle(title: string): string {
  return title.trim().slice(0, 140) || "Untitled workflow";
}
