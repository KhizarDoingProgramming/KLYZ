/**
 * Structured explanations.
 *
 * Two shapes, both produced by the model and both parsed strictly:
 *
 *  - `WorkflowExplanation` — what a workflow does (or what one node
 *    does, when the request was node-scoped).
 *  - `FailureExplanation` — why an execution failed, split into facts
 *    observed in the data, causes (flagged whether the data actually
 *    supports them) and suggested next steps. The split matters: the
 *    model may hypothesise, but it may not present a guess as evidence.
 *
 * These are display data only. Nothing here is ever executed or
 * persisted as workflow state.
 */

export interface ExplanationSection {
  title: string;
  items: string[];
}

export interface WorkflowExplanation {
  summary: string;
  sections: ExplanationSection[];
}

export interface FailureCause {
  text: string;
  /** True only when the execution data actually shows it. */
  supported: boolean;
}

export interface FailureExplanation {
  summary: string;
  observed: string[];
  causes: FailureCause[];
  nextSteps: string[];
}

const LIMITS = {
  summary: 800,
  sections: 8,
  items: 8,
  text: 500,
} as const;

export class ExplanationParseError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`The model returned an unusable explanation: ${issues.join(" · ")}`);
    this.name = "ExplanationParseError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function text(
  value: unknown,
  label: string,
  max: number,
  issues: string[],
  fallback = "",
): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") {
    issues.push(`${label} must be a string`);
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return clip(trimmed, max);
}

function textList(
  value: unknown,
  label: string,
  cap: number,
  issues: string[],
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  for (const [index, item] of value.slice(0, cap).entries()) {
    const entry = text(item, `${label}[${index}]`, LIMITS.text, issues);
    if (entry) out.push(entry);
  }
  if (value.length > cap) issues.push(`${label} has more than ${cap} entries`);
  return out;
}

export function parseWorkflowExplanation(raw: unknown): WorkflowExplanation {
  const issues: string[] = [];
  if (!isRecord(raw)) throw new ExplanationParseError(["the response must be a JSON object"]);

  const summary = text(raw.summary, "summary", LIMITS.summary, issues);
  if (!summary) issues.push("summary is required");

  const sections: ExplanationSection[] = [];
  if (!Array.isArray(raw.sections)) issues.push("sections must be an array");
  else {
    for (const [index, item] of raw.sections.slice(0, LIMITS.sections).entries()) {
      if (!isRecord(item)) {
        issues.push(`sections[${index}] must be an object`);
        continue;
      }
      const title = text(item.title, `sections[${index}].title`, 120, issues);
      const items = textList(item.items, `sections[${index}].items`, LIMITS.items, issues);
      if (!title) issues.push(`sections[${index}].title is required`);
      if (items.length === 0) issues.push(`sections[${index}].items must not be empty`);
      if (title && items.length > 0) sections.push({ title, items });
    }
    if (raw.sections.length > LIMITS.sections) {
      issues.push(`sections exceeds the ${LIMITS.sections}-section limit`);
    }
  }

  if (issues.length > 0) throw new ExplanationParseError(issues);
  return { summary, sections };
}

export function parseFailureExplanation(raw: unknown): FailureExplanation {
  const issues: string[] = [];
  if (!isRecord(raw)) throw new ExplanationParseError(["the response must be a JSON object"]);

  const summary = text(raw.summary, "summary", LIMITS.summary, issues);
  if (!summary) issues.push("summary is required");

  const observed = textList(raw.observed, "observed", LIMITS.items * 2, issues);
  if (observed.length === 0) issues.push("observed must list at least one fact from the data");

  const causes: FailureCause[] = [];
  if (!Array.isArray(raw.causes)) issues.push("causes must be an array");
  else {
    for (const [index, item] of raw.causes.slice(0, LIMITS.items).entries()) {
      if (!isRecord(item)) {
        issues.push(`causes[${index}] must be an object`);
        continue;
      }
      const causeText = text(item.text, `causes[${index}].text`, LIMITS.text, issues);
      if (!causeText) issues.push(`causes[${index}].text is required`);
      if (typeof item.supported !== "boolean") {
        issues.push(`causes[${index}].supported must be true or false`);
        continue;
      }
      if (causeText) causes.push({ text: causeText, supported: item.supported });
    }
  }

  const nextSteps = textList(raw.nextSteps, "nextSteps", LIMITS.items, issues);

  if (issues.length > 0) throw new ExplanationParseError(issues);
  return { summary, observed, causes, nextSteps };
}
