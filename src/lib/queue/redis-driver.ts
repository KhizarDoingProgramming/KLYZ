import { Queue, type JobsOptions, type QueueOptions } from "bullmq";
import {
  jobAttempts,
  jobBackoffMs,
  queueName,
  redisUrl,
} from "@/lib/config/env";
import { redisOptions } from "@/lib/server/redis";
import type { ExecutionJob, JobState, QueueDriverApi, QueueStats } from "./types";

/**
 * BullMQ driver — the production transport.
 *
 * Jobs carry only an execution id: the database is the source of truth
 * for what to run, so a duplicate or delayed delivery is always safe to
 * reconcile (see the claim guard in execution-runner). Retries configured
 * here cover *transport* failures; node-level retries stay inside the
 * engine's own retry policy.
 */

let queue: Queue | null = null;

export function getQueue(): Queue {
  if (!queue) {
    const options: QueueOptions = {
      connection: { ...redisOptions(redisUrl()), maxRetriesPerRequest: null },
      defaultJobOptions: {
        attempts: jobAttempts(),
        backoff: { type: "exponential", delay: jobBackoffMs() },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
      },
    };
    queue = new Queue(queueName(), options);
  }
  return queue;
}

function jobOptions(executionId: string): JobsOptions {
  return {
    jobId: executionId,
    attempts: jobAttempts(),
    backoff: { type: "exponential", delay: jobBackoffMs() },
  };
}

export function jobStateName(raw: string | undefined): JobState {
  switch (raw) {
    case "waiting":
    case "prioritized":
      return "waiting";
    case "active":
      return "active";
    case "delayed":
      return "delayed";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

export const redisDriver: QueueDriverApi = {
  async enqueue(job: ExecutionJob): Promise<void> {
    await getQueue().add("execute", job, jobOptions(job.executionId));
  },

  async remove(executionId: string): Promise<boolean> {
    try {
      /* An active job cannot be removed — its processor decides. */
      const removed = await getQueue().remove(executionId);
      if (removed > 0) return true;
      const existing = await getQueue().getJob(executionId);
      if (!existing) return false;
      const stateName = await existing.getState();
      if (stateName === "delayed" || stateName === "waiting" || stateName === "prioritized") {
        await existing.remove();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  async state(executionId: string): Promise<JobState> {
    try {
      const job = await getQueue().getJob(executionId);
      if (!job) return "unknown";
      return jobStateName(await job.getState());
    } catch {
      return "unknown";
    }
  },

  async stats(): Promise<QueueStats> {
    const base = {
      driver: "redis" as const,
      name: queueName(),
      reachable: true,
    };
    try {
      const target = getQueue();
      const counts = await target.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "completed",
      );
      return {
        ...base,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
      };
    } catch (error) {
      return {
        ...base,
        reachable: false,
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
        detail: error instanceof Error ? error.message : "Redis unreachable",
      };
    }
  },

  async close(): Promise<void> {
    const target = queue;
    queue = null;
    if (target) await target.close();
  },
};
