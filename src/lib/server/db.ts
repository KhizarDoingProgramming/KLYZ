import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * SQLite persistence for executions.
 *
 * `node:sqlite` is built into Node 22 — no native module, no external
 * service. The database is the durable truth for executions, steps and
 * the event log; SSE and the editor are views over it.
 */

export const SCHEMA_VERSION = 7;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    node_count INTEGER NOT NULL DEFAULT 0,
    latest_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflow_versions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    hash TEXT NOT NULL,
    definition TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (workflow_id, version)
  );

  CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    workflow_version_id TEXT NOT NULL,
    workflow_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    trigger_label TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    input TEXT,
    output TEXT,
    error TEXT,
    note TEXT,
    metadata TEXT,
    step_count INTEGER NOT NULL DEFAULT 0,
    failed_step_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS execution_steps (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    node_label TEXT NOT NULL,
    ref TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    started_at INTEGER,
    completed_at INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    input TEXT,
    output TEXT,
    error TEXT,
    branch TEXT,
    metadata TEXT
  );

  CREATE TABLE IF NOT EXISTS execution_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL,
    type TEXT NOT NULL,
    at INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_executions_ws
    ON executions (workspace_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_executions_workflow
    ON executions (workflow_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_steps_execution
    ON execution_steps (execution_id, seq);
  CREATE INDEX IF NOT EXISTS idx_events_execution
    ON execution_events (execution_id, seq);
  `,
  },
  {
    version: 2,
    sql: `
  ALTER TABLE executions ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    path TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'POST',
    auth TEXT NOT NULL DEFAULT 'none',
    secret_enc TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    sample TEXT,
    delivery_count INTEGER NOT NULL DEFAULT 0,
    last_delivery_at INTEGER,
    last_delivery_status TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_webhooks_slug ON webhooks (slug);
  CREATE INDEX IF NOT EXISTS idx_webhooks_workflow ON webhooks (workflow_id);

  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_credentials_ws ON credentials (workspace_id, kind);
  `,
  },
  {
    version: 3,
    sql: `
  ALTER TABLE credentials ADD COLUMN status TEXT NOT NULL DEFAULT 'connected';
  ALTER TABLE credentials ADD COLUMN account TEXT;
  ALTER TABLE credentials ADD COLUMN scopes TEXT;
  ALTER TABLE credentials ADD COLUMN expires_at INTEGER;
  ALTER TABLE credentials ADD COLUMN last_error TEXT;

  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    code_verifier TEXT,
    redirect_path TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states (expires_at);

  CREATE TABLE IF NOT EXISTS provider_webhooks (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_version_id TEXT,
    credential_id TEXT,
    target TEXT NOT NULL,
    events TEXT NOT NULL,
    url_key TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'managed',
    status TEXT NOT NULL DEFAULT 'pending',
    remote_hook_id TEXT,
    last_error TEXT,
    delivery_count INTEGER NOT NULL DEFAULT 0,
    last_delivery_at INTEGER,
    last_delivery_status TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_webhooks_key
    ON provider_webhooks (url_key);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_webhooks_workflow
    ON provider_webhooks (provider, workflow_id);

  CREATE TABLE IF NOT EXISTS provider_deliveries (
    provider TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    execution_id TEXT,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (provider, workflow_id, delivery_id)
  );

  CREATE TABLE IF NOT EXISTS provider_watches (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    topic TEXT,
    history_id TEXT,
    cursor TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    last_error TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_watches_credential
    ON provider_watches (provider, credential_id);
  `,
  },
  {
    /*
     * Identity, sessions, audit — the multi-tenant security model.
     *
     * Everything here is additive: new tables plus the indexes the
     * authorization queries run on. No column of an existing table is
     * rewritten, so existing rows survive untouched.
     */
    version: 4,
    sql: `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT,
    system INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    active_workspace_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    actor_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    metadata TEXT,
    ip TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_workspace
    ON audit_events (workspace_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_actor
    ON audit_events (actor_id, created_at DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces (slug);
  CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members (user_id);
  CREATE INDEX IF NOT EXISTS idx_workflows_workspace
    ON workflows (workspace_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_workflow_versions_workspace
    ON workflow_versions (workspace_id);
  CREATE INDEX IF NOT EXISTS idx_webhooks_workspace ON webhooks (workspace_id);
  CREATE INDEX IF NOT EXISTS idx_provider_webhooks_workspace
    ON provider_webhooks (workspace_id);
  `,
  },
  {
    /*
     * Server-owned workflows: a draft the server edits, published
     * versions it alone mints, and a pointer to the version every
     * execution runs.
     *
     * Additive only. Existing rows are backfilled from the version they
     * were already executing, so no definition is lost and no execution
     * changes meaning.
     */
    version: 5,
    sql: `
  ALTER TABLE workflows ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE workflows ADD COLUMN draft TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE workflows ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE workflows ADD COLUMN published_version_id TEXT;
  ALTER TABLE workflows ADD COLUMN published_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE workflows ADD COLUMN created_by TEXT;
  ALTER TABLE workflows ADD COLUMN updated_by TEXT;
  ALTER TABLE workflows ADD COLUMN archived_at INTEGER;

  ALTER TABLE workflow_versions ADD COLUMN created_by TEXT;

  CREATE INDEX IF NOT EXISTS idx_workflows_active
    ON workflows (workspace_id, archived_at, updated_at DESC);

  /* Backfill: whatever a workflow was running becomes the published
     version, and its definition becomes the editable draft. */
  UPDATE workflows
     SET published_version = latest_version
   WHERE latest_version > 0 AND published_version = 0;

  UPDATE workflows
     SET published_version_id = (
           SELECT v.id FROM workflow_versions v
            WHERE v.workflow_id = workflows.id
              AND v.version = workflows.published_version
            LIMIT 1
         )
   WHERE published_version_id IS NULL AND published_version > 0;

  UPDATE workflows
     SET draft = (
           SELECT v.definition FROM workflow_versions v
            WHERE v.workflow_id = workflows.id
              AND v.version = workflows.published_version
            LIMIT 1
         )
   WHERE draft = '{}' AND published_version > 0;
  `,
  },
  {
    /*
     * Triggers.
     *
     * One row per workflow that KLYZ itself can fire (manual, webhook,
     * schedule) plus an append-only log of the occurrences that were
     * claimed. `trigger_fires.primary key (trigger_id, occurrence_key)`
     * is the idempotency barrier: two scheduler processes racing on the
     * same tick produce one row, and only the process that inserted it
     * creates an execution.
     *
     * Additive only — no existing table is altered, so users,
     * workspaces, sessions, credentials, drafts, versions, executions
     * and audit history all survive untouched.
     */
    version: 6,
    sql: `
  CREATE TABLE IF NOT EXISTS workflow_triggers (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}',
    schedule_cron TEXT,
    schedule_timezone TEXT,
    next_run_at INTEGER,
    last_fire_at INTEGER,
    last_execution_id TEXT,
    last_status TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_triggers_workflow
    ON workflow_triggers (workflow_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_triggers_due
    ON workflow_triggers (type, enabled, next_run_at);

  CREATE TABLE IF NOT EXISTS trigger_fires (
    trigger_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    occurrence_key TEXT NOT NULL,
    fired_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'claimed',
    execution_id TEXT,
    error TEXT,
    PRIMARY KEY (trigger_id, occurrence_key)
  );

  CREATE INDEX IF NOT EXISTS idx_trigger_fires_workflow
    ON trigger_fires (workflow_id, fired_at DESC);
  CREATE INDEX IF NOT EXISTS idx_trigger_fires_execution
    ON trigger_fires (execution_id);
  `,
  },
  {
    /**
     * Templates — a workspace-scoped library of workflow blueprints.
     *
     * `definition` holds the *portable* document, not the database row:
     * a template and an exported file are the same artifact, so there is
     * exactly one schema to validate, migrate and version. System
     * templates carry `workspace_id = '*'`, a reserved marker no
     * workspace can hold (`ws_` prefixed), which keeps the built-ins
     * readable everywhere without duplicating them per tenant.
     *
     * Additive only.
     */
    version: 7,
    sql: `
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    icon TEXT NOT NULL DEFAULT 'workflow',
    definition TEXT NOT NULL,
    node_count INTEGER NOT NULL DEFAULT 0,
    trigger_type TEXT NOT NULL DEFAULT '',
    integrations TEXT NOT NULL DEFAULT '[]',
    required_credentials TEXT NOT NULL DEFAULT '[]',
    system INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_templates_workspace
    ON templates (workspace_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_templates_category
    ON templates (workspace_id, category);
  `,
  },
];

interface DbHandle {
  db: DatabaseSync;
  statements: Map<string, StatementSync>;
}

function resolveDbPath(): string {
  const fromEnv = process.env.KLYZ_DB_PATH;
  if (fromEnv) return fromEnv;
  return join(process.cwd(), ".klyz", "klyz.db");
}

/* ------------------------------------------------------------------ */
/* Trigger backfill                                                    */
/* ------------------------------------------------------------------ */

const SUPPORTED_TRIGGERS: Record<string, string> = {
  "trigger.manual": "manual",
  "trigger.webhook": "webhook",
  "trigger.schedule": "schedule",
};

interface BackfillWorkflow {
  id: string;
  workspace_id: string;
  trigger_type: string;
  draft: string;
}

interface BackfillNode {
  type?: string;
  data?: { config?: unknown };
}

/**
 * Give pre-existing workflows a trigger row.
 *
 * Deliberately dumb JSON reading rather than a domain import: this runs
 * inside the database handle, before anything else in the process has
 * booted, and the only thing it needs is the trigger node's own
 * configuration. Workflows whose trigger is a provider hook
 * (GitHub/Gmail/Slack) are skipped — those keep the endpoint card they
 * already had and are not part of the manual/webhook/schedule set.
 */
function backfillTriggers(db: DatabaseSync): void {
  const at = Date.now();
  const rows = db
    .prepare(
      `SELECT w.id, w.workspace_id, w.trigger_type, w.draft
         FROM workflows w
         LEFT JOIN workflow_triggers t ON t.workflow_id = w.id
        WHERE t.id IS NULL`,
    )
    .all() as unknown as BackfillWorkflow[];
  if (rows.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO workflow_triggers
       (id, workflow_id, workspace_id, type, enabled, config, schedule_cron,
        schedule_timezone, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const webhookEnabled = db.prepare(
    "SELECT enabled FROM webhooks WHERE workflow_id = ? LIMIT 1",
  );

  for (const row of rows) {
    let triggerNode: BackfillNode | undefined;
    let config: Record<string, unknown> = {};
    try {
      const draft = JSON.parse(row.draft || "{}") as { nodes?: BackfillNode[] };
      triggerNode = draft.nodes?.find((node) => {
        const declared = node?.type;
        return typeof declared === "string" && !!SUPPORTED_TRIGGERS[declared];
      });
      const raw = triggerNode?.data?.config;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        config = { ...(raw as Record<string, unknown>) };
        /* Endpoint secrets live encrypted in `webhooks`; never copy one
           into a plain-text config column. */
        delete config.secret;
      }
    } catch {
      config = {};
    }

    const type = SUPPORTED_TRIGGERS[triggerNode?.type ?? row.trigger_type] ?? null;
    if (!type) continue;

    let enabled = 1;
    if (type === "webhook") {
      const hook = webhookEnabled.get(row.id) as { enabled?: number } | undefined;
      enabled = hook?.enabled === 1 ? 1 : 0;
    }

    let cron: string | null = null;
    let timezone: string | null = null;
    if (type === "schedule") {
      const every = typeof config.every === "string" ? config.every.trim() : "";
      const presets: Record<string, string> = {
        "5m": "*/5 * * * *",
        "15m": "*/15 * * * *",
        "1h": "0 * * * *",
        "1d": "0 0 * * *",
      };
      cron = every && every !== "cron" ? (presets[every] ?? every) : String(config.cron ?? "").trim();
      if (!cron) cron = null;
      timezone = String(config.timezone ?? "").trim() || null;
    }

    insert.run(
      `trg_${createHashId()}`,
      row.id,
      row.workspace_id,
      type,
      enabled,
      JSON.stringify(config),
      cron,
      timezone,
      at,
      at,
    );
  }
}

function createHashId(): string {
  return randomBytes(9).toString("base64url");
}

function open(): DbHandle {
  const path = resolveDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  /* Three processes write this file (API, worker, scheduler), so a
     second writer must wait for the first rather than failing with
     SQLITE_BUSY the instant it tries. */
  db.exec("PRAGMA busy_timeout = 5000;");

  /* Apply only the migrations newer than what this database has. */
  let current = 0;
  try {
    const row = db
      .prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
      .get() as { value?: string } | undefined;
    current = Number(row?.value ?? 0) || 0;
  } catch {
    current = 0; /* app_meta does not exist yet — brand-new database */
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec(migration.sql);
    db.prepare(
      "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', ?)",
    ).run(String(migration.version));
  }

  /* Migration 6 created the trigger tables — give every workflow that
     already exists one, so nothing that fired yesterday stops firing
     today. Runs exactly once, at the moment the tables appear. */
  if (current < 6) backfillTriggers(db);

  const statements = new Map<string, StatementSync>();
  const handle: DbHandle = { db, statements };
  db.prepare(
    "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(SCHEMA_VERSION));
  return handle;
}

function handle(): DbHandle {
  const global = globalThis as typeof globalThis & { __klyzDb?: DbHandle };
  if (!global.__klyzDb) global.__klyzDb = open();
  return global.__klyzDb;
}

export function getDb(): DatabaseSync {
  return handle().db;
}

function prepare(sql: string): StatementSync {
  const { db, statements } = handle();
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

export type SqlValue = string | number | null;

export function queryAll<T>(sql: string, ...params: SqlValue[]): T[] {
  return prepare(sql).all(...params) as T[];
}

export function queryOne<T>(sql: string, ...params: SqlValue[]): T | undefined {
  return prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: SqlValue[]): void {
  prepare(sql).run(...params);
}

/** Run a statement and report how many rows it changed (claim guards). */
export function exec(sql: string, ...params: SqlValue[]): number {
  return Number(prepare(sql).run(...params).changes);
}

export function now(): number {
  return Date.now();
}

export function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function iso(epochMs: number | null | undefined): string | null {
  return epochMs === null || epochMs === undefined
    ? null
    : new Date(epochMs).toISOString();
}
