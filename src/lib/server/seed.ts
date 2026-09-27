import { createHash } from "node:crypto";
import { DEMO_WORKFLOWS, getWorkflow } from "@/lib/demo/workflows";
import { getDefinition } from "@/lib/workflow/registry";
import { stripRuntimeState, stripWebhookSecrets } from "@/lib/workflow/sanitize";
import type { Workflow } from "@/lib/workflow/types";
import { now, queryOne, run, toJson } from "./db";
import { cronFromConfig, timezoneFromConfig } from "@/lib/workflow/schedule";
import { buildExecutionPlan } from "./seed/plan";

/**
 * Development seed data — clearly marked, never fabricated at runtime.
 *
 * First launch gets believable history so the dashboard, execution list
 * and detail pages are populated, but every seeded row is stored with
 * `source = 'seed'` and `metadata.seed = true`, and the UI labels it.
 * All real executions are written by the engine.
 */

interface SeedRun {
  workflowId: string;
  minutesAgo: number;
  failAt?: string;
  note?: string;
}

const SEED_RUNS: SeedRun[] = [
  { workflowId: "wf_customer_intake", minutesAgo: 2 },
  { workflowId: "wf_github_triage", minutesAgo: 6 },
  { workflowId: "wf_customer_intake", minutesAgo: 18 },
  { workflowId: "wf_github_triage", minutesAgo: 41 },
  { workflowId: "wf_support_triage", minutesAgo: 27 },
  { workflowId: "wf_customer_intake", minutesAgo: 55 },
  {
    workflowId: "wf_github_triage",
    minutesAgo: 126,
    failAt: "n_notion",
    note: "Notion timed out; the Postgres step still recorded the run.",
  },
  { workflowId: "wf_support_triage", minutesAgo: 190 },
  { workflowId: "wf_nightly_sync", minutesAgo: 1140 },
  {
    workflowId: "wf_crm_sync",
    minutesAgo: 1560,
    failAt: "n_h",
    note: "Authentication expired on the CRM connection.",
  },
  { workflowId: "wf_customer_intake", minutesAgo: 360 },
  { workflowId: "wf_support_triage", minutesAgo: 300 },
];

const SEED_WORKSPACE = "ws_default";

function definitionHash(definition: Workflow): string {
  /* Same normalisation `upsertWorkflowVersion` applies, so a seeded
     workflow reads as "already published" the moment it is opened. */
  const normalised = stripRuntimeState(stripWebhookSecrets(definition));
  return createHash("sha256")
    .update(JSON.stringify({ nodes: normalised.nodes, edges: normalised.edges }))
    .digest("hex");
}

