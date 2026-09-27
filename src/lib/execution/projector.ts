import type { EdgeStatus, ExecutionStatus, NodeStatus } from "@/lib/workflow/types";
import type { EngineEvent } from "./events";
import type {
  ExecutionDetail,
  ExecutionPlan,
  ExecutionPlanEdge,
  ExecutionStepView,
} from "./types";

/**
 * Pure event → state projector.
 *
 * The same fold runs in tests, on the server and in the editor: given
 * a plan and the next engine event, it returns the next plan. Canvas
 * node/edge states are *derived* from step records — never animated on
 * a timer — so what you see is what actually executed.
 */

const SETTLED: ReadonlySet<NodeStatus> = new Set([
  "completed",
  "failed",
  "skipped",
]);

function isSettled(status: NodeStatus): boolean {
  return SETTLED.has(status);
}

export function createPlan(
  edges: ExecutionPlanEdge[],
  skeleton: ExecutionStepView[] = [],
): ExecutionPlan {
  const steps = skeleton.map((step) => ({ ...step }));
  return {
    edges: edges.map((edge) => ({ ...edge })),
    steps,
    nodeStates: {},
    edgeStates: {},
    durationMs: 0,
    status: "queued",
    revealed: 0,
  };
}

export function deriveStates(
  steps: ExecutionStepView[],
  edges: ExecutionPlanEdge[],
): Pick<ExecutionPlan, "nodeStates" | "edgeStates" | "revealed"> {
  const nodeStates: Record<string, NodeStatus> = {};
  for (const step of steps) nodeStates[step.nodeId] = step.status;

  const byNode = new Map(steps.map((step) => [step.nodeId, step]));
  const edgeStates: Record<string, EdgeStatus> = {};

  for (const edge of edges) {
    const source = byNode.get(edge.source);
    const target = byNode.get(edge.target);

    if (!target || target.status === "pending") {
      if (!source || source.status === "pending") {
        edgeStates[edge.id] = "idle";
      } else if (source.status === "running" || source.status === "waiting") {
        edgeStates[edge.id] = "idle";
      } else if (source.status === "failed") {
        edgeStates[edge.id] = "failed";
      } else if (source.status === "skipped") {
        edgeStates[edge.id] = "skipped";
      } else if (edge.branch) {
        edgeStates[edge.id] = source.branch === edge.branch ? "completed" : "skipped";
      } else {
        edgeStates[edge.id] = "completed";
      }
      continue;
    }

    if (target.status === "running" || target.status === "waiting") {
      edgeStates[edge.id] = "active";
    } else if (target.status === "failed") {
      edgeStates[edge.id] = "completed";
    } else if (target.status === "skipped") {
      edgeStates[edge.id] = "skipped";
    } else {
      edgeStates[edge.id] = "completed";
    }
  }

  const revealed = steps.filter((step) => isSettled(step.status)).length;
  return { nodeStates, edgeStates, revealed };
}

function settle(plan: ExecutionPlan, next: Partial<ExecutionPlan>): ExecutionPlan {
  const merged: ExecutionPlan = { ...plan, ...next };
  const states = deriveStates(merged.steps, merged.edges);
  return { ...merged, ...states };
}

/**
 * Which recorded step an event is talking about.
 *
 * Matching is by `step.id` first: a Loop node records one step per node
 * per iteration, so several steps share a `nodeId` and only the id tells
 * them apart. The `nodeId` fallback exists for events that arrive
 * without a recorded predecessor (a skipped step never announced itself),
 * and is scoped to an *unfinished* step so it can never land on an
 * earlier iteration of the same node.
 */
function locateStep(
  steps: ExecutionStepView[],
  stepId: string | undefined,
  nodeId: string,
): number {
  if (stepId) {
    const byId = steps.findIndex((item) => item.id === stepId);
    if (byId !== -1) return byId;
  }
  return steps.findIndex((item) => item.nodeId === nodeId && !isSettled(item.status));
}

/**
 * Folds one engine event into the plan. Terminal events also stamp timing.
 */
