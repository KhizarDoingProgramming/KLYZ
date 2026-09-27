import { CronExpressionParser } from "cron-parser";

/**
 * Schedule maths shared by the editor and the server.
 *
 * One implementation, imported by both: the next-run preview the user
 * reads in the trigger card and the occurrence the scheduler actually
 * fires come from the same function, so a schedule can never mean one
 * thing in the browser and another on the server.
 *
 * Parsing and arithmetic live in `cron-parser` (an established parser
 * with real timezone support) — KLYZ never evaluates a schedule with
 * its own string-splitting, and never with `eval`.
 */

/** Interval presets offered by the schedule node, mapped to cron. */
export const SCHEDULE_PRESETS: Record<string, string> = {
  "5m": "*/5 * * * *",
  "15m": "*/15 * * * *",
  "1h": "0 * * * *",
  "1d": "0 0 * * *",
};

export const DEFAULT_TIMEZONE = "UTC";

export type ScheduleErrorCode = "BAD_CRON" | "BAD_TIMEZONE";

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: ScheduleErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A timezone name is validated with `Intl`, not with the cron parser —
 * `cron-parser` accepts an unknown zone without complaint, which is
 * exactly how `09:00 Asia/Karachi` silently becomes `09:00 UTC`.
 */
export function validateTimezone(timezone: string): string {
  const trimmed = timezone.trim();
  if (!trimmed) {
    throw new ScheduleError("BAD_TIMEZONE", "Give the schedule a timezone, e.g. Asia/Karachi.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
  } catch {
    throw new ScheduleError("BAD_TIMEZONE", `"${trimmed}" is not a known timezone.`, {
      timezone: trimmed,
    });
  }
  return trimmed;
}

export function validateCron(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new ScheduleError("BAD_CRON", "Give the schedule a cron expression, e.g. 0 9 * * 1-5.");
  }
  try {
    CronExpressionParser.parse(trimmed, { tz: DEFAULT_TIMEZONE });
  } catch (error) {
    throw new ScheduleError(
      "BAD_CRON",
      `"${trimmed}" is not a valid cron expression.`,
      { expression: trimmed, detail: error instanceof Error ? error.message : undefined },
    );
  }
  return trimmed;
}

/** Resolve the `every` preset (if any) down to a five-field cron. */
export function cronFromConfig(config: Record<string, unknown>): string {
  const every = typeof config.every === "string" ? config.every.trim() : "";
  if (every && every !== "cron") {
    const preset = SCHEDULE_PRESETS[every];
    if (preset) return preset;
    /* An unknown preset is treated as a literal expression, so a value
       written by an older editor still has a chance of parsing. */
  }
  return typeof config.cron === "string" ? config.cron.trim() : "";
}

export function timezoneFromConfig(config: Record<string, unknown>): string {
  const value = typeof config.timezone === "string" ? config.timezone.trim() : "";
  return value || DEFAULT_TIMEZONE;
}

/** Validate a whole schedule config, returning the normalised pair. */
export function compileSchedule(config: Record<string, unknown>): {
  cron: string;
  timezone: string;
} {
  const cron = validateCron(cronFromConfig(config));
  const timezone = validateTimezone(timezoneFromConfig(config));
  return { cron, timezone };
}

/**
 * The first occurrence strictly after `afterMs`.
 *
 * Returns epoch ms, or `null` when the expression never fires again
 * (a date-bound cron such as `0 0 29 2 *` past its last leap year).
 */
export function nextOccurrence(
  cron: string,
  timezone: string,
  afterMs: number = Date.now(),
): number | null {
  validateCron(cron);
  const tz = validateTimezone(timezone);
  try {
    const iterator = CronExpressionParser.parse(cron, {
      currentDate: new Date(afterMs),
      tz,
    });
    const next = iterator.next().toDate();
    const time = next.getTime();
    return Number.isFinite(time) ? time : null;
  } catch (error) {
    throw new ScheduleError(
      "BAD_CRON",
      `"${cron}" could not be scheduled.`,
      { expression: cron, detail: error instanceof Error ? error.message : undefined },
    );
  }
}

/** Occurrences in `(fromMs, toMs]`, oldest first, capped at `max`. */
export function occurrencesBetween(
  cron: string,
  timezone: string,
  fromMs: number,
  toMs: number,
  max = 50,
): number[] {
  validateCron(cron);
  const tz = validateTimezone(timezone);
  const out: number[] = [];
  try {
    const iterator = CronExpressionParser.parse(cron, {
      currentDate: new Date(fromMs),
      endDate: new Date(toMs),
      tz,
    });
    for (;;) {
      const next = iterator.next();
      if (!next) break;
      const time = next.toDate().getTime();
      if (time > toMs) break;
      out.push(time);
      if (out.length >= max) break;
    }
  } catch (error) {
    throw new ScheduleError("BAD_CRON", `"${cron}" could not be scheduled.`, {
      expression: cron,
      detail: error instanceof Error ? error.message : undefined,
    });
  }
  return out;
}

/** Deterministic identity of one occurrence — the idempotency key. */
export function occurrenceKey(scheduledAtMs: number): string {
  return new Date(scheduledAtMs).toISOString();
}
