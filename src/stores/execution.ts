"use client";

import { create } from "zustand";
import { buildGraph } from "@/lib/workflow/graph";
import { getDefinition } from "@/lib/workflow/registry";
import type {
  EdgeStatus,
  ExecutionStatus,
  NodeStatus,
  ValidationIssue,
  Workflow,
} from "@/lib/workflow/types";
import {
  ApiError,
  cancelExecution as cancelExecutionApi,
  executionEventsUrl,
  getExecution as getExecutionApi,
  startExecution as startExecutionApi,
} from "@/lib/execution/api";
import { isFinishedEvent, type EngineEvent } from "@/lib/execution/events";
import { createFeed } from "@/lib/execution/feed";
import { DEFAULT_RUN_INPUT } from "@/lib/execution/run-input";
import {
  applyEvent,
  createPlan,
  deriveStates,
  isTerminal,
} from "@/lib/execution/projector";
import type {
  ExecutionDetail,
  ExecutionPlan,
  ExecutionPlanEdge,
  ExecutionStepView,
} from "@/lib/execution/types";

/**
 * Live run state for the editor.
 *
 * The backend owns execution: starting a run POSTs the definition,
 * events arrive over SSE, and a pure projector folds them into canvas
 * state. No local timers simulate work — a refresh can re-attach to a
 * run that is still going because the process never depended on us.
 */

type InspectorTab = "configure" | "run";

interface BlockedRun {
  message: string;
  issues: ValidationIssue[];
}

interface ExecutionStore {
  runId: string | null;
  workflowId: string | null;
  plan: ExecutionPlan | null;
  status: ExecutionStatus | "idle";
  revealed: number;
  nodeStates: Record<string, NodeStatus>;
  edgeStates: Record<string, EdgeStatus>;
  startedAt: number | null;
  stepStartedAt: number | null;
  elapsedMs: number;
  selectedStepId: string | null;
  inspectorTab: InspectorTab;
  isRunning: boolean;
  blocked: BlockedRun | null;
  /** Raw text from the run-input box. Parsed by `parseRunInput` on run. */
  runInputText: string;
  /** Set only when the payload was refused — cleared by editing or running. */
  runInputError: string | null;

  start: (workflow: Workflow, input?: unknown) => Promise<void>;
  attach: (executionId: string, workflow: Workflow) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
  selectStep: (nodeId: string | null) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setBlocked: (blocked: BlockedRun | null) => void;
  setRunInput: (text: string) => void;
  setRunInputError: (error: string | null) => void;
}

const NO_NODES: Record<string, NodeStatus> = Object.create(null);
const NO_EDGES: Record<string, EdgeStatus> = Object.create(null);

let generation = 0;
let source: EventSource | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

function stopTransport(): void {
  if (source) {
    source.close();
    source = null;
  }
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function skeletonFor(workflow: Workflow): {
  edges: ExecutionPlanEdge[];
  steps: ExecutionStepView[];
} {
  const graph = buildGraph(workflow);
  const edges: ExecutionPlanEdge[] = workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    branch: edge.data?.branch,
  }));
  const steps: ExecutionStepView[] = graph.topo.map((nodeId) => {
    const node = graph.nodeById.get(nodeId);
    const definition = node ? getDefinition(node.type) : undefined;
    const label =
      typeof node?.data?.label === "string" && node.data.label.trim()
        ? node.data.label
        : definition?.title ?? node?.type ?? nodeId;
    return {
      id: `pending:${nodeId}`,
      nodeId,
      nodeType: node?.type ?? "unknown",
      nodeLabel: label,
      ref: node?.data?.ref ?? nodeId,
      status: "pending",
      attempt: 0,
      startedAtMs: null,
      completedAtMs: null,
      durationMs: 0,
      input: null,
      output: null,
    };
  });
  return { edges, steps };
}

