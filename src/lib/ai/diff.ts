import { summarizeNode } from "@/lib/workflow/summary";
import type { Workflow } from "@/lib/workflow/types";

/**
 * Structural diff between the workflow a user has and the one a plan (or
 * a refinement) proposes.
 *
 * The point is that nobody should have to compare JSON by eye: added,
 * removed and reconfigured steps are listed with what actually changed,
 * using the same node summaries the editor shows. Node identity is the
 * graph node id, so editing an existing workflow diffs cleanly; a brand
 * new plan shows everything as added.
 */

export interface NodeChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

export interface NodeDiffEntry {
  id: string;
  type: string;
  label: string;
  changes: NodeChange[];
}

export interface EdgeDiffEntry {
  id: string;
  source: string;
  target: string;
  branch?: string;
}

export interface WorkflowDiff {
  added: NodeDiffEntry[];
  removed: NodeDiffEntry[];
  changed: NodeDiffEntry[];
  edgesAdded: EdgeDiffEntry[];
  edgesRemoved: EdgeDiffEntry[];
  unchangedCount: number;
  empty: boolean;
}

function labelOf(workflow: Workflow, id: string): { label: string; type: string } | null {
  const node = workflow.nodes.find((candidate) => candidate.id === id);
  if (!node) return null;
  return {
    label: node.data.label ?? node.data.ref ?? node.type,
    type: node.type,
  };
}

function edgeKey(edge: Workflow["edges"][number]): string {
  return `${edge.source}->${edge.target}${edge.data?.branch ? `:${edge.data.branch}` : ""}`;
}

function summaryLines(workflow: Workflow, id: string): string {
  const node = workflow.nodes.find((candidate) => candidate.id === id);
  if (!node) return "";
  return summarizeNode(node.type, node.data.config)
    .map((line) => `${line.label} ${line.value}`)
    .join(" · ");
}

function configKeys(workflow: Workflow, id: string): Record<string, string> {
  const node = workflow.nodes.find((candidate) => candidate.id === id);
  if (!node) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.data.config ?? {})) {
    out[key] = renderValue(value);
  }
  return out;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function clip(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function diffWorkflow(current: Workflow, proposed: Workflow): WorkflowDiff {
  const currentIds = new Set(current.nodes.map((node) => node.id));
  const proposedIds = new Set(proposed.nodes.map((node) => node.id));

  const added: NodeDiffEntry[] = [];
  const changed: NodeDiffEntry[] = [];
  const unchanged: string[] = [];

  for (const node of proposed.nodes) {
    const meta = labelOf(proposed, node.id);
    if (!meta) continue;
    if (!currentIds.has(node.id)) {
      added.push({
        id: node.id,
        type: node.type,
        label: node.data.label ?? meta.label,
        changes: [{ key: "step", label: "New step", before: "", after: summaryLines(proposed, node.id) }],
      });
      continue;
    }
    const changes: NodeChange[] = [];
    const beforeConfig = configKeys(current, node.id);
    const afterConfig = configKeys(proposed, node.id);
    const keys = new Set([...Object.keys(beforeConfig), ...Object.keys(afterConfig)]);
    for (const key of [...keys].sort()) {
      const before = beforeConfig[key] ?? "";
      const after = afterConfig[key] ?? "";
      if (before === after) continue;
      changes.push({ key, label: key, before: clip(before), after: clip(after) });
    }
    const currentLabel = current.nodes.find((item) => item.id === node.id)?.data.label ?? "";
    if (currentLabel !== (node.data.label ?? "")) {
      changes.unshift({
        key: "label",
        label: "label",
        before: currentLabel,
        after: node.data.label ?? "",
      });
    }
    if (changes.length > 0) {
      changed.push({ id: node.id, type: node.type, label: node.data.label ?? meta.label, changes });
    } else {
      unchanged.push(node.id);
    }
  }

  const removed: NodeDiffEntry[] = [];
  for (const node of current.nodes) {
    if (proposedIds.has(node.id)) continue;
    removed.push({
      id: node.id,
      type: node.type,
      label: node.data.label ?? node.data.ref ?? node.type,
      changes: [{ key: "step", label: "Removed", before: summaryLines(current, node.id), after: "" }],
    });
  }

  const currentEdges = new Map(current.edges.map((edge) => [edgeKey(edge), edge]));
  const proposedEdges = new Map(proposed.edges.map((edge) => [edgeKey(edge), edge]));
  const edgesAdded: EdgeDiffEntry[] = [];
  const edgesRemoved: EdgeDiffEntry[] = [];

  for (const [key, edge] of proposedEdges) {
    if (currentEdges.has(key)) continue;
    edgesAdded.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.data?.branch ? { branch: edge.data.branch } : {}),
    });
  }
  for (const [key, edge] of currentEdges) {
    if (proposedEdges.has(key)) continue;
    edgesRemoved.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.data?.branch ? { branch: edge.data.branch } : {}),
    });
  }

  return {
    added,
    removed,
    changed,
    edgesAdded,
    edgesRemoved,
    unchangedCount: unchanged.length,
    empty:
      added.length === 0 &&
      removed.length === 0 &&
      changed.length === 0 &&
      edgesAdded.length === 0 &&
      edgesRemoved.length === 0,
  };
}
