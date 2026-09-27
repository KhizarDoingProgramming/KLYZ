import { getDefinition } from "@/lib/workflow/registry";
import type {
  EdgeStatus,
  ExecutionError,
  ExecutionStatus,
  KlyzNodeData,
  NodeStatus,
  Workflow,
} from "@/lib/workflow/types";
import { computeStepIO, jitter, sampleTriggerOutput } from "@/lib/execution/io";
import type { DataScope } from "@/lib/workflow/expressions";

export interface PlannedStep {
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  ref: string;
  status: "completed" | "failed" | "skipped";
  durationMs: number;
  startedAtMs: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error?: ExecutionError;
}

interface PlanEdge {
  id: string;
  source: string;
  target: string;
  branch?: string;
}

export interface ExecutionPlan {
  edges: PlanEdge[];
  steps: PlannedStep[];
  nodeStates: Record<string, NodeStatus>;
  edgeStates: Record<string, EdgeStatus>;
  durationMs: number;
  status: ExecutionStatus;
}

interface PlanOptions {
  /** Force a specific node to fail — used to build realistic bad runs. */
  failAt?: string;
  error?: ExecutionError;
}

const AUTH_ERROR: ExecutionError = {
  code: "HTTP_401",
  message: "Request rejected by the CRM",
  detail: "The access token attached to this workflow expired 4 days ago.",
  status: 401,
  hint: "Authentication expired",
  remediation: { label: "Reconnect CRM", kind: "reconnect" },
};

const TIMEOUT_ERROR: ExecutionError = {
  code: "NODE_TIMEOUT",
  message: "Notion did not respond in time",
  detail: "The request exceeded the 10s step timeout and was cancelled.",
  status: 504,
  hint: "Upstream service timed out",
  remediation: { label: "Retry step", kind: "retry" },
};

const GITHUB_ERROR: ExecutionError = {
  code: "GITHUB_FORBIDDEN",
  message: "GitHub rejected the request",
  detail: "The connection does not have permission on that repository.",
  status: 403,
  hint: "Reconnect with the right scopes",
  remediation: { label: "Reconnect GitHub", kind: "reconnect" },
};

const GMAIL_ERROR: ExecutionError = {
  code: "GMAIL_NOT_CONNECTED",
  message: "The Google connection could not be used",
  detail: "The access token was refused, so the message was never sent.",
  status: 401,
  hint: "Reconnect the mailbox",
  remediation: { label: "Reconnect Gmail", kind: "reconnect" },
};

function defaultErrorFor(nodeType: string): ExecutionError {
  if (nodeType === "action.http") return AUTH_ERROR;
  if (nodeType === "action.notion_page") return TIMEOUT_ERROR;
  if (nodeType.startsWith("action.github") || nodeType === "trigger.github") {
    return GITHUB_ERROR;
  }
  if (nodeType.startsWith("action.gmail") || nodeType === "trigger.gmail") {
    return GMAIL_ERROR;
  }
  return {
    code: "STEP_FAILED",
    message: "The step could not be completed",
    detail: "The connector returned an unexpected response.",
    hint: "Inspect configuration",
    remediation: { label: "Inspect configuration", kind: "inspect" },
  };
}

/* ------------------------------------------------------------------ */

interface Indexed {
  order: string[];
  incoming: Map<string, string[]>;
  outgoing: Map<string, string[]>;
}

function indexGraph(workflow: Workflow): Indexed {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const node of workflow.nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of workflow.edges) {
    if (!indegree.has(edge.target) || !outgoing.has(edge.source)) continue;
    outgoing.get(edge.source)!.push(edge.id);
    incoming.get(edge.target)!.push(edge.id);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const order: string[] = [];
  const queue = workflow.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);

  const remaining = new Map(indegree);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const edgeId of outgoing.get(id) ?? []) {
      const edge = workflow.edges.find((item) => item.id === edgeId);
      if (!edge) continue;
      const next = (remaining.get(edge.target) ?? 0) - 1;
      remaining.set(edge.target, next);
      if (next === 0) queue.push(edge.target);
    }
  }

  // Cycles (illegal, but never crash the inspector): append leftovers.
  for (const node of workflow.nodes) {
    if (!order.includes(node.id)) order.push(node.id);
  }

  return { order, incoming, outgoing };
}

