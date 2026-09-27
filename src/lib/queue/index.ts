import { queueDriver } from "@/lib/config/env";
import { drainMemoryQueue, memoryDriver, resetMemoryQueue } from "./memory-driver";
import { redisDriver } from "./redis-driver";
import type { ExecutionJob, JobState, QueueDriverApi, QueueStats } from "./types";

/**
 * Queue facade.
 *
 * One function surface for "put an execution on the queue", "take it
 * off" and "ask what the queue looks like". Which transport answers is
 * configuration (`KLYZ_QUEUE_DRIVER`), not a code path the rest of the
 * app has to know about — the processor on the other side is always
 * `processExecutionJob`.
 */

function driver(): QueueDriverApi {
  return queueDriver() === "memory" ? memoryDriver : redisDriver;
}

export async function enqueueExecution(job: ExecutionJob): Promise<void> {
  return driver().enqueue(job);
}

/** Cancel a job that has not started running. */
export async function removeQueuedJob(executionId: string): Promise<boolean> {
  return driver().remove(executionId);
}

export async function executionJobState(executionId: string): Promise<JobState> {
  return driver().state(executionId);
}

export async function queueStats(): Promise<QueueStats> {
  return driver().stats();
}

export async function closeQueue(): Promise<void> {
  return driver().close();
}

export { drainMemoryQueue, resetMemoryQueue };
export type { ExecutionJob, JobState, QueueStats } from "./types";
