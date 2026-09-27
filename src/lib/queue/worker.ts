import { Worker, UnrecoverableError, type Job } from "bullmq";
import { queueName, redisUrl, workerConcurrency } from "@/lib/config/env";
import {
  FatalJobError,
  processExecutionJob,
  sweepExecutions,
  type SweepResult,
} from "@/lib/server/execution-runner";
import { run as sqlRun, now, queryOne } from "@/lib/server/db";
import { redisOptions } from "@/lib/server/redis";
import { enqueueExecution, executionJobState } from "./index";

/**
 * The BullMQ worker.
 *
 * Same processor the memory driver calls (`processExecutionJob`), plus
 * the two things a background process owns: a heartbeat row so the API
 * can tell whether anyone is actually consuming the queue, and the
 * sweeper that reconciles executions whose transport job vanished.
 */

const SWEEP_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_STALE_MS = 45_000;

interface WorkerHandle {
  worker: Worker;
  timers: Array<ReturnType<typeof setInterval>>;
}

let handle: WorkerHandle | null = null;

async function processor(job: Job<{ executionId: string }>): Promise<void> {
  try {
    await processExecutionJob(job.data, { attempt: job.attemptsMade });
  } catch (error) {
    if (error instanceof FatalJobError) {
      throw new UnrecoverableError(
        error.detail ? `${error.message} — ${error.detail}` : error.message,
      );
    }
    throw error;
  }
}

export interface StartWorkerOptions {
  concurrency?: number;
  /** Run the reconciliation sweep on a timer (default: on). */
  sweep?: boolean;
}

export async function startWorker(
  options: StartWorkerOptions = {},
): Promise<Worker> {
  if (handle) return handle.worker;

  const worker = new Worker(queueName(), processor, {
    connection: { ...redisOptions(redisUrl()), maxRetriesPerRequest: null },
    concurrency: options.concurrency ?? workerConcurrency(),
  });

  worker.on("error", (error) => {
    console.error("[worker] connection error:", error.message);
  });
  worker.on("failed", (job, error) => {
    const id = job?.id ?? "unknown";
    console.error(`[worker] job ${id} failed:`, error.message);
  });

  await worker.waitUntilReady();

  const timers: Array<ReturnType<typeof setInterval>> = [];
  if (options.sweep !== false) {
    const sweep = setInterval(() => {
      void runSweep().catch((error) => {
        console.error("[worker] sweep failed:", (error as Error).message);
      });
    }, SWEEP_INTERVAL_MS);
    sweep.unref?.();
    timers.push(sweep);
  }

  const heartbeat = setInterval(() => writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  timers.push(heartbeat);

  handle = { worker, timers };
  writeHeartbeat();
  return worker;
}

export async function closeWorker(): Promise<void> {
  const current = handle;
  handle = null;
  if (!current) return;
  for (const timer of current.timers) clearInterval(timer);
  clearHeartbeat();
  await current.worker.close();
}

export async function runSweep(): Promise<SweepResult> {
  return sweepExecutions({
    state: executionJobState,
    enqueue: enqueueExecution,
  });
}

/* ------------------------------------------------------------------ */
/* Heartbeat                                                           */
/* ------------------------------------------------------------------ */

function writeHeartbeat(): void {
  try {
    sqlRun(
      "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('worker_heartbeat', ?)",
      JSON.stringify({
        pid: process.pid,
        at: now(),
        queue: queueName(),
        concurrency: options().concurrency,
      }),
    );
  } catch {
    /* a heartbeat failure must never take the worker down */
  }
}

function clearHeartbeat(): void {
  try {
    sqlRun("DELETE FROM app_meta WHERE key = 'worker_heartbeat'");
  } catch {
    /* shutting down anyway */
  }
}

function options(): { concurrency: number } {
  return { concurrency: handle?.worker.opts.concurrency ?? 0 };
}

export interface HeartbeatView {
  alive: boolean;
  at: number | null;
  ageMs: number | null;
  queue: string;
  concurrency: number;
}

/** Read the worker's heartbeat (API side, `/api/queue`). */
export function readHeartbeat(): HeartbeatView {
  const row = queryOne<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = 'worker_heartbeat'",
  );
  const fallback: HeartbeatView = {
    alive: false,
    at: null,
    ageMs: null,
    queue: queueName(),
    concurrency: 0,
  };
  if (!row) return fallback;
  try {
    const parsed = JSON.parse(row.value) as {
      at?: number;
      queue?: string;
      concurrency?: number;
    };
    const at = typeof parsed.at === "number" ? parsed.at : null;
    const ageMs = at ? Date.now() - at : null;
    return {
      alive: ageMs !== null && ageMs < HEARTBEAT_STALE_MS,
      at,
      ageMs,
      queue: parsed.queue ?? queueName(),
      concurrency: parsed.concurrency ?? 0,
    };
  } catch {
    return fallback;
  }
}