/**
 * SEED-ONLY execution fabricator.
 *
 * Generates clearly-marked development seed history for first runs of
 * the app (`source: "seed"` in the database). Real executions are
 * produced exclusively by `@/lib/engine` — this module never runs in
 * production execution paths.
 *
 * Originally: Turns a workflow *definition* into an *execution plan*.
 *
 * This is a pure function: same definition in, same plan out. The live
 * runner replays the plan step by step, exactly the way a real worker
 * will later replay server-pushed events.
 */
export function buildExecutionPlan(
  workflow: Workflow,
  options: PlanOptions = {},
): ExecutionPlan {
  const { order, incoming, outgoing } = indexGraph(workflow);
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(workflow.edges.map((edge) => [edge.id, edge]));

  const edgeStates: Record<string, EdgeStatus> = {};
  for (const edge of workflow.edges) edgeStates[edge.id] = "idle";

  const nodeStates: Record<string, NodeStatus> = {};
  const steps: PlannedStep[] = [];
  const scope: DataScope = {};

  let clock = 0;

  for (const nodeId of order) {
    const node = nodeById.get(nodeId);
    if (!node) continue;

    const definition = getDefinition(node.type);
    const data = node.data as KlyzNodeData;
    const inEdges = (incoming.get(nodeId) ?? []).map((id) => edgeById.get(id)!);
    const outEdges = (outgoing.get(nodeId) ?? []).map((id) => edgeById.get(id)!);

    const runnable =
      inEdges.length === 0
        ? Boolean(definition?.trigger)
        : inEdges.some((edge) => edgeStates[edge.id] === "completed");

    if (!runnable) {
      nodeStates[nodeId] = "skipped";
      for (const edge of outEdges) edgeStates[edge.id] = "skipped";
      steps.push({
        nodeId,
        nodeType: node.type,
        nodeLabel: definition?.title ?? node.type,
        ref: data.ref,
        status: "skipped",
        durationMs: 0,
        startedAtMs: clock,
        input: null,
        output: null,
      });
      continue;
    }

    const startedAtMs = clock;
    const duration = jitter(nodeId, definition?.cost ?? 60);
    const isTrigger = Boolean(definition?.trigger);

    const localScope: DataScope = isTrigger
      ? sampleTriggerOutput(node.type, data.config)
      : scope;

    const { input, output } = computeStepIO(
      nodeId,
      node.type,
      data.config,
      localScope,
    );

    const shouldFail = options.failAt === nodeId;
    const status: PlannedStep["status"] = shouldFail ? "failed" : "completed";

    clock += duration;

    steps.push({
      nodeId,
      nodeType: node.type,
      nodeLabel: definition?.title ?? node.type,
      ref: data.ref,
      status,
      durationMs: duration,
      startedAtMs,
      input,
      output,
      error: shouldFail
        ? (options.error ?? defaultErrorFor(node.type))
        : undefined,
    });

    if (status === "failed") {
      nodeStates[nodeId] = "failed";
      for (const edge of outEdges) edgeStates[edge.id] = "failed";
      continue;
    }

    nodeStates[nodeId] = "completed";
    scope[data.ref] = output;

    if (outEdges.length === 0) continue;

    const branchEdges = outEdges.filter((edge) => edge.data?.branch);
    if (branchEdges.length === 0) {
      for (const edge of outEdges) edgeStates[edge.id] = "completed";
      continue;
    }

    const matched =
      (output.matchedBranch as string | undefined) ??
      (output.matchedCase as string | undefined) ??
      null;
    const direct = branchEdges.filter((edge) => edge.data?.branch === matched);
    const taken =
      direct.length > 0
        ? direct
        : branchEdges.filter((edge) => edge.data?.branch === "fallback");
    const takenIds = new Set(taken.map((edge) => edge.id));
    for (const edge of branchEdges) {
      edgeStates[edge.id] = takenIds.has(edge.id) ? "completed" : "skipped";
    }
  }

  const failedCount = steps.filter((step) => step.status === "failed").length;
  const status: ExecutionStatus = failedCount === 0 ? "completed" : "failed";

  return {
    edges: workflow.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      branch: edge.data?.branch,
    })),
    steps,
    nodeStates,
    edgeStates,
    durationMs: clock,
    status,
  };
}
