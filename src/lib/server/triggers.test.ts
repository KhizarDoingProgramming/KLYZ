import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* One real database for the whole file — the scheduler, the receiver
   and the API all talk to it exactly as they do in production. */
const tmpDir = mkdtempSync(join(tmpdir(), "klyz-trigger-test-"));
process.env.KLYZ_DB_PATH = join(tmpDir, "klyz.db");
process.env.KLYZ_QUEUE_DRIVER = "memory";

import { HttpError } from "./http";
import { defaultActor } from "./identity";
import { getDb, queryAll, queryOne, run as sqlRun } from "./db";
import { resetRateLimits } from "./rate-limit";
import { createTestAccount, type TestAccount } from "./testing";
import {
  createWorkflowFor,
  getWorkflowFor,
  publishWorkflowFor,
  runWorkflowFor,
  saveDraftFor,
  updateWorkflowFor,
} from "./workflow-service";
import {
  advanceNextRun,
  claimOccurrence,
  dueSchedules,
  getTriggerRow,
  readTriggerFor,
  setTriggerFor,
} from "./triggers";
import { runSchedulerTick } from "./scheduler";
import { publishWebhook, receiveWebhook } from "./webhooks";
import type { Workflow } from "@/lib/workflow/types";

const actor = defaultActor();

afterAll(() => {
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetRateLimits();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code} but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status, `status for ${code}`).toBe(status);
    expect((error as HttpError).code, `code for ${code}`).toBe(code);
  }
}

function baseWorkflow(id: string, triggerType: string, config: Record<string, unknown>): Workflow {
  const ref = triggerType === "trigger.schedule" ? "schedule" : "manual";
  return {
    id,
    name: `Trigger test ${id}`,
    description: "",
    status: "draft",
    tags: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastExecutedAt: null,
    executionCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    triggerType,
    nodeCount: 2,
    nodes: [
      {
        id: "n_trigger",
        type: triggerType,
        position: { x: 0, y: 0 },
        data: { ref, config },
      },
      {
        id: "n_log",
        type: "action.log",
        position: { x: 240, y: 0 },
        data: { ref: "log", config: { message: `ran ${id}` } },
      },
    ],
    edges: [{ id: "e1", source: "n_trigger", target: "n_log" }],
  };
}

function scheduleWorkflow(id: string, config: Record<string, unknown> = {}): Workflow {
  return baseWorkflow(id, "trigger.schedule", {
    every: "cron",
    cron: "0 9 * * 1-5",
    timezone: "UTC",
    ...config,
  });
}

function manualWorkflow(id: string): Workflow {
  return baseWorkflow(id, "trigger.manual", {});
}

function versionCount(workflowId: string): number {
  const row = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id = ?",
    workflowId,
  );
  return row?.n ?? 0;
}

function executionsFor(workflowId: string): string[] {
  return queryAll<{ id: string }>(
    "SELECT id FROM executions WHERE workflow_id = ? ORDER BY created_at DESC",
    workflowId,
  ).map((row) => row.id);
}

/** Force a schedule row to be due at `at` without waiting for a cron. */
function forceDue(workflowId: string, at: number): void {
  sqlRun("UPDATE workflow_triggers SET next_run_at = ? WHERE workflow_id = ?", at, workflowId);
}

/* ------------------------------------------------------------------ */
/* Creation and backfill                                               */
/* ------------------------------------------------------------------ */

describe("trigger rows", () => {
  it("is created with the workflow, from the definition's own trigger", () => {
    const id = "wf_trg_created";
    createWorkflowFor(actor, { id,
      name: "Created with a schedule",
      definition: scheduleWorkflow(id, { every: "1h", timezone: "Asia/Karachi" }),
    });

    const row = getTriggerRow(id);
    expect(row).not.toBeNull();
    expect(row?.type).toBe("schedule");
    expect(row?.enabled).toBe(1);
    expect(row?.schedule_cron).toBe("0 * * * *");
    expect(row?.schedule_timezone).toBe("Asia/Karachi");
  });

  it("is not created for a provider trigger, which has its own card", async () => {
    const id = "wf_trg_provider";
    createWorkflowFor(actor, { id,
      name: "GitHub trigger",
      definition: baseWorkflow(id, "trigger.github", { repo: "klyz/platform" }),
    });
    expect(getTriggerRow(id)).toBeNull();

    const state = readTriggerFor(actor, id);
    expect(state.managed).toBe(false);
    expect(state.type).toBeNull();
    await expectHttpError(
      Promise.resolve().then(() => setTriggerFor(actor, id, { enabled: false })),
      422,
      "UNSUPPORTED_TRIGGER",
    );
  });

  it("gives the seeded schedules a row so they can fire unattended", () => {
    const row = getTriggerRow("wf_nightly_sync");
    expect(row?.type).toBe("schedule");
    expect(row?.enabled).toBe(1);
    expect(row?.schedule_cron).toBe("0 2 * * *");
  });
});

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

