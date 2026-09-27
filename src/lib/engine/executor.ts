import { randomUUID } from "node:crypto";
import { buildGraph } from "@/lib/workflow/graph";
import { getDefinition } from "@/lib/workflow/registry";
import type { DataScope } from "@/lib/workflow/expressions";
import type { ExecutionError } from "@/lib/workflow/types";
import type { EngineEvent } from "@/lib/execution/events";
import type { ExecutionStepView } from "@/lib/execution/types";
import { startStepTelemetry } from "@/lib/execution/telemetry";
import { ProviderError } from "@/lib/integrations/provider/errors";
import {
  abortableSleep,
  delayDurationMs,
  getHandler,
  missingHandlerError,
} from "./handlers";
import { resolveConfig } from "./resolve";
import {
  CancelledError,
  EngineError,
  type ExecuteOptions,
  type ExecuteResult,
  type NodeRunContext,
} from "./types";

/**
 * The execution engine.
 *
 * Runs a workflow definition node-by-node in dependency order: resolves
 * data, evaluates branches, records real timings, honours retries,
 * timeouts and cancellation, and emits events for every state change.
 * It knows nothing about HTTP, React or the database — the caller
 * decides where events go (persistence, SSE, tests).
 *
 * A Loop node re-enters this same path: it owns a *body* subgraph (every
 * step downstream whose inputs all come from the loop) and runs it once
 * per item, recording a real step per node per iteration. Nothing is
 * simulated — each iteration resolves config, calls handlers, retries
 * and emits exactly like a top-level step does.
 */

const DEFAULT_STEP_TIMEOUT_MS = 15_000;
const DEFAULT_BACKOFF_MS = 250;
const MAX_ATTEMPTS = 5;
/** A runaway list must stop the run, not the worker. */
const DEFAULT_MAX_LOOP_ITEMS = 100;
const MAX_LOOP_ITEMS = 5_000;

interface EdgeLike {
  source: string;
  data?: { branch?: string };
}

/** Reads the step that an incoming edge should be judged against. */
type StepLookup = (nodeId: string) => ExecutionStepView | undefined;

