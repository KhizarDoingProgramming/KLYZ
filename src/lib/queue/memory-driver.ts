import { processExecutionJob } from "@/lib/server/execution-runner";
import type { ExecutionJob, JobState, QueueDriverApi, QueueStats } from "./types";

/**
 * In-process queue driver.
 *
 * Used when NODE_ENV=test (or KLYZ_QUEUE_DRIVER=memory): it runs the
 * *same* job processor the BullMQ worker uses, just without a network
 * transport. It exists so the unit-test suite exercises the real
 * claim → engine → persist path without requiring Docker — never as an
 * alternative production execution path.
 */

interface MemoryJob {
  id: string;
  state: "queued" | "active" | "completed" | "failed" | "cancelled";
}

interface MemoryState {
  jobs: Map<string, MemoryJob>;
  inFlight: Set<Promise<void>>;
  completed: number;
  failed: number;
  nextRun: Promise<void> | null;
}

function state(): MemoryState {
  const global = globalThis as typeof globalThis & { __klyzMemoryQueue?: MemoryState };
  if (!global.__klyzMemoryQueue) {
    global.__klyzMemoryQueue = {
      jobs: new Map(),
      inFlight: new Set(),
      completed: 0,
      failed: 0,
      nextRun: null,
    };
  }
  return global.__klyzMemoryQueue;
}

function schedule(job: ExecutionJob, attempt: number): void {
  const mem = state();
  const record = mem.jobs.get(job.executionId);
  if (record?.state === "cancelled") return;

  const promise = (async () => {
    if (record) record.state = "active";
    try {
      await processExecutionJob(job, { attempt });
      mem.completed += 1;
      if (record) record.state = "completed";
    } catch {
      /* No transport-level retries in memory mode: record it honestly. */
      mem.failed += 1;
      if (record) record.state = "failed";
    }
  })();
  mem.inFlight.add(promise);
  void promise.then(() => {
    mem.inFlight.delete(promise);
  });
}

export const memoryDriver: QueueDriverApi = {
  async enqueue(job: ExecutionJob, attempt = 0): Promise<void> {
    const mem = state();
    const existing = mem.jobs.get(job.executionId);
    if (existing && (existing.state === "queued" || existing.state === "active")) {
      return; /* already scheduled — same guarantee BullMQ's jobId gives */
    }
    mem.jobs.set(job.executionId, { id: job.executionId, state: "queued" });
    schedule(job, attempt);
  },

  async remove(executionId: string): Promise<boolean> {
    const mem = state();
    const job = mem.jobs.get(executionId);
    if (!job) return false;
    if (job.state === "queued") {
      job.state = "cancelled";
      return true;
    }
    if (job.state === "active") return false;
    return false;
  },

  async state(executionId: string): Promise<JobState> {
    const job = state().jobs.get(executionId);
    if (!job) return "unknown";
    if (job.state === "queued") return "waiting";
    if (job.state === "active") return "active";
    if (job.state === "completed") return "completed";
    if (job.state === "failed") return "failed";
    return "unknown";
  },

  async stats(): Promise<QueueStats> {
    const mem = state();
    let waiting = 0;
    let active = 0;
    for (const job of mem.jobs.values()) {
      if (job.state === "queued") waiting += 1;
      if (job.state === "active") active += 1;
    }
    return {
      driver: "memory",
      name: "in-process",
      waiting,
      active,
      delayed: 0,
      failed: mem.failed,
      completed: mem.completed,
      reachable: true,
      detail: "Jobs run in this process (test/dev transport).",
    };
  },

  async close(): Promise<void> {
    await drainMemoryQueue();
  },
};

/**
 * Wait until every scheduled job has finished (and any jobs they
 * scheduled in turn). Test helper — never used at runtime.
 */
export async function drainMemoryQueue(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = [...state().inFlight];
    if (pending.length === 0) return;
    await Promise.all(pending);
    if (Date.now() > deadline) {
      throw new Error(`memory queue did not drain within ${timeoutMs}ms`);
    }
  }
}

/** Forget every job record — test isolation helper. */
export function resetMemoryQueue(): void {
  const mem = state();
  mem.jobs.clear();
  mem.completed = 0;
  mem.failed = 0;
}
