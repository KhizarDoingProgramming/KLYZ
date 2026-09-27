/**
 * Registry of executions currently running in this process.
 *
 * Lives on `globalThis` for the same reason as the event bus: a dev
 * reload must not orphan a running engine, and cancellation needs a
 * stable place to find the abort controller.
 */

export interface ActiveRun {
  controller: AbortController;
  startedAt: number;
  workflowId: string;
  workspaceId: string;
}

function runs(): Map<string, ActiveRun> {
  const global = globalThis as typeof globalThis & { __klyzRuns?: Map<string, ActiveRun> };
  if (!global.__klyzRuns) global.__klyzRuns = new Map();
  return global.__klyzRuns;
}

export function registerRun(executionId: string, run: ActiveRun): void {
  runs().set(executionId, run);
}

export function finishRun(executionId: string): void {
  runs().delete(executionId);
}

export function getRun(executionId: string): ActiveRun | undefined {
  return runs().get(executionId);
}