interface RunContext {
  /** `"0"`, `"0.1"`… for steps inside a loop body; `null` at top level. */
  iterationKey: string | null;
  lookup: StepLookup;
  /**
   * Sources whose edge counts as taken regardless of their recorded
   * status — the Loop node driving this body is still `running` while
   * its body executes, and it is precisely why the body started.
   */
  assumed: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function edgeTaken(edge: EdgeLike, context: RunContext): boolean {
  if (context.assumed.has(edge.source)) return !edge.data?.branch;
  const source = context.lookup(edge.source);
  if (!source || source.status !== "completed") return false;
  if (edge.data?.branch) return source.branch === edge.data.branch;
  return true;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  nodeLabel: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolveRace, reject) => {
        timer = setTimeout(() => {
          reject(
            new EngineError(
              "STEP_TIMEOUT",
              `"${nodeLabel}" timed out after ${Math.round(timeoutMs)}ms`,
              {
                detail: "The step exceeded its time limit and was cancelled.",
                hint: "Increase the timeout or simplify the step.",
                retryable: true,
              },
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toEngineError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  if (error instanceof CancelledError) return error as never;
  /* A provider failure already knows its stable code, its remediation
     and whether another attempt could plausibly help. Keeping that
     contract intact is what makes `retryable` mean something — without
     it every API rejection would read STEP_FAILED and be retried. */
  if (error instanceof ProviderError) return error.toEngineError();
  const message =
    error instanceof Error ? error.message : "The step could not be completed.";
  return new EngineError("STEP_FAILED", message, {
    detail:
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : undefined,
    retryable: true,
    cause: error,
  });
}

/** Step telemetry is attached only when there is something to show. */
function withCalls(snapshot: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

/**
 * The steps a Loop node owns.
 *
 * Everything reachable from the loop whose inputs all come from inside
 * the loop (or from the loop itself). A step that also takes input from
 * outside is a *join* — it belongs after the loop and is left alone, so
 * the body can never swallow a branch it does not own.
 */
function computeLoopBodies(
  graph: ReturnType<typeof buildGraph>,
): Map<string, string[]> {
  const bodies = new Map<string, string[]>();
  const descendants = new Map<string, Set<string>>();
  const loops: string[] = [];

  for (const node of graph.nodes) {
    if (node.type !== "logic.loop") continue;
    loops.push(node.id);
    const reachable = new Set<string>();
    const stack = (graph.outgoing.get(node.id) ?? []).map((edge) => edge.target);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === node.id || reachable.has(id)) continue;
      reachable.add(id);
      for (const edge of graph.outgoing.get(id) ?? []) stack.push(edge.target);
    }
    descendants.set(node.id, reachable);
  }

  for (const loopId of loops) {
    const owned = new Set(descendants.get(loopId) ?? []);
    /* A nested loop owns its own body: the outer loop drives the inner
       loop node, never the steps the inner loop already drives. */
    for (const other of loops) {
      if (other === loopId || !owned.has(other)) continue;
      for (const id of descendants.get(other) ?? []) owned.delete(id);
    }
    /* Fixed point: dropping a join can turn its descendants into joins. */
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...owned]) {
        const incoming = graph.incoming.get(id) ?? [];
        const outside = incoming.some(
          (edge) => edge.source !== loopId && !owned.has(edge.source),
        );
        if (outside) {
          owned.delete(id);
          changed = true;
        }
      }
    }
    bodies.set(
      loopId,
      graph.topo.filter((id) => owned.has(id)),
    );
  }
  return bodies;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/** What `runNode` hands back — the caller decides how the run ends. */
type NodeOutcome =
  | { kind: "ok"; skipped?: boolean; stopped?: boolean }
  | { kind: "fail"; status: "failed" | "cancelled"; error: ExecutionError };

export async function executeWorkflow(
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const { workflow, emit, signal, executionId } = options;
  const graph = buildGraph(workflow);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const maxAttempts = Math.min(
    Math.max(options.retry?.maxAttempts ?? 1, 1),
    MAX_ATTEMPTS,
  );
  const backoffMs = options.retry?.backoffMs ?? DEFAULT_BACKOFF_MS;
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  const steps: ExecutionStepView[] = [];
  const stepsByNode = new Map<string, ExecutionStepView>();
  /* One entry per node *per iteration* — `stepsByNode` alone would
     collapse every pass of a loop into the last one. */
  const iterationSteps = new Map<string, ExecutionStepView>();
  const loopBodies = computeLoopBodies(graph);
  const consumed = new Set<string>();
  /* Unique per run: a legitimately re-delivered execution must never
     collide with steps an earlier attempt already persisted. */
  const stepToken = randomUUID().replaceAll("-", "").slice(0, 8);
  const scope: DataScope = {
    trigger: { payload: options.input ?? {} },
    context: {
      executionId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      workspaceId: options.workspaceId,
      version: options.workflowVersion,
      startedAt,
      triggeredBy: options.source ?? "manual",
    },
  };

  let lastOutput: unknown = null;
  let completedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let currentStatus: "running" | "waiting" = "running";
  let stepCounter = 0;

  emit({
    type: "execution.started",
    executionId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    workspaceId: options.workspaceId,
    workflowVersionId: options.workflowVersionId,
    workflowVersion: options.workflowVersion,
    trigger: {
      type: workflow.triggerType,
      label: getDefinition(workflow.triggerType)?.title ?? "Trigger",
    },
    input: options.input ?? null,
    startedAt,
    at: startedAtMs,
  });

  const publishStatus = (
    status: "queued" | "running" | "waiting",
  ): void => {
    if (status === currentStatus) return;
    if (status === "queued") return;
    currentStatus = status as "running" | "waiting";
    emit({
      type: "execution.status",
      executionId,
      status,
      at: Date.now(),
    });
  };

  const finish = (
    status: "completed" | "failed" | "cancelled",
    error?: ExecutionError,
  ): ExecuteResult => {
    const durationMs = Date.now() - startedAtMs;
    const metadata: Record<string, unknown> = {
      nodeCount: graph.topo.length,
      completedCount,
      failedCount,
      skippedCount,
      stepCount: steps.length,
      version: options.workflowVersion,
      source: options.source ?? "manual",
      engine: "klyz-local",
    };
    const type =
      status === "completed"
        ? "execution.completed"
        : status === "failed"
          ? "execution.failed"
          : "execution.cancelled";
    const event: EngineEvent = {
      type,
      executionId,
      status,
      durationMs,
      output: lastOutput,
      error,
      metadata,
      completedAt: new Date().toISOString(),
      at: Date.now(),
    };
    emit(event);
    return { status, durationMs, output: lastOutput, error, metadata, steps };
  };

  /* Defensive structural checks — the API validates first. */
  const fatal =
    graph.cyclic.length > 0
      ? new EngineError("GRAPH_CYCLE", "This workflow contains a loop.", {
          detail: "Steps that feed back into themselves cannot be ordered.",
        })
      : workflow.nodes.length > 0 && graph.entries.length === 0
        ? new EngineError("NO_TRIGGER", "This workflow has no runnable trigger.", {
            detail: "Connect a trigger that nothing feeds into.",
          })
        : null;
  if (fatal) {
    return finish("failed", fatal.toExecutionError());
  }

  /* ---------------------------------------------------------------- */
  /* One node, once                                                    */
  /* ---------------------------------------------------------------- */

  async function runNode(
    nodeId: string,
    context: RunContext,
  ): Promise<NodeOutcome> {
    const node = graph.nodeById.get(nodeId);
    if (!node) return { kind: "ok" };
    const definition = getDefinition(node.type);
    const data = node.data ?? { ref: nodeId, config: {} };
    /* The step's `ref` is what lands in SQLite and what `{{...}}`
       expressions look up. A graph that never named its node still has
       to run, so the node id stands in — exactly what the browser-side
       run path already does. */
    const ref = typeof data.ref === "string" && data.ref ? data.ref : nodeId;
    const nodeLabel =
      (typeof data.label === "string" && data.label.trim()) ||
      definition?.title ||
      node.type;
    const incoming = graph.incoming.get(nodeId) ?? [];
    const now = () => Date.now();

    const register = (step: ExecutionStepView): void => {
      if (context.iterationKey !== null) {
        steps.push(step);
        iterationSteps.set(`${context.iterationKey}:${nodeId}`, step);
        stepsByNode.set(nodeId, step);
        return;
      }
      const existing = stepsByNode.get(nodeId);
      if (existing) {
        const index = steps.indexOf(existing);
        if (index !== -1) steps[index] = step;
      } else {
        steps.push(step);
      }
      stepsByNode.set(nodeId, step);
    };

    const meta = (
      snapshot: Record<string, unknown> | undefined,
    ): Record<string, unknown> | undefined => {
      if (context.iterationKey === null) return snapshot;
      const merged = { ...(snapshot ?? {}), iteration: context.iterationKey };
      return Object.keys(merged).length > 0 ? merged : undefined;
    };

    /* --- skipped: no taken incoming edge -------------------------- */
    if (incoming.length > 0 && !incoming.some((edge) => edgeTaken(edge, context))) {
      const at = now();
      const step: ExecutionStepView = {
        id: `st_${(++stepCounter).toString(36)}_${stepToken}`,
        nodeId,
        nodeType: node.type,
        nodeLabel,
        ref,
        status: "skipped",
        attempt: 1,
        startedAtMs: at,
        completedAtMs: at,
        durationMs: 0,
        input: null,
        output: null,
        branch: null,
      };
      register(step);
      skippedCount += 1;
      emit({
        type: "execution.node.skipped",
        executionId,
        stepId: step.id,
        nodeId,
        nodeType: node.type,
        nodeLabel,
        ref,
        metadata: meta(undefined),
        at,
      });
      return { kind: "ok", skipped: true };
    }

    if (incoming.length === 0 && !definition?.trigger) {
      const error = new EngineError(
        "ORPHAN_NODE",
        `"${nodeLabel}" is not connected to anything.`,
        { detail: "Only triggers may start without an incoming connection." },
      );
      return { kind: "fail", status: "failed", error: error.toExecutionError() };
    }

    /* --- resolve config and build the running step ---------------- */
    const startedStep = now();
    stepCounter += 1;
    const step: ExecutionStepView = {
      id: `st_${stepCounter.toString(36)}_${stepToken}`,
      nodeId,
      nodeType: node.type,
      nodeLabel,
      ref,
      status: "running",
      attempt: 1,
      startedAtMs: startedStep,
      completedAtMs: null,
      durationMs: 0,
      input: null,
      output: null,
      branch: null,
    };

    const resolvedConfig = resolveConfig(
      (data.config ?? {}) as Record<string, unknown>,
      scope,
    );

    step.input = definition?.trigger
      ? { ...resolvedConfig, payload: options.input ?? null }
      : resolvedConfig;
    register(step);
    emit({ type: "execution.node.started", executionId, step: { ...step }, at: startedStep });

    const settleFailed = (error: ExecutionError, attempt: number): NodeOutcome => {
      const at = now();
      step.status = "failed";
      step.attempt = attempt;
      step.completedAtMs = at;
      step.durationMs = at - startedStep;
      step.error = error;
      failedCount += 1;
      emit({
        type: "execution.node.failed",
        executionId,
        stepId: step.id,
        nodeId,
        nodeType: node.type,
        nodeLabel,
        ref: step.ref,
        durationMs: step.durationMs,
        error,
        attempt,
        metadata: step.metadata ?? undefined,
        at,
      });
      return { kind: "fail", status: "failed", error };
    };

    const settleCancelled = (attempt: number): NodeOutcome => {
      const cancelError: ExecutionError = {
        code: "CANCELLED",
        message: `"${nodeLabel}" was cancelled`,
        detail: "The execution was cancelled while this step was running.",
      };
      settleFailed(cancelError, attempt);
      return { kind: "fail", status: "cancelled", error: cancelError };
    };

    const timeoutMs =
      node.type === "logic.delay"
        ? delayDurationMs(resolvedConfig) + 5_000
        : stepTimeoutMs;

    /* --- a Loop drives its own body, then settles ------------------ */
    if (node.type === "logic.loop") {
      return runLoopBody({
        nodeId,
        ref,
        nodeLabel,
        step,
        resolvedConfig,
        startedStep,
        context,
        register,
        meta,
        settleFailed,
        settleCancelled,
      });
    }

    /* --- attempt loop --------------------------------------------- */
    let attempt = 1;
    /* One telemetry store for the whole step: every attempt's provider
       calls land in it, so the settled step shows the full trail. */
    const telemetry = startStepTelemetry();
    for (;;) {
      try {
        const handler = getHandler(node.type);
        if (!handler) throw missingHandlerError(node.type);

        const nodeContext: NodeRunContext = {
          executionId,
          workspaceId: options.workspaceId,
          workflow,
          nodeId,
          nodeType: node.type,
          config: resolvedConfig,
          rawConfig: (data.config ?? {}) as Record<string, unknown>,
          scope,
          triggerInput: options.input,
          attempt,
          signal,
          /* A step that parks itself reports both edges of the wait, so
             the debugger shows `waiting` instead of a frozen `running`. */
          publishStatus: (status) => {
            if (status === "waiting" && step.status === "running") {
              step.status = "waiting";
              emit({
                type: "execution.node.waiting",
                executionId,
                stepId: step.id,
                nodeId,
                nodeType: node.type,
                nodeLabel,
                ref: step.ref,
                waiting: true,
                at: now(),
              });
            } else if (status === "running" && step.status === "waiting") {
              step.status = "running";
              emit({
                type: "execution.node.waiting",
                executionId,
                stepId: step.id,
                nodeId,
                nodeType: node.type,
                nodeLabel,
                ref: step.ref,
                waiting: false,
                at: now(),
              });
            }
            publishStatus(status);
          },
        };

        const result = await telemetry.run(() =>
          withTimeout(Promise.resolve().then(() => handler(nodeContext)), timeoutMs, nodeLabel),
        );

        const completedAt = now();
        step.attempt = attempt;
        step.completedAtMs = completedAt;
        step.durationMs = completedAt - startedStep;
        step.error = undefined;
        step.metadata = meta(withCalls(telemetry.snapshot()));

        if (result.skipped) {
          /* A filtered step settles as `skipped`, not `completed` — the
             status *is* the branch cut, so downstream edges see no taken
             source and skip in turn without a special case in the engine. */
          step.status = "skipped";
          skippedCount += 1;
          emit({
            type: "execution.node.skipped",
            executionId,
            stepId: step.id,
            nodeId,
            nodeType: node.type,
            nodeLabel,
            ref: step.ref,
            metadata: step.metadata ?? undefined,
            at: completedAt,
          });
          return { kind: "ok", skipped: true };
        }

        step.status = "completed";
        step.output = result.output;
        step.branch = result.branch ?? null;
        completedCount += 1;

        emit({
          type: "execution.node.completed",
          executionId,
          stepId: step.id,
          nodeId,
          nodeType: node.type,
          nodeLabel,
          ref: step.ref,
          durationMs: step.durationMs,
          output: result.output,
          branch: step.branch,
          attempt,
          metadata: step.metadata ?? undefined,
          at: completedAt,
        });

        if (ref) scope[ref] = result.output;
        lastOutput = result.output;

        if (result.stop) return { kind: "ok", stopped: true };
        return { kind: "ok" };
      } catch (error) {
        if (error instanceof CancelledError || signal.aborted) {
          return settleCancelled(attempt);
        }

        const engineError = toEngineError(error);
        if (engineError.retryable && attempt < maxAttempts) {
          const delayMs = backoffMs * 2 ** (attempt - 2);
          /* The retry is a real, observable event: which attempt failed,
             what it failed with, and how long the engine will wait. The
             debugger renders it without guessing from timestamps. */
          emit({
            type: "execution.node.retrying",
            executionId,
            stepId: step.id,
            nodeId,
            nodeType: node.type,
            nodeLabel,
            ref: step.ref,
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
            error: engineError.toExecutionError(),
            at: now(),
          });
          step.error = engineError.toExecutionError();
          attempt += 1;
          step.attempt = attempt;
          try {
            await abortableSleep(delayMs, signal);
          } catch {
            return settleCancelled(attempt);
          }
          continue;
        }

        step.metadata = meta(withCalls(telemetry.snapshot()));
        return settleFailed(engineError.toExecutionError(), attempt);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* A Loop node re-runs its body once per item                        */
  /* ---------------------------------------------------------------- */

  async function runLoopBody(args: {
    nodeId: string;
    ref: string;
    nodeLabel: string;
    step: ExecutionStepView;
    resolvedConfig: Record<string, unknown>;
    startedStep: number;
    context: RunContext;
    register: (step: ExecutionStepView) => void;
    meta: (snapshot: Record<string, unknown> | undefined) => Record<string, unknown> | undefined;
    settleFailed: (error: ExecutionError, attempt: number) => NodeOutcome;
    settleCancelled: (attempt: number) => NodeOutcome;
  }): Promise<NodeOutcome> {
    const { nodeId, ref, nodeLabel, step, resolvedConfig, startedStep } = args;
    const now = () => Date.now();

    const settleLoop = (
      status: "completed" | "failed",
      error?: ExecutionError,
      output?: Record<string, unknown>,
    ): NodeOutcome => {
      const at = now();
      step.status = status;
      step.attempt = 1;
      step.completedAtMs = at;
      step.durationMs = at - startedStep;
      step.output = output ?? step.output;
      step.error = error;
      /* A loop nested inside another loop settles once per outer pass, so
         its own row carries the pass number like the steps in its body. */
      step.metadata = args.meta(step.metadata ?? undefined);
      if (status === "completed") {
        completedCount += 1;
      } else {
        failedCount += 1;
      }
      emit({
        type: status === "completed" ? "execution.node.completed" : "execution.node.failed",
        executionId,
        stepId: step.id,
        nodeId,
        nodeType: step.nodeType,
        nodeLabel,
        ref: step.ref,
        durationMs: step.durationMs,
        ...(status === "completed"
          ? { output: step.output ?? null, branch: step.branch ?? null, attempt: 1 }
          : { error: error ?? null, attempt: 1 }),
        metadata: step.metadata,
        at,
      } as EngineEvent);
      if (status === "completed") return { kind: "ok" };
      return {
        kind: "fail",
        status: error?.code === "CANCELLED" ? "cancelled" : "failed",
        error: error ?? {
          code: "LOOP_FAILED",
          message: `"${nodeLabel}" stopped.`,
        },
      };
    };

    const rawOver = resolvedConfig.over;
    const list = Array.isArray(rawOver)
      ? rawOver
      : rawOver === undefined || rawOver === null
        ? []
        : [rawOver];

    const requested = Number(resolvedConfig.maxItems);
    const maxItems = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_LOOP_ITEMS)
      : DEFAULT_MAX_LOOP_ITEMS;
    if (list.length > maxItems) {
      const error = new EngineError(
        "LOOP_TOO_LARGE",
        `"${nodeLabel}" has ${list.length} items, over the ${maxItems}-item limit.`,
        {
          detail: "A loop this long would keep the worker busy without producing a usable run.",
          hint: "Raise “Max items”, narrow the list upstream, or split the work across runs.",
        },
      ).toExecutionError();
      return settleLoop("failed", error);
    }

    const mode = String(resolvedConfig.mode ?? "each");
    const requestedBatch = Number(resolvedConfig.batchSize);
    const batchSize =
      Number.isFinite(requestedBatch) && requestedBatch > 0
        ? Math.min(Math.floor(requestedBatch), 500)
        : 25;
    const units = mode === "batched" ? chunk(list, batchSize) : list;

    const bodyIds = loopBodies.get(nodeId) ?? [];
    const bodySet = new Set(bodyIds);
    for (const id of bodyIds) consumed.add(id);

    const childContext = (iterationKey: string): RunContext => ({
      iterationKey,
      lookup: (id) =>
        bodySet.has(id)
          ? iterationSteps.get(`${iterationKey}:${id}`)
          : stepsByNode.get(id),
      assumed: new Set([nodeId]),
    });

    const results: unknown[] = [];
    const prefix = args.context.iterationKey === null
      ? ""
      : `${args.context.iterationKey}.`;

    for (let index = 0; index < units.length; index += 1) {
      if (signal.aborted) {
        const error: ExecutionError = {
          code: "CANCELLED",
          message: `"${nodeLabel}" was cancelled`,
          detail: "The execution was cancelled while the loop was running.",
        };
        settleLoop("failed", error);
        return { kind: "fail", status: "cancelled", error };
      }

      const iterationKey = `${prefix}${index}`;
      scope[ref] = { item: units[index], index, count: units.length, results };

      let lastBodyOutput: unknown = null;
      for (const bodyId of bodyIds) {
        const outcome = await runNode(bodyId, childContext(iterationKey));
        if (outcome.kind === "fail") {
          settleLoop("failed", outcome.error);
          return outcome;
        }
        if (outcome.stopped) {
          /* A Stop node ends the run, not the loop as a failure — the
             results collected so far are still real output. */
          settleLoop("completed", undefined, {
            results,
            count: results.length,
          });
          return { kind: "ok", stopped: true };
        }
        const settled = iterationSteps.get(`${iterationKey}:${bodyId}`);
        if (settled?.status === "completed") lastBodyOutput = settled.output;
      }
      results.push(bodyIds.length > 0 ? lastBodyOutput : units[index]);
    }

    const output = { results, count: results.length };
    scope[ref] = output;
    lastOutput = output;
    return settleLoop("completed", undefined, output);
  }

  /* ---------------------------------------------------------------- */
  /* Drive the graph                                                   */
  /* ---------------------------------------------------------------- */

  const topLevelContext: RunContext = {
    iterationKey: null,
    lookup: (id) => stepsByNode.get(id),
    assumed: EMPTY_SET,
  };

  for (const nodeId of graph.topo) {
    if (consumed.has(nodeId)) continue;
    if (signal.aborted) {
      return finish("cancelled", { code: "CANCELLED", message: "Execution cancelled." });
    }
    const outcome = await runNode(nodeId, topLevelContext);
    if (outcome.kind === "fail") return finish(outcome.status, outcome.error);
    if (outcome.stopped) return finish("completed");
  }

  if (signal.aborted) {
    return finish("cancelled", { code: "CANCELLED", message: "Execution cancelled." });
  }
  return finish("completed");
}