export function applyEvent(plan: ExecutionPlan, event: EngineEvent): ExecutionPlan {
  switch (event.type) {
    case "execution.started":
      return settle(plan, { status: "running", durationMs: 0 });

    case "execution.status":
      return settle(plan, { status: event.status });

    case "execution.node.started": {
      const step = event.step;
      const index = locateStep(plan.steps, step.id, step.nodeId);
      const steps =
        index === -1
          ? [...plan.steps, step]
          : plan.steps.map((item, i) => (i === index ? step : item));
      return settle(plan, { steps });
    }

    case "execution.node.completed":
    case "execution.node.failed":
    case "execution.node.skipped": {
      const index = locateStep(plan.steps, event.stepId, event.nodeId);
      const base =
        index === -1
          ? [
              ...plan.steps,
              {
                id: event.stepId,
                nodeId: event.nodeId,
                nodeType: event.nodeType,
                nodeLabel: event.nodeLabel,
                ref: event.ref,
                status: "pending" as NodeStatus,
                attempt: 0,
                startedAtMs: null,
                completedAtMs: null,
                durationMs: 0,
                input: null,
                output: null,
              },
            ]
          : plan.steps;
      const target = index === -1 ? base.length - 1 : index;
      const steps = base.map((item, i) => {
        if (i !== target) return item;
        const next: ExecutionStepView = {
          ...item,
          completedAtMs: event.at,
        };
        if (event.type === "execution.node.completed") {
          next.status = "completed";
          next.durationMs = event.durationMs;
          next.output = event.output;
          next.branch = event.branch;
          next.error = undefined;
          if (event.metadata) next.metadata = event.metadata;
        } else if (event.type === "execution.node.failed") {
          next.status = "failed";
          next.durationMs = event.durationMs;
          next.error = event.error;
          next.attempt = event.attempt;
          if (event.metadata) next.metadata = event.metadata;
        } else {
          next.status = "skipped";
          next.durationMs = 0;
          next.input = null;
          next.output = null;
          next.branch = null;
          if (event.metadata) next.metadata = event.metadata;
        }
        return next;
      });
      return settle(plan, { steps });
    }

    case "execution.node.retrying": {
      /* The step is still running — but the last attempt's error stays
         visible so the inspector can show the trail while backoff runs. */
      const index = locateStep(plan.steps, event.stepId, event.nodeId);
      if (index === -1) return settle(plan, {});
      const steps = plan.steps.map((item, i) =>
        i === index
          ? { ...item, status: "running" as NodeStatus, attempt: event.nextAttempt, error: event.error }
          : item,
      );
      return settle(plan, { steps });
    }

    case "execution.node.waiting": {
      const index = locateStep(plan.steps, event.stepId, event.nodeId);
      if (index === -1) return settle(plan, {});
      const steps = plan.steps.map((item, i) =>
        i === index
          ? { ...item, status: event.waiting ? ("waiting" as NodeStatus) : ("running" as NodeStatus) }
          : item,
      );
      return settle(plan, { steps });
    }

    case "execution.completed":
    case "execution.failed":
    case "execution.cancelled":
      return settle(plan, {
        status: event.status,
        durationMs: event.durationMs,
      });

    default:
      return plan;
  }
}

/** Terminal status for a finished run — used to close live subscriptions. */
export function isTerminal(status: ExecutionStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Plan seeded from a persisted execution.
 *
 * The execution row records what happened, not the canvas it happened
 * on — so callers that know the pinned definition pass its edges in and
 * get a graph; callers that do not still get an ordered step list.
 */
export function planFromExecution(
  execution: ExecutionDetail,
  edges: ExecutionPlanEdge[] = [],
): ExecutionPlan {
  const steps = execution.steps.map((step) => ({ ...step }));
  const states = deriveStates(steps, edges);
  return {
    edges: edges.map((edge) => ({ ...edge })),
    steps,
    ...states,
    status: execution.status,
    durationMs: execution.durationMs,
  };
}
