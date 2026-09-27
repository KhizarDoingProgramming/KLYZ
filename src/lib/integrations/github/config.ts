/**
 * GitHub-specific constants and light validation.
 *
 * Everything a node can hand to the API is validated here first: a
 * repository name, an event name and an issue number are the only free
 * strings that reach a GitHub path, and all three are constrained to
 * their documented character sets before they are interpolated.
 */
import { GITHUB_ERRORS, REMEDIATION, integrationError } from "../errors";

export interface RepositoryRef {
  owner: string;
  name: string;
  fullName: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function configError(message: string, hint: string): never {
  throw integrationError(GITHUB_ERRORS.repositoryInvalid, message, {
    hint,
    remediation: REMEDIATION.inspect,
  });
}

export function parseRepository(raw: unknown): RepositoryRef {
  const value = typeof raw === "string" ? raw.trim() : "";
  const [owner, name, ...rest] = value.split("/");
  if (!owner || !name || rest.length > 0 || !OWNER_RE.test(owner) || !NAME_RE.test(name)) {
    configError(
      `"${value || "…"}" is not a repository — use the owner/name form, e.g. klyz/platform.`,
      "Repositories are written owner/name with no spaces.",
    );
  }
  return { owner, name, fullName: `${owner}/${name}` };
}

/** Issue / pull-request numbers are positive integers. */
export function parseIssueNumber(raw: unknown): number {
  const value =
    typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw integrationError(
      GITHUB_ERRORS.issueNumberInvalid,
      `"${String(raw ?? "")}" is not an issue number — pass a number such as 1042.`,
      {
        hint: "Use {{trigger.issueNumber}} if the number comes from an earlier step.",
        remediation: REMEDIATION.inspect,
      },
    );
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export interface GitHubEventSpec {
  /** `event` field value stored in the node config. */
  value: string;
  label: string;
  /** `X-GitHub-Event` header value a webhook must subscribe to. */
  hookEvent: string;
  /** Sub-action filter (`issues.opened` → action `opened`). */
  action?: string;
  description: string;
}

export const GITHUB_EVENTS: GitHubEventSpec[] = [
  {
    value: "issues.opened",
    label: "Issue created",
    hookEvent: "issues",
    action: "opened",
    description: "Fires when a new issue is opened in the repository.",
  },
  {
    value: "issues.edited",
    label: "Issue edited",
    hookEvent: "issues",
    action: "edited",
    description: "Fires when an issue's title or body changes.",
  },
  {
    value: "issues.closed",
    label: "Issue closed",
    hookEvent: "issues",
    action: "closed",
    description: "Fires when an issue is closed.",
  },
  {
    value: "issues.reopened",
    label: "Issue reopened",
    hookEvent: "issues",
    action: "reopened",
    description: "Fires when a closed issue is reopened.",
  },
  {
    value: "pull_request.opened",
    label: "Pull request opened",
    hookEvent: "pull_request",
    action: "opened",
    description: "Fires when a pull request is opened.",
  },
  {
    value: "pull_request.closed",
    label: "Pull request merged/closed",
    hookEvent: "pull_request",
    action: "closed",
    description: "Fires when a pull request is closed or merged.",
  },
  {
    value: "push",
    label: "Push",
    hookEvent: "push",
    description: "Fires on every push to the repository.",
  },
  {
    value: "release.published",
    label: "Release published",
    hookEvent: "release",
    action: "published",
    description: "Fires when a release is published.",
  },
];

export function findEvent(value: string): GitHubEventSpec | undefined {
  return GITHUB_EVENTS.find((event) => event.value === value);
}

/** The distinct `X-GitHub-Event` values a config subscribes to. */
export function hookEventsFor(eventValue: string): string[] {
  const spec = findEvent(eventValue);
  return spec ? [spec.hookEvent] : [];
}

/** Maps a delivery's `X-GitHub-Event` + `action` onto the config value. */
export function matchesEvent(configured: string, hookEvent: string, action?: string): boolean {
  const spec = findEvent(configured);
  if (!spec) return false;
  if (spec.hookEvent !== hookEvent) return false;
  return spec.action === undefined || spec.action === action;
}

/* ------------------------------------------------------------------ */
/* Labels / assignees                                                  */
/* ------------------------------------------------------------------ */

/** Comma-separated label text → a validated list (max 100 chars each). */
export function parseLabels(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(isValidLabel);
  }
  return String(raw ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(isValidLabel);
}

function isValidLabel(label: string): boolean {
  return label.length > 0 && label.length <= 100;
}

/** Login (no leading `@`). */
export function parseLogin(raw: unknown): string | null {
  const value = String(raw ?? "").trim().replace(/^@/, "");
  if (!value) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value)) return null;
  return value;
}