describe("schedule validation", () => {
  it("refuses a cron expression it cannot parse", async () => {
    const id = "wf_trg_badcron";
    createWorkflowFor(actor, { id, name: "Bad cron", definition: scheduleWorkflow(id) });

    await expectHttpError(
      Promise.resolve().then(() =>
        setTriggerFor(actor, id, {
          schedule: { every: "cron", cron: "every monday-ish", timezone: "UTC" },
        }),
      ),
      422,
      "BAD_CRON",
    );
    /* The rejected write changed nothing. */
    expect(getTriggerRow(id)?.schedule_cron).toBe("0 9 * * 1-5");
  });

  it("refuses a timezone Intl does not recognise", async () => {
    const id = "wf_trg_badtz";
    createWorkflowFor(actor, { id, name: "Bad tz", definition: scheduleWorkflow(id) });

    await expectHttpError(
      Promise.resolve().then(() =>
        setTriggerFor(actor, id, {
          schedule: { every: "cron", cron: "0 9 * * *", timezone: "Mars/Olympus" },
        }),
      ),
      422,
      "BAD_TIMEZONE",
    );
    expect(getTriggerRow(id)?.schedule_timezone).toBe("UTC");
  });

  it("resolves an interval preset to cron and previews the next runs", () => {
    const id = "wf_trg_preset";
    createWorkflowFor(actor, { id, name: "Preset", definition: scheduleWorkflow(id) });

    const state = setTriggerFor(actor, id, {
      schedule: { every: "15m", timezone: "Europe/Berlin" },
    });
    expect(state.schedule?.cron).toBe("*/15 * * * *");
    expect(state.schedule?.every).toBe("15m");
    expect(state.schedule?.timezone).toBe("Europe/Berlin");
    expect(state.schedule?.nextRunAt).toBeTruthy();
    expect(state.schedule!.preview.length).toBeGreaterThanOrEqual(3);
    /* Strictly increasing, and all in the future. */
    const times = state.schedule!.preview.map((iso) => Date.parse(iso));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times[0]).toBeGreaterThan(Date.now());
  });
});

/* ------------------------------------------------------------------ */
/* Arming                                                              */
/* ------------------------------------------------------------------ */