function overlaySnapshot(
  plan: ExecutionPlan,
  execution: ExecutionDetail,
): ExecutionPlan {
  const steps = plan.steps.map(
    (skeleton) =>
      execution.steps.find((step) => step.nodeId === skeleton.nodeId) ?? skeleton,
  );
  for (const step of execution.steps) {
    if (!steps.some((item) => item.nodeId === step.nodeId)) steps.push(step);
  }
  const states = deriveStates(steps, plan.edges);
  return {
    ...plan,
    steps,
    ...states,
    status: execution.status,
    durationMs: execution.durationMs,
  };
}

function blockedFrom(error: unknown): BlockedRun {
  if (error instanceof ApiError) {
    return {
      message: error.issues.length
        ? "Fix these issues before running the workflow."
        : error.message,
      issues: error.issues,
    };
  }
  return {
    message:
      error instanceof Error ? error.message : "The run could not be started.",
    issues: [],
  };
}

export const useExecutionStore = create<ExecutionStore>((set, get) => {
  function beginTicker(): void {
    if (ticker) clearInterval(ticker);
    ticker = setInterval(() => {
      const state = get();
      if (!state.isRunning || state.startedAt === null) return;
      set({ elapsedMs: Date.now() - state.startedAt });
    }, 120);
  }

  function applyEngineEvent(event: EngineEvent): void {
    const finished = isFinishedEvent(event);
    set((state) => {
      if (!state.plan) return state;
      const plan = applyEvent(state.plan, event);
      const next: Partial<ExecutionStore> = {
        plan,
        status: plan.status,
        revealed: plan.revealed,
        nodeStates: plan.nodeStates,
        edgeStates: plan.edgeStates,
      };

      if (event.type === "execution.started") {
        next.startedAt = Date.parse(event.startedAt);
      } else if (event.type === "execution.node.started") {
        next.stepStartedAt = event.step.startedAtMs;
      } else if (
        event.type === "execution.node.completed" ||
        event.type === "execution.node.failed" ||
        event.type === "execution.node.skipped"
      ) {
        next.stepStartedAt = null;
      }

      if (finished) {
        next.isRunning = false;
        next.stepStartedAt = null;
        next.elapsedMs = plan.durationMs;
      }
      return next;
    });

    if (finished && source) {
      source.close();
      source = null;
    }
  }

  function applySnapshot(execution: ExecutionDetail): void {
    set((state) => {
      if (!state.plan) return state;
      const plan = overlaySnapshot(state.plan, execution);
      const terminal = isTerminal(execution.status);
      const runningStep = plan.steps.find((step) => step.status === "running");
      const startedAt = Date.parse(execution.startedAt);
      return {
        plan,
        status: execution.status,
        revealed: plan.revealed,
        nodeStates: plan.nodeStates,
        edgeStates: plan.edgeStates,
        startedAt,
        stepStartedAt: runningStep?.startedAtMs ?? null,
        elapsedMs: terminal
          ? execution.durationMs
          : Date.now() - startedAt,
        isRunning: !terminal,
      };
    });
  }

  function subscribe(executionId: string, myGeneration: number): void {
    const feed = createFeed({
      onSnapshot: (execution) => applySnapshot(execution),
      onEvent: (event) => applyEngineEvent(event),
    });
    const eventSource = new EventSource(executionEventsUrl(executionId));
    source = eventSource;
    eventSource.onmessage = (message) => {
      if (myGeneration !== generation) {
        eventSource.close();
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      feed.push(payload);
    };
    eventSource.onerror = () => {
      /* EventSource retries on its own; terminal events close the stream. */
    };
  }

  return {
    runId: null,
    workflowId: null,
    plan: null,
    status: "idle",
    revealed: 0,
    nodeStates: NO_NODES,
    edgeStates: NO_EDGES,
    startedAt: null,
    stepStartedAt: null,
    elapsedMs: 0,
    selectedStepId: null,
    inspectorTab: "configure",
    isRunning: false,
    blocked: null,
    runInputText: DEFAULT_RUN_INPUT,
    runInputError: null,

    start: async (workflow, input) => {
      const myGeneration = (generation += 1);
      stopTransport();

      const { edges, steps } = skeletonFor(workflow);
      set({
        runId: null,
        workflowId: workflow.id,
        plan: createPlan(edges, steps),
        status: "queued",
        revealed: 0,
        nodeStates: Object.fromEntries(steps.map((step) => [step.nodeId, "pending"])),
        edgeStates: Object.fromEntries(edges.map((edge) => [edge.id, "idle"])),
        startedAt: Date.now(),
        stepStartedAt: null,
        elapsedMs: 0,
        selectedStepId: null,
        inspectorTab: "run",
        isRunning: true,
        blocked: null,
        runInputError: null,
      });
      beginTicker();

      try {
        const execution = await startExecutionApi(
          workflow.id,
          input === undefined ? {} : { input },
        );
        if (myGeneration !== generation) {
          cancelExecutionApi(execution.id).catch(() => undefined);
          return;
        }
        set({ runId: execution.id });
        subscribe(execution.id, myGeneration);
      } catch (error) {
        if (myGeneration !== generation) return;
        stopTransport();
        set({
          runId: null,
          plan: null,
          status: "idle",
          revealed: 0,
          nodeStates: NO_NODES,
          edgeStates: NO_EDGES,
          startedAt: null,
          stepStartedAt: null,
          elapsedMs: 0,
          isRunning: false,
          blocked: blockedFrom(error),
        });
      }
    },

    attach: async (executionId, workflow) => {
      const myGeneration = (generation += 1);
      stopTransport();

      try {
        const execution = await getExecutionApi(executionId);
        if (myGeneration !== generation) return;

        const { edges, steps } = skeletonFor(workflow);
        const plan = overlaySnapshot(createPlan(edges, steps), execution);
        const terminal = isTerminal(execution.status);
        const startedAt = Date.parse(execution.startedAt);
        const runningStep = plan.steps.find((step) => step.status === "running");

        set({
          runId: executionId,
          workflowId: execution.workflowId,
          plan,
          status: execution.status,
          revealed: plan.revealed,
          nodeStates: plan.nodeStates,
          edgeStates: plan.edgeStates,
          startedAt,
          stepStartedAt: runningStep?.startedAtMs ?? null,
          elapsedMs: terminal ? execution.durationMs : Date.now() - startedAt,
          selectedStepId: null,
          isRunning: !terminal,
          blocked: null,
        });

        if (!terminal) {
          beginTicker();
          subscribe(executionId, myGeneration);
        }
      } catch (error) {
        if (myGeneration !== generation) return;
        set({ blocked: blockedFrom(error) });
      }
    },

    cancel: async () => {
      const id = get().runId;
      if (!id) return;
      try {
        await cancelExecutionApi(id);
      } catch {
        /* already finished — the stream carries the final state */
      }
    },

    reset: () => {
      generation += 1;
      stopTransport();
      set({
        runId: null,
        workflowId: null,
        plan: null,
        status: "idle",
        revealed: 0,
        nodeStates: NO_NODES,
        edgeStates: NO_EDGES,
        startedAt: null,
        stepStartedAt: null,
        elapsedMs: 0,
        selectedStepId: null,
        inspectorTab: "configure",
        isRunning: false,
        blocked: null,
        runInputError: null,
      });
    },

    selectStep: (nodeId) =>
      set({ selectedStepId: nodeId, inspectorTab: nodeId ? "run" : "configure" }),

    setInspectorTab: (tab) => set({ inspectorTab: tab }),

    setBlocked: (blocked) => set({ blocked }),

    setRunInput: (text) => set({ runInputText: text, runInputError: null }),

    setRunInputError: (error) => set({ runInputError: error }),
  };
});
