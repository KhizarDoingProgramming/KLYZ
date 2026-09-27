import { getDefinition } from "./registry";
import type { Workflow } from "./types";

/**
 * Graph indexing shared by validation, the editor and the engine.
 *
 * Built once per run: incoming/outgoing edge lookups, a topological
 * order for scheduling, and explicit cycle detection so an illegal
 * graph is reported instead of silently mis-ordered.
 */

export type WfNode = Workflow["nodes"][number];
export type WfEdge = Workflow["edges"][number];

export interface WorkflowGraph {
  nodes: WfNode[];
  edges: WfEdge[];
  nodeById: Map<string, WfNode>;
  edgeById: Map<string, WfEdge>;
  incoming: Map<string, WfEdge[]>;
  outgoing: Map<string, WfEdge[]>;
  /** Node ids in dependency order. Nodes inside a cycle are omitted. */
  topo: string[];
  /** Indegree-0 trigger nodes — where a run starts. */
  entries: string[];
  /** Node ids that participate in (or depend on) a cycle. */
  cyclic: string[];
}

export function buildGraph(workflow: Workflow): WorkflowGraph {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(workflow.edges.map((edge) => [edge.id, edge]));
  const incoming = new Map<string, WfEdge[]>();
  const outgoing = new Map<string, WfEdge[]>();
  const indegree = new Map<string, number>();

  for (const node of workflow.nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
    indegree.set(node.id, 0);
  }

  for (const edge of workflow.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge);
    incoming.get(edge.target)!.push(edge);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const remaining = new Map(indegree);
  const topo: string[] = [];
  const queue = workflow.nodes
    .filter((node) => (remaining.get(node.id) ?? 0) === 0)
    .map((node) => node.id);

  while (queue.length > 0) {
    const id = queue.shift()!;
    topo.push(id);
    for (const edge of outgoing.get(id) ?? []) {
      const next = (remaining.get(edge.target) ?? 0) - 1;
      remaining.set(edge.target, next);
      if (next === 0) queue.push(edge.target);
    }
  }

  const cyclic = workflow.nodes
    .filter((node) => !topo.includes(node.id))
    .map((node) => node.id);

  const entries = workflow.nodes
    .filter(
      (node) =>
        (incoming.get(node.id)?.length ?? 0) === 0 &&
        getDefinition(node.type)?.trigger,
    )
    .map((node) => node.id);

  return {
    nodes: workflow.nodes,
    edges: workflow.edges,
    nodeById,
    edgeById,
    incoming,
    outgoing,
    topo,
    entries,
    cyclic,
  };
}