describe("arming a trigger", () => {
  it("stops a manual run when the trigger is switched off", async () => {
    const id = "wf_trg_manual";
    createWorkflowFor(actor, { id, name: "Manual", definition: manualWorkflow(id) });

    const first = await runWorkflowFor(actor, id, {});
    expect(first.source).toBe("manual");

    setTriggerFor(actor, id, { enabled: false });
    await expectHttpError(runWorkflowFor(actor, id, {}), 422, "TRIGGER_DISABLED");

    setTriggerFor(actor, id, { enabled: true });
    const third = await runWorkflowFor(actor, id, {});
    expect(third.source).toBe("manual");
  });

  it("keeps the implicit publish a manual run has always done", async () => {
    const id = "wf_trg_implicit";
    createWorkflowFor(actor, { id, name: "Implicit", definition: manualWorkflow(id) });
    expect(versionCount(id)).toBe(0);

    const execution = await runWorkflowFor(actor, id, {});
    expect(versionCount(id)).toBe(1);
    expect(execution.workflowVersionId).toBeTruthy();
  });

  it("stops webhook deliveries with the same 404 a missing endpoint gets", async () => {
    const id = "wf_trg_wh_gate";
    const definition = baseWorkflow(id, "trigger.webhook", {
      path: "/hooks/gate",
      method: "POST",
      auth: "none",
    });
    const view = publishWebhook(actor, { definition });

    const accepted = await receiveWebhook(
      deliveryRequest(`http://localhost/api/webhooks/${view.slug}`),
      view.slug,
    );
    expect(accepted.executionId).toBeTruthy();

    setTriggerFor(actor, id, { enabled: false });
    await expectHttpError(
      receiveWebhook(deliveryRequest(`http://localhost/api/webhooks/${view.slug}`), view.slug),
      404,
      "WEBHOOK_NOT_FOUND",
    );

    setTriggerFor(actor, id, { enabled: true });
    const back = await receiveWebhook(
      deliveryRequest(`http://localhost/api/webhooks/${view.slug}`),
      view.slug,
    );
    expect(back.executionId).toBeTruthy();
  });

  it("reports why a schedule is not armed yet", () => {
    const id = "wf_trg_blocked";
    createWorkflowFor(actor, { id, name: "Not published", definition: scheduleWorkflow(id) });

    const state = readTriggerFor(actor, id);
    expect(state.armed).toBe(false);
    expect(state.blockedBy).toMatch(/published/i);
  });

  it("shows an armed schedule once it is published", () => {
    const id = "wf_trg_armed";
    createWorkflowFor(actor, { id, name: "Armed", definition: scheduleWorkflow(id) });
    publishWorkflowFor(actor, id);

    const state = readTriggerFor(actor, id);
    expect(state.armed).toBe(true);
    expect(state.blockedBy).toBeNull();
    expect(state.enabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Permissions and tenancy                                             */
/* ------------------------------------------------------------------ */

describe("trigger access", () => {
  it("hides another workspace's trigger behind a 404", () => {
    const id = "wf_trg_private";
    createWorkflowFor(actor, { id, name: "Private", definition: scheduleWorkflow(id) });

    const stranger: TestAccount = createTestAccount();
    expect(() => readTriggerFor(stranger.actor, id)).toThrow(HttpError);
    try {
      readTriggerFor(stranger.actor, id);
    } catch (error) {
      expect((error as HttpError).status).toBe(404);
    }
    expect(() => setTriggerFor(stranger.actor, id, { enabled: false })).toThrow(HttpError);
    expect(getTriggerRow(id)?.enabled).toBe(1);
  });

  it("lets a viewer read but not write", () => {
    const id = "wf_trg_viewer";
    createWorkflowFor(actor, { id, name: "Viewer", definition: scheduleWorkflow(id) });
    const viewer = createTestAccount({ role: "viewer", workspaceId: actor.workspaceId });

    expect(readTriggerFor(viewer.actor, id).type).toBe("schedule");
    try {
      setTriggerFor(viewer.actor, id, { enabled: false });
      throw new Error("expected a permission failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(403);
    }
    expect(getTriggerRow(id)?.enabled).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Publish adopts the schedule                                         */
/* ------------------------------------------------------------------ */

describe("publishing", () => {
  it("copies the node's schedule into the trigger row", () => {
    const id = "wf_trg_publish_sync";
    const created = createWorkflowFor(actor, { id,
      name: "Publish sync",
      definition: scheduleWorkflow(id, { cron: "0 9 * * 1-5" }),
    });
    expect(getTriggerRow(id)?.schedule_cron).toBe("0 9 * * 1-5");

    const next = scheduleWorkflow(id, { cron: "30 4 * * 0", timezone: "Asia/Karachi" });
    saveDraftFor(actor, id, { definition: next, revision: created.revision });
    publishWorkflowFor(actor, id);

    const row = getTriggerRow(id);
    expect(row?.schedule_cron).toBe("30 4 * * 0");
    expect(row?.schedule_timezone).toBe("Asia/Karachi");
    /* The cursor was cleared, so the next run is derived from the new
       expression rather than the old one. */
    expect(row?.next_run_at).toBeNull();
    expect(readTriggerFor(actor, id).schedule?.cron).toBe("30 4 * * 0");
  });
});

/* ------------------------------------------------------------------ */
/* Toggling without rewriting the schedule                             */
/* ------------------------------------------------------------------ */

describe("switch only", () => {
  it("keeps the expression and the cursor when only the switch changes", () => {
    const id = "wf_trg_switch_only";
    createWorkflowFor(actor, {
      id,
      name: "Switch only",
      definition: scheduleWorkflow(id, { cron: "*/15 * * * *", timezone: "Asia/Karachi" }),
    });
    publishWorkflowFor(actor, id);

    const cursor = 2_000_000_000_000;
    sqlRun("UPDATE workflow_triggers SET next_run_at = ? WHERE workflow_id = ?", cursor, id);

    setTriggerFor(actor, id, { enabled: false });
    const off = getTriggerRow(id);
    expect(off?.enabled).toBe(0);
    expect(off?.schedule_cron).toBe("*/15 * * * *");
    expect(off?.schedule_timezone).toBe("Asia/Karachi");
    expect(off?.next_run_at).toBe(cursor);

    setTriggerFor(actor, id, { enabled: true });
    const on = getTriggerRow(id);
    expect(on?.enabled).toBe(1);
    expect(on?.schedule_cron).toBe("*/15 * * * *");
    expect(on?.next_run_at).toBe(cursor);
    expect(readTriggerFor(actor, id).armed).toBe(true);
  });

  it("does not shift a cursor the expression never changed around", async () => {
    const id = "wf_trg_cursor_kept";
    createWorkflowFor(actor, { id, name: "Cursor kept", definition: scheduleWorkflow(id) });
    publishWorkflowFor(actor, id);

    /* The tick primes the cursor from the published expression. */
    runSchedulerTick({ at: Date.parse("2026-03-02T11:59:00.000Z"), limit: 50 });
    const primed = getTriggerRow(id)?.next_run_at;
    expect(primed).toBeGreaterThan(Date.parse("2026-03-02T11:59:00.000Z"));

    /* Restating the very same expression must not move it. */
    setTriggerFor(actor, id, {
      enabled: true,
      schedule: { every: "cron", cron: "0 9 * * 1-5", timezone: "UTC" },
    });
    expect(getTriggerRow(id)?.next_run_at).toBe(primed);

    /* A genuinely different one does. */
    setTriggerFor(actor, id, {
      enabled: true,
      schedule: { every: "cron", cron: "0 9 * * *", timezone: "UTC" },
    });
    expect(getTriggerRow(id)?.next_run_at).toBeNull();
  });

  it("rebuilds a row that is missing from the definition it belongs to", () => {
    const id = "wf_trg_rowless";
    createWorkflowFor(actor, {
      id,
      name: "Rowless",
      definition: scheduleWorkflow(id, { cron: "30 4 * * 0", timezone: "Asia/Karachi" }),
    });
    publishWorkflowFor(actor, id);
    sqlRun("DELETE FROM workflow_triggers WHERE workflow_id = ?", id);
    expect(getTriggerRow(id)).toBeNull();
    /* Migration safety: a missing row never blocks a read. */
    expect(readTriggerFor(actor, id).enabled).toBe(true);

    setTriggerFor(actor, id, { enabled: true });

    const row = getTriggerRow(id);
    expect(row?.schedule_cron).toBe("30 4 * * 0");
    expect(row?.schedule_timezone).toBe("Asia/Karachi");
    expect(readTriggerFor(actor, id).armed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The schedule loop                                                   */
/* ------------------------------------------------------------------ */

describe("scheduler", () => {
  it("primes a fresh cursor without firing", () => {
    const id = "wf_trg_prime";
    createWorkflowFor(actor, { id, name: "Prime", definition: scheduleWorkflow(id) });
    publishWorkflowFor(actor, id);

    const due = dueSchedules(Date.now() + 60_000, 500);
    expect(due.some((item) => item.row.workflow_id === id)).toBe(false);
    expect(getTriggerRow(id)?.next_run_at).toBeTruthy();
  });

  it("fires a due schedule once, pinned to the published version", async () => {
    const id = "wf_trg_fire";
    createWorkflowFor(actor, { id, name: "Fire", definition: scheduleWorkflow(id) });
    publishWorkflowFor(actor, id);
    const published = getWorkflowFor(actor, id).publishedVersionId;
    expect(published).toBeTruthy();
    expect(versionCount(id)).toBe(1);

    /* The draft moves on after publish — the run must not follow it. */
    saveDraftFor(actor, id, {
      definition: { ...scheduleWorkflow(id, { timezone: "Asia/Karachi" }) },
      revision: getWorkflowFor(actor, id).revision,
    });
    expect(versionCount(id)).toBe(1);

    const at = Date.now();
    forceDue(id, at);
    const tick = await runSchedulerTick({ at, limit: 200 });
    expect(tick.fired).toBeGreaterThanOrEqual(1);

    const rows = queryAll<{
      source: string;
      trigger_type: string;
      workflow_version_id: string;
      workflow_version: number;
      metadata: string | null;
      input: string | null;
    }>(
      "SELECT source, trigger_type, workflow_version_id, workflow_version, metadata, input FROM executions WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1",
      id,
    );
    expect(rows[0]?.source).toBe("schedule");
    expect(rows[0]?.trigger_type).toBe("trigger.schedule");
    expect(rows[0]?.workflow_version_id).toBe(published);
    expect(rows[0]?.workflow_version).toBe(1);
    const input = JSON.parse(rows[0]?.input ?? "{}") as Record<string, unknown>;
    expect(typeof input.scheduledFor).toBe("string");
    expect(typeof input.runKey).toBe("string");

    /* A trigger never mints a version. */
    expect(versionCount(id)).toBe(1);
    /* And the cursor moved on. */
    expect(getTriggerRow(id)!.next_run_at).toBeGreaterThan(at);

    const fire = queryOne<{ status: string; execution_id: string | null }>(
      "SELECT status, execution_id FROM trigger_fires WHERE workflow_id = ? ORDER BY fired_at DESC LIMIT 1",
      id,
    );
    expect(fire?.status).toBe("queued");
    expect(fire?.execution_id).toBeTruthy();
  });

  it("fires at most once per occurrence, even if the tick repeats", async () => {
    const id = "wf_trg_once";
    createWorkflowFor(actor, { id, name: "Once", definition: scheduleWorkflow(id) });
    publishWorkflowFor(actor, id);

    const at = Date.now();
    forceDue(id, at);

    const first = await runSchedulerTick({ at, limit: 200 });
    const before = executionsFor(id).length;
    expect(first.fired).toBeGreaterThanOrEqual(1);

    /* Same instant again — the cursor already moved, and even if it had
       not, the occurrence key is claimed. */
    forceDue(id, at);
    await runSchedulerTick({ at, limit: 200 });
    expect(executionsFor(id).length).toBe(before);

    const fires = queryAll<{ occurrence_key: string }>(
      "SELECT occurrence_key FROM trigger_fires WHERE workflow_id = ?",
      id,
    );
    expect(new Set(fires.map((fire) => fire.occurrence_key)).size).toBe(fires.length);
  });

  it("skips a paused or disabled workflow instead of firing it", async () => {
    const id = "wf_trg_inactive";
    createWorkflowFor(actor, { id, name: "Inactive", definition: scheduleWorkflow(id) });
    publishWorkflowFor(actor, id);
    updateWorkflowFor(actor, id, { status: "paused" });

    const at = Date.now();
    forceDue(id, at);
    const tick = await runSchedulerTick({ at, limit: 200 });

    expect(executionsFor(id)).toHaveLength(0);
    const fire = queryOne<{ status: string; error: string | null; execution_id: string | null }>(
      "SELECT status, error, execution_id FROM trigger_fires WHERE workflow_id = ? ORDER BY fired_at DESC LIMIT 1",
      id,
    );
    expect(fire?.status).toBe("skipped");
    expect(fire?.execution_id).toBeNull();
    expect(fire?.error).toMatch(/paused/);
    /* The cursor still advances: a paused workflow must not build a
       backlog of occurrences to replay when it is switched back on. */
    expect(getTriggerRow(id)!.next_run_at).toBeGreaterThan(at);

    /* Disabled is the same decision. */
    updateWorkflowFor(actor, id, { status: "disabled" });
    forceDue(id, at + 60_000);
    await runSchedulerTick({ at: at + 60_000, limit: 200 });
    expect(executionsFor(id)).toHaveLength(0);
    expect(tick.blocked).toBeGreaterThanOrEqual(1);
  });

  it("skips a schedule whose workflow was never published", async () => {
    const id = "wf_trg_unpublished";
    createWorkflowFor(actor, { id, name: "Unpublished", definition: scheduleWorkflow(id) });

    const at = Date.now();
    forceDue(id, at);
    const tick = await runSchedulerTick({ at, limit: 200 });
    expect(tick.blocked).toBeGreaterThanOrEqual(1);
    expect(executionsFor(id).length).toBe(0);

    const fire = queryOne<{ status: string; error: string | null }>(
      "SELECT status, error FROM trigger_fires WHERE workflow_id = ?",
      id,
    );
    expect(fire?.status).toBe("skipped");
    expect(fire?.error).toMatch(/published/i);
  });

  it("does not fire a row that outlived the node that justified it", async () => {
    const id = "wf_trg_stale";
    const created = createWorkflowFor(actor, { id,
      name: "Stale",
      definition: scheduleWorkflow(id),
    });
    publishWorkflowFor(actor, id);

    /* The schedule is replaced by a manual trigger and republished. */
    saveDraftFor(actor, id, {
      definition: manualWorkflow(id),
      revision: created.revision,
    });
    publishWorkflowFor(actor, id);

    const at = Date.now();
    forceDue(id, at);
    await runSchedulerTick({ at, limit: 200 });

    expect(executionsFor(id).length).toBe(0);
    const fire = queryOne<{ status: string; error: string | null }>(
      "SELECT status, error FROM trigger_fires WHERE workflow_id = ? ORDER BY fired_at DESC LIMIT 1",
      id,
    );
    expect(fire?.status).toBe("skipped");
    expect(fire?.error).toMatch(/no longer has a schedule/i);
  });

  it("claims an occurrence exactly once", () => {
    const id = "wf_trg_claim";
    createWorkflowFor(actor, { id, name: "Claim", definition: scheduleWorkflow(id) });
    publishWorkflowFor(actor, id);
    const row = getTriggerRow(id)!;

    expect(claimOccurrence(row, "2026-09-27T09:00:00.000Z")).toBe(true);
    expect(claimOccurrence(row, "2026-09-27T09:00:00.000Z")).toBe(false);
    expect(claimOccurrence(row, "2026-09-28T09:00:00.000Z")).toBe(true);
    expect(
      queryAll<{ n: number }>(
        "SELECT COUNT(*) AS n FROM trigger_fires WHERE workflow_id = ?",
        id,
      )[0]?.n,
    ).toBe(2);
  });

  it("advances the cursor past the requested instant, not to the missed slot", () => {
    const id = "wf_trg_advance";
    createWorkflowFor(actor, { id, name: "Advance", definition: scheduleWorkflow(id) });
    publishWorkflowFor(actor, id);

    const at = Date.parse("2026-09-27T10:13:00.000Z");
    forceDue(id, at);
    const row = getTriggerRow(id)!;
    const next = advanceNextRun(row, at);

    /* `0 9 * * 1-5` at 10:13 → the next weekday 09:00, never a
       backdated 09:00 on the same day. */
    expect(next).toBeGreaterThan(at);
    const asUtc = new Date(next!).toISOString();
    expect(asUtc.endsWith("T09:00:00.000Z")).toBe(true);
    expect(getTriggerRow(id)?.next_run_at).toBe(next);
  });
});

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

describe("audit trail", () => {
  it("records who armed, disarmed and fired a trigger", async () => {
    const id = "wf_trg_audit";
    createWorkflowFor(actor, { id, name: "Audit", definition: scheduleWorkflow(id) });
    publishWorkflowFor(actor, id);

    setTriggerFor(actor, id, { enabled: false });
    setTriggerFor(actor, id, { enabled: true });

    const at = Date.now();
    forceDue(id, at);
    await runSchedulerTick({ at, limit: 200 });

    const actions = queryAll<{ action: string; resource_id: string }>(
      "SELECT action, resource_id FROM audit_events WHERE resource_id = ? ORDER BY created_at",
      id,
    ).map((row) => row.action);
    expect(actions).toContain("trigger.disabled");
    expect(actions).toContain("trigger.enabled");
    expect(actions).toContain("schedule.executed");

    /* No secret, no body — the metadata is ids and the expression. */
    const meta = queryOne<{ metadata: string | null }>(
      "SELECT metadata FROM audit_events WHERE action = 'schedule.executed' AND resource_id = ?",
      id,
    );
    expect(meta?.metadata ?? "").not.toMatch(/whsec_/);
  });
});

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

describe("manual trigger gate", () => {
  it("leaves a workflow with no trigger row armed", async () => {
    /* A row created by an older schema has no trigger row at all —
       absence must never become a lock-out. */
    const id = "wf_trg_no_row";
    createWorkflowFor(actor, { id, name: "No row", definition: manualWorkflow(id) });
    sqlRun("DELETE FROM workflow_triggers WHERE workflow_id = ?", id);
    expect(getTriggerRow(id)).toBeNull();

    const execution = await runWorkflowFor(actor, id, {});
    expect(execution.source).toBe("manual");
  });
});

/* ------------------------------------------------------------------ */
/* Request builder                                                     */
/* ------------------------------------------------------------------ */

function deliveryRequest(url: string, init: { body?: string } = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: init.body ?? JSON.stringify({ msg: "hello" }),
  });
}