function seedWorkflows(timestamp: number): void {
  for (const workflow of DEMO_WORKFLOWS) {
    const existing = queryOne<{ id: string }>(
      "SELECT id FROM workflows WHERE id = ?",
      workflow.id,
    );
    if (existing) continue;
    const versionId = `wfv_seed_${workflow.id}`;
    run(
      `INSERT INTO workflows
        (id, workspace_id, name, description, status, trigger_type, node_count, latest_version,
         draft, draft_revision, published_version_id, published_version,
         created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, 1, NULL, NULL, ?, ?)`,
      workflow.id,
      SEED_WORKSPACE,
      workflow.name,
      workflow.description ?? "",
      workflow.status,
      workflow.triggerType,
      workflow.nodes.length,
      toJson(workflow) ?? "{}",
      versionId,
      timestamp,
      timestamp,
    );
    run(
      `INSERT INTO workflow_versions (id, workflow_id, workspace_id, version, hash, definition, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
      versionId,
      workflow.id,
      SEED_WORKSPACE,
      definitionHash(workflow),
      toJson(workflow) ?? "{}",
      timestamp,
    );
    seedTriggerRow(workflow, timestamp);
  }
}

const SEED_TRIGGER_TYPES: Record<string, string> = {
  "trigger.manual": "manual",
  "trigger.webhook": "webhook",
  "trigger.schedule": "schedule",
};

/**
 * Give a seeded workflow a trigger row.
 *
 * Written here rather than through the trigger service so the seed
 * stays a plain list of INSERTs with no dependency on the layer that
 * gates them — and so a fresh install is arming-ready from the first
 * render, without waiting for someone to open a trigger card.
 */
function seedTriggerRow(workflow: Workflow, timestamp: number): void {
  const type =
    SEED_TRIGGER_TYPES[workflow.triggerType] ??
    SEED_TRIGGER_TYPES[
      workflow.nodes.find((node) => SEED_TRIGGER_TYPES[node.type])?.type ?? ""
    ];
  if (!type) return;

  const node = workflow.nodes.find((candidate) => SEED_TRIGGER_TYPES[candidate.type]);
  const raw = node?.data?.config;
  const config =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  delete config.secret;

  const cron = type === "schedule" ? cronFromConfig(config) : null;
  const timezone = type === "schedule" ? timezoneFromConfig(config) : null;

  run(
    `INSERT OR IGNORE INTO workflow_triggers
       (id, workflow_id, workspace_id, type, enabled, config, schedule_cron,
        schedule_timezone, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?)`,
    `trg_${workflow.id.replace(/^wf_/, "")}`,
    workflow.id,
    SEED_WORKSPACE,
    type,
    toJson(config) ?? "{}",
    cron,
    timezone,
    timestamp,
    timestamp,
  );
}

function seedRuns(timestamp: number): void {
  let index = 0;
  for (const seed of SEED_RUNS) {
    const workflow = getWorkflow(seed.workflowId);
    if (!workflow) continue;

    const plan = buildExecutionPlan(workflow, { failAt: seed.failAt });
    const triggerDefinition = getDefinition(workflow.triggerType);
    const startedAt = timestamp - seed.minutesAgo * 60_000;
    const executionId = `8F${(0x2a91 - index * 0x1b)
      .toString(16)
      .toUpperCase()
      .padStart(4, "0")}`;
    index += 1;

    const failedStep = plan.steps.find((step) => step.status === "failed");
    const lastCompleted = [...plan.steps]
      .reverse()
      .find((step) => step.status === "completed");
    const stepCount = plan.steps.length;
    const failedStepCount = plan.steps.filter(
      (step) => step.status === "failed",
    ).length;

    run(
      `INSERT INTO executions
        (id, workspace_id, workflow_id, workflow_name, workflow_version_id, workflow_version,
         status, trigger_type, trigger_label, source, started_at, completed_at, duration_ms,
         input, output, error, note, metadata, step_count, failed_step_count, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'seed', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      executionId,
      SEED_WORKSPACE,
      workflow.id,
      workflow.name,
      `wfv_seed_${workflow.id}`,
      plan.status,
      workflow.triggerType,
      triggerDefinition?.title ?? "Trigger",
      startedAt,
      startedAt + plan.durationMs,
      plan.durationMs,
      toJson(lastCompleted?.output ?? null),
      toJson(failedStep?.error ?? null),
      seed.note ?? null,
      toJson({ seed: true, fabricated: true, generator: "klyz-dev-seed" }),
      stepCount,
      failedStepCount,
      timestamp,
    );

    plan.steps.forEach((step, stepIndex) => {
      const stepStart = startedAt + step.startedAtMs;
      run(
        `INSERT INTO execution_steps
          (id, execution_id, seq, node_id, node_type, node_label, ref, status,
           attempt, started_at, completed_at, duration_ms, input, output, error, branch, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        `st_seed_${executionId}_${stepIndex}`,
        executionId,
        stepIndex + 1,
        step.nodeId,
        step.nodeType,
        step.nodeLabel,
        step.ref,
        step.status,
        step.status === "skipped" ? null : stepStart,
        stepStart + step.durationMs,
        step.durationMs,
        toJson(step.input),
        toJson(step.output),
        toJson(step.error ?? undefined),
        toJson({ seed: true }),
      );
    });
  }
}

export function ensureSeed(): void {
  const marker = queryOne<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = 'seeded'",
  );
  if (marker) return;

  const timestamp = now();
  seedWorkflows(timestamp);
  seedRuns(timestamp);
  run(
    "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seeded', ?)",
    new Date(timestamp).toISOString(),
  );
}
