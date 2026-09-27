/**
 * Environment configuration for the execution infrastructure.
 *
 * Every tunable that belongs to deployment (queue driver, Redis URL,
 * concurrency, timeouts, credential key, HTTP egress policy) is read
 * here — once, validated, with documented defaults. Nothing else in the
 * codebase touches `process.env` for these knobs.
 *
 * Rules:
 *  - Development has safe local defaults (single-command `npm run dev`).
 *  - Production never falls back silently: a missing required value is
 *    an error the process fails on, not a quietly insecure default.
 */

export type QueueDriver = "redis" | "memory";

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function envNodeEnv(): "development" | "test" | "production" {
  const raw = (process.env.NODE_ENV ?? "development").toLowerCase();
  if (raw === "production" || raw === "test") return raw;
  return "development";
}

function intFrom(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigError([`${label} must be an integer, got "${raw}"`]);
  }
  if (value < min || value > max) {
    throw new ConfigError([`${label} must be between ${min} and ${max}, got ${value}`]);
  }
  return value;
}

/**
 * Load `.env` for non-Next processes (the worker). Next loads it itself.
 * A missing file is fine — environment variables may come from the shell.
 */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile?.(joinCwd(".env"));
  } catch {
    /* no .env file — shell/CI environment is the source of truth */
  }
}

function joinCwd(file: string): string {
  return `${process.cwd().replace(/\/$/, "")}/${file}`;
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

export function nodeEnv(): "development" | "test" | "production" {
  return envNodeEnv();
}

/**
 * Which queue transport runs executions.
 *  - `redis`   → BullMQ over Redis (the production path)
 *  - `memory`  → in-process queue used by the unit-test suite
 *
 * Default: `memory` under NODE_ENV=test so the standard test run needs
 * no Docker; `redis` everywhere else.
 */
export function queueDriver(): QueueDriver {
  const raw = (process.env.KLYZ_QUEUE_DRIVER ?? "").trim().toLowerCase();
  const effective = raw || (envNodeEnv() === "test" ? "memory" : "redis");
  if (effective !== "redis" && effective !== "memory") {
    throw new ConfigError([
      `KLYZ_QUEUE_DRIVER must be "redis" or "memory", got "${effective}"`,
    ]);
  }
  return effective;
}

/** Redis connection URL. Required (no silent default) in production. */
export function redisUrl(): string {
  const raw =
    process.env.KLYZ_REDIS_URL?.trim() ||
    process.env.REDIS_URL?.trim() ||
    "";
  if (raw) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ConfigError([`KLYZ_REDIS_URL is not a valid URL: "${raw}"`]);
    }
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new ConfigError([
        `KLYZ_REDIS_URL must use redis:// or rediss://, got "${parsed.protocol}"`,
      ]);
    }
    return raw;
  }
  if (envNodeEnv() === "production") {
    throw new ConfigError([
      "KLYZ_REDIS_URL is required in production — refusing to fall back to a default Redis address",
    ]);
  }
  return "redis://127.0.0.1:6379";
}

/** BullMQ queue name. One queue per deployment, configurable for isolation. */
export function queueName(): string {
  const raw = process.env.KLYZ_QUEUE_NAME?.trim();
  if (raw) return raw;
  return "workflow-executions";
}

/** Max executions processed in parallel by one worker process. */
export function workerConcurrency(): number {
  return intFrom(process.env.KLYZ_WORKER_CONCURRENCY, 4, 1, 64, "KLYZ_WORKER_CONCURRENCY");
}

/** BullMQ job attempts for *infrastructure* failures (not node retries). */
export function jobAttempts(): number {
  return intFrom(process.env.KLYZ_JOB_ATTEMPTS, 3, 1, 10, "KLYZ_JOB_ATTEMPTS");
}

/** Exponential backoff base between job attempts. */
export function jobBackoffMs(): number {
  return intFrom(process.env.KLYZ_JOB_BACKOFF_MS, 2_000, 100, 600_000, "KLYZ_JOB_BACKOFF_MS");
}

/**
 * Overall execution watchdog in ms (0 disables). Pauses while a run is
 * `waiting` (delay nodes), so a 24h delay is never killed by it.
 */
export function executionTimeoutMs(): number {
  return intFrom(
    process.env.KLYZ_EXECUTION_TIMEOUT_MS,
    15 * 60_000,
    0,
    24 * 3_600_000,
    "KLYZ_EXECUTION_TIMEOUT_MS",
  );
}

