import type { QueueDriver } from "@/lib/config/env";

/** The only payload a queue job ever carries. State lives in SQLite. */
export interface ExecutionJob {
  executionId: string;
}

export interface QueueStats {
  driver: QueueDriver;
  name: string;
  /** Jobs waiting to be picked up. */
  waiting: number;
  /** Jobs currently being processed. */
  active: number;
  /** Jobs scheduled for a later attempt (backoff). */
  delayed: number;
  /** Jobs whose attempts were exhausted. */
  failed: number;
  /** Recently finished jobs. */
  completed: number;
  /** True when this process can reach the transport. */
  reachable: boolean;
  detail?: string;
}

export type JobState = "unknown" | "waiting" | "active" | "delayed" | "completed" | "failed";

export interface QueueDriverApi {
  enqueue(job: ExecutionJob, attempt?: number): Promise<void>;
  /** Remove a not-yet-running job. Returns false when it was already active. */
  remove(executionId: string): Promise<boolean>;
  /** Current state of a job by execution id. */
  state(executionId: string): Promise<JobState>;
  stats(): Promise<QueueStats>;
  close(): Promise<void>;
}
