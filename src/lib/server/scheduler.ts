import { auditAs } from "@/lib/server/audit";
import type { Workflow } from "@/lib/workflow/types";
import {
  advanceNextRun,
  claimOccurrence,
  dueSchedules,
  finishOccurrence,
  resolvePinnedDefinition,
} from "./triggers";
import { assertRunnable, startPinnedRun, workflowStatusFor } from "./execution-service";
import type { Actor } from "./identity";

/**
 * The schedule loop.
 *
 * One question, asked on a timer: which schedules are due, and has
 * anyone already taken this occurrence? Everything else — validation,
 * pinning, rate limits, the queue — is the same code a manual run uses.
 *
 * Three properties matter and are enforced here rather than assumed:
 *
 *  - **At most once per occurrence.** `claimOccurrence` inserts into a
 *    table keyed by `(trigger_id, occurrence_key)`; the process that
 *    does not get the row walks away. Two workers, a tick that overlaps
 *    the previous one, and a cron that lands on the same instant all
 *    collapse to one execution.
 *  - **Pinned, never republished.** The run goes through
 *    `startPinnedRun` with the workflow's *published* version. A
 *    schedule cannot mint a version, cannot publish a draft, and cannot
 *    run a graph a human never approved.
 *  - **No backlog.** The cursor advances past *now*, not to the next
 *    missed slot. A worker that was down for a day resumes on schedule
 *    instead of replaying a thousand runs nobody is waiting for.
 */

const SCHEDULER_ACTOR_ID = "u_scheduler";

export interface SchedulerTickResult {
  at: number;
  examined: number;
  fired: number;
  alreadyClaimed: number;
  blocked: number;
  failed: number;
}

export interface SchedulerTickOptions {
  at?: number;
  limit?: number;
}

/**
 * Fire every schedule that is due as of `at`.
 *
 * Never throws for a single bad row: one workflow with a broken
 * published version records its failure against the occurrence and the
 * rest of the tick continues.
 */
export async function runSchedulerTick(
  options: SchedulerTickOptions = {},
): Promise<SchedulerTickResult> {
  const at = options.at ?? Date.now();
  const limit = options.limit ?? 50;
  const result: SchedulerTickResult = {
    at,
    examined: 0,
    fired: 0,
    alreadyClaimed: 0,
    blocked: 0,
    failed: 0,
  };

  const due = dueSchedules(at, limit);
  result.examined = due.length;

  for (const item of due) {
    const { row, occurrenceAt, key } = item;
    const actor: Actor = { userId: SCHEDULER_ACTOR_ID, workspaceId: row.workspace_id };

    /* Claim first, decide second — the row is the lock. */
    if (!claimOccurrence(row, key, at)) {
      result.alreadyClaimed += 1;
      advanceNextRun(row, at);
      continue;
    }

    try {
      const pinned = resolvePinnedDefinition(row.workflow_id, row.workspace_id);
      if (!pinned) {
        finishOccurrence(row.id, key, {
          status: "skipped",
          error: "The workflow has no published version yet.",
        });
        result.blocked += 1;
        advanceNextRun(row, at);
        continue;
      }

      /* A trigger row can outlive the node that justified it — the
         draft may have swapped the schedule for a webhook since. Only
         fire what the published graph still actually declares. */
      if (!declaresSchedule(pinned.definition)) {
        finishOccurrence(row.id, key, {
          status: "skipped",
          error: "The published workflow no longer has a schedule trigger.",
        });
        result.blocked += 1;
        advanceNextRun(row, at);
        continue;
      }

      /* Paused and disabled are a decision, not a failure — the same
         "we chose not to fire" bookkeeping as the two cases above. The
         status lives on the row: a published snapshot keeps whatever it
         was published with. */
      const status = workflowStatusFor(row.workspace_id, row.workflow_id);
      if (status === "paused" || status === "disabled") {
        finishOccurrence(row.id, key, {
          status: "skipped",
          error: `The workflow is ${status}.`,
        });
        result.blocked += 1;
        advanceNextRun(row, at);
        continue;
      }

      assertRunnable(pinned.definition);

      const execution = await startPinnedRun(actor, {
        definition: pinned.definition,
        versionId: pinned.versionId,
        version: pinned.version,
        source: "schedule",
        trigger: { type: "trigger.schedule" },
        input: {
          scheduledFor: new Date(occurrenceAt).toISOString(),
          runKey: key,
          timezone: row.schedule_timezone ?? "UTC",
          cron: row.schedule_cron,
          firedAt: new Date(at).toISOString(),
        },
        triggerId: row.id,
        occurrenceKey: key,
      });

      finishOccurrence(row.id, key, { executionId: execution.id, status: "queued" });
      auditAs(actor, "schedule.executed", {
        resourceType: "workflow",
        resourceId: row.workflow_id,
        metadata: {
          triggerId: row.id,
          occurrence: key,
          executionId: execution.id,
          cron: row.schedule_cron,
          timezone: row.schedule_timezone,
        },
      });
      result.fired += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The schedule could not start.";
      finishOccurrence(row.id, key, { status: "failed", error: message });
      result.failed += 1;
    }

    /* Advance in both directions: the next occurrence, or NULL when the
       expression has nothing left. It is written after the fire so a
       crash mid-fire re-offers the same key and the claim blocks it. */
    advanceNextRun(row, at);
  }

  return result;
}

/** Does the published graph still declare a schedule trigger? */
function declaresSchedule(definition: Workflow): boolean {
  return (
    definition.triggerType === "trigger.schedule" ||
    definition.nodes.some((node) => node.type === "trigger.schedule")
  );
}

export interface SchedulerHandle {
  stop(): void;
}

/**
 * Start the loop. Returns a handle that stops it.
 *
 * Overlap is refused rather than queued: a tick that has not finished
 * does not spawn a second one, so a slow queue cannot make the worker
 * spiral. The next interval simply tries again.
 */
export function startScheduler(options: {
  intervalMs: number;
  batch: number;
}): SchedulerHandle {
  let running = false;
  let stopped = false;

  const tick = () => {
    if (stopped || running) return;
    running = true;
    void runSchedulerTick({ limit: options.batch })
      .catch(() => {
        /* A tick that blows up must not take the worker down; the next
           one is already scheduled. */
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, options.intervalMs);
  /* Never hold the process open just to keep a timer alive. */
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