/** How often the worker re-reads `cancel_requested` for active runs. */
export function cancelPollMs(): number {
  return intFrom(process.env.KLYZ_CANCEL_POLL_MS, 1_000, 100, 60_000, "KLYZ_CANCEL_POLL_MS");
}

/** AES-256-GCM key for credential/webhook-secret encryption (hex or base64, 32 bytes). */
export function credentialKey(): Buffer | null {
  const raw = process.env.KLYZ_CREDENTIAL_KEY?.trim();
  if (!raw) return null;
  let bytes: Buffer;
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) {
    bytes = Buffer.from(raw, "hex");
  } else {
    try {
      bytes = Buffer.from(raw, "base64");
    } catch {
      throw new ConfigError(["KLYZ_CREDENTIAL_KEY is neither valid hex nor base64"]);
    }
  }
  if (bytes.length !== 32) {
    throw new ConfigError([
      `KLYZ_CREDENTIAL_KEY must decode to exactly 32 bytes, got ${bytes.length}`,
    ]);
  }
  return bytes;
}

/** Hosts (host or host:port) the HTTP node may call. `*` allows any. */
export function httpAllowHosts(): string[] {
  const raw = process.env.KLYZ_HTTP_ALLOW_HOSTS?.trim() ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Allow the HTTP node to reach private/loopback addresses (off by default). */
export function httpAllowPrivate(): boolean {
  const raw = (process.env.KLYZ_HTTP_ALLOW_PRIVATE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Max response bytes the HTTP node will buffer. */
export function httpMaxResponseBytes(): number {
  return intFrom(
    process.env.KLYZ_HTTP_MAX_RESPONSE_BYTES,
    1_048_576,
    1_024,
    16_777_216,
    "KLYZ_HTTP_MAX_RESPONSE_BYTES",
  );
}

/* ------------------------------------------------------------------ */
/* AI authoring assistant                                              */
/*                                                                     */
/* Optional by design: when no key is configured the rest of KLYZ is  */
/* unaffected and the AI builder renders a configuration state. These  */
/* are the only reads of the AI environment variables in the codebase. */
/* ------------------------------------------------------------------ */

export const DEFAULT_AI_BASE_URL = "https://openrouter.ai/api/v1";

/** OpenAI-compatible base URL (OpenRouter, OpenAI, or a local gateway). */
export function aiBaseUrl(): string {
  const raw = process.env.KLYZ_AI_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : DEFAULT_AI_BASE_URL;
}

/** Server-side only. Empty string means "not configured". */
export function aiApiKey(): string {
  return process.env.KLYZ_AI_API_KEY?.trim() ?? "";
}

/**
 * Which model client `aiProvider()` builds.
 *
 * `"mock"` is a deterministic local stand-in used by tests and local
 * development. It is refused outright in production so it can never be
 * the way a shipped deployment silently answers AI steps.
 */
export function aiProviderKind(): "openai" | "mock" {
  const raw = (process.env.KLYZ_AI_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "" || raw === "openai") return "openai";
  if (raw === "mock") {
    if (envNodeEnv() === "production") {
      throw new ConfigError([
        "KLYZ_AI_PROVIDER=mock is refused in production — the deterministic mock exists for tests and local development only. Unset it, or set KLYZ_AI_PROVIDER=openai with a real KLYZ_AI_API_KEY.",
      ]);
    }
    return "mock";
  }
  throw new ConfigError([
    `KLYZ_AI_PROVIDER must be "openai" or "mock", got "${raw}".`,
  ]);
}

export function aiEnabled(): boolean {
  if (aiProviderKind() === "mock") return true;
  return aiApiKey().length > 0;
}

export function aiModel(): string {
  const raw = process.env.KLYZ_AI_MODEL?.trim();
  return raw || "openai/gpt-4o-mini";
}

/** Hard ceiling for one model round-trip. */
export function aiTimeoutMs(): number {
  return intFrom(process.env.KLYZ_AI_TIMEOUT_MS, 45_000, 1_000, 300_000, "KLYZ_AI_TIMEOUT_MS");
}

/** Output budget for one plan/explanation. */
export function aiMaxTokens(): number {
  return intFrom(process.env.KLYZ_AI_MAX_TOKENS, 4_096, 256, 16_384, "KLYZ_AI_MAX_TOKENS");
}

/** Requests allowed per workspace per minute (in-process window). */
export function aiRateLimitPerMinute(): number {
  return intFrom(process.env.KLYZ_AI_RATE_LIMIT, 30, 1, 600, "KLYZ_AI_RATE_LIMIT");
}

/** Longest accepted intent text — bigger requests are rejected, not truncated. */
export function aiMaxIntentChars(): number {
  return intFrom(process.env.KLYZ_AI_MAX_INTENT_CHARS, 4_000, 200, 32_000, "KLYZ_AI_MAX_INTENT_CHARS");
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * Whether `/api/auth/register` accepts new accounts.
 *
 * Default: allowed, so a fresh install can create its first owner.
 * Set `KLYZ_ALLOW_REGISTRATION=false` on a deployment where accounts
 * are provisioned by an operator — existing sign-ins keep working.
 */
export function allowRegistration(): boolean {
  const raw = (process.env.KLYZ_ALLOW_REGISTRATION ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return true;
}

/** Failed sign-ins allowed per email per minute. */
export function loginRateLimit(): number {
  return intFrom(process.env.KLYZ_LOGIN_RATE_LIMIT, 10, 1, 600, "KLYZ_LOGIN_RATE_LIMIT");
}

/** Account creations allowed per IP per hour. */
export function registerRateLimit(): number {
  return intFrom(process.env.KLYZ_REGISTER_RATE_LIMIT, 10, 1, 600, "KLYZ_REGISTER_RATE_LIMIT");
}

/* ------------------------------------------------------------------ */
/* Triggers: scheduler and inbound webhook ceilings                    */
/* ------------------------------------------------------------------ */

function boolFrom(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  throw new ConfigError([`Expected a boolean, got "${raw}"`]);
}

/**
 * Whether the worker runs the schedule loop at all.
 *
 * Default on. A deployment that wants schedules to exist but not fire
 * (a read-only replica, a staging box pointed at production data) sets
 * this to false and nothing else changes — the trigger card still
 * shows the next run, it just never starts one.
 */
export function schedulerEnabled(): boolean {
  return boolFrom(process.env.KLYZ_SCHEDULER_ENABLED, true);
}

/** How often the worker looks for schedules that are due (ms). */
export function schedulerIntervalMs(): number {
  return intFrom(process.env.KLYZ_SCHEDULER_INTERVAL_MS, 15_000, 1_000, 3_600_000, "KLYZ_SCHEDULER_INTERVAL_MS");
}

/** Schedule rows examined per tick (1-500). */
export function schedulerBatch(): number {
  return intFrom(process.env.KLYZ_SCHEDULER_BATCH, 50, 1, 500, "KLYZ_SCHEDULER_BATCH");
}

/** Inbound webhook deliveries allowed per minute per client IP. */
export function webhookRateLimit(): number {
  return intFrom(process.env.KLYZ_WEBHOOK_RATE_LIMIT, 600, 1, 60_000, "KLYZ_WEBHOOK_RATE_LIMIT");
}

export interface SchedulerConfig {
  enabled: boolean;
  intervalMs: number;
  batch: number;
}

/** Validated scheduler settings, read once at worker startup. */
export function schedulerConfig(): SchedulerConfig {
  const issues: string[] = [];
  const read = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ConfigError) issues.push(...error.issues);
      else throw error;
      return fallback;
    }
  };
  const config: SchedulerConfig = {
    enabled: read(schedulerEnabled, true),
    intervalMs: read(schedulerIntervalMs, 15_000),
    batch: read(schedulerBatch, 50),
  };
  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}

/* ------------------------------------------------------------------ */
/* Whole-config validation (worker startup)                            */
/* ------------------------------------------------------------------ */

export interface WorkerConfig {
  driver: QueueDriver;
  redis: string;
  queue: string;
  concurrency: number;
  attempts: number;
  backoffMs: number;
  executionTimeoutMs: number;
  cancelPollMs: number;
}

export function workerConfig(): WorkerConfig {
  const issues: string[] = [];
  const read = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ConfigError) issues.push(...error.issues);
      else throw error;
      return fallback;
    }
  };

  const config: WorkerConfig = {
    driver: read(queueDriver, "redis"),
    redis: read(redisUrl, "redis://127.0.0.1:6379"),
    queue: read(queueName, "workflow-executions"),
    concurrency: read(workerConcurrency, 4),
    attempts: read(jobAttempts, 3),
    backoffMs: read(jobBackoffMs, 2_000),
    executionTimeoutMs: read(executionTimeoutMs, 0),
    cancelPollMs: read(cancelPollMs, 1_000),
  };

  if (issues.length > 0) throw new ConfigError(issues);
  if (envNodeEnv() === "production" && config.driver === "memory") {
    throw new ConfigError([
      "KLYZ_QUEUE_DRIVER=memory is not allowed in production — executions must run through the Redis/BullMQ worker",
    ]);
  }
  return config;
}
