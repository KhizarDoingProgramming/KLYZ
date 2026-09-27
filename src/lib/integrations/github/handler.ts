import type { NodeHandler, NodeRunContext } from "@/lib/engine/types";
import { GITHUB_ERRORS, REMEDIATION, integrationError } from "../errors";
import { loadConnection } from "../provider/connection";
import type { ProviderConnection } from "../provider/types";
import { githubGetPage, githubRequest, type GitHubIssue } from "./api";
import { findEvent, parseIssueNumber, parseLabels, parseLogin, parseRepository } from "./config";
import { eventOutputs, normalizeGitHubEvent, normalizeIssue } from "./normalize";

/**
 * GitHub node handlers.
 *
 * Every handler follows the same three steps: read and validate its
 * config (the engine has already interpolated expressions), load a
 * workspace-scoped connection, and translate the provider's response
 * into the flat shape the node declares in `outputs`. Failures are
 * raised as {@link ProviderError} → `EngineError` so the debugger shows
 * one contract and the attempt loop only retries what is retryable.
 */

type Config = Record<string, unknown>;

/** A delivery handed over by the provider receiver. */
interface DeliveryInput {
  provider?: string;
  hookEvent?: string;
  deliveryId?: string;
  payload?: unknown;
  receivedAt?: string;
}

function isDelivery(input: unknown): input is DeliveryInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as DeliveryInput;
  return record.provider === "github" && typeof record.hookEvent === "string";
}

function text(config: Config, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

function required(config: Config, key: string, label: string): string {
  const value = text(config, key);
  if (!value) {
    throw integrationError(
      GITHUB_ERRORS.configInvalid,
      `This GitHub step is missing ${label}.`,
      { hint: `Fill in "${label}" on the node.`, remediation: REMEDIATION.inspect },
    );
  }
  return value;
}

async function connect(
  context: NodeRunContext,
  config: Config,
): Promise<ProviderConnection> {
  const credentialId = required(config, "credential", "a connection");
  return loadConnection(context.workspaceId, credentialId, "github");
}

/* ------------------------------------------------------------------ */
/* Trigger                                                             */
/* ------------------------------------------------------------------ */

export const githubTriggerHandler: NodeHandler = async (context) => {
  const config = context.config;
  const input = context.triggerInput;

  if (isDelivery(input)) {
    const payload = input.payload && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>)
      : {};
    const normalized = normalizeGitHubEvent(
      input.hookEvent as string,
      payload,
      input.receivedAt ?? new Date().toISOString(),
    );
    return { output: eventOutputs(normalized) };
  }

  /* Hand-run: normalise the sample payload exactly as a delivery would
     be normalised, so mapping written against one works against the
     other. No network call, no invented data — whatever was typed into
     "Sample payload" is what the workflow sees. */
  const configured = findEvent(text(config, "event"));
  const hookEvent = configured?.hookEvent ?? "issues";
  const sample = parseSample(config.sample);
  const normalized = normalizeGitHubEvent(hookEvent, sample);
  return { output: eventOutputs(normalized) };
};

function parseSample(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw integrationError(
      GITHUB_ERRORS.configInvalid,
      "The sample payload is not valid JSON.",
      {
        hint: 'Paste the JSON body GitHub sends, e.g. {"action":"opened","issue":{…}}.',
        remediation: REMEDIATION.inspect,
      },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Issue                                                               */
/* ------------------------------------------------------------------ */

const emptyIssue = () => normalizeIssue(undefined);

export const githubIssueHandler: NodeHandler = async (context) => {
  const config = context.config;
  const operation = text(config, "operation") || "create";
  const connection = await connect(context, config);
  const repo = parseRepository(required(config, "repository", "a repository"));

  if (operation === "search") {
    return { output: await searchIssues(connection, repo, config) };
  }

  const base = `/repos/${repo.owner}/${repo.name}/issues`;

  if (operation === "create") {
    const body: Record<string, unknown> = {
      title: required(config, "title", "a title"),
    };
    const bodyText = text(config, "body");
    if (bodyText) body.body = bodyText;
    const labels = parseLabels(config.labels);
    if (labels.length > 0) body.labels = labels;
    const assignees = parseAssignees(config.assignees);
    if (assignees.length > 0) body.assignees = assignees;

    const created = await githubRequest<GitHubIssue>(
      connection,
      "issues.create",
      base,
      { method: "POST", body },
    );
    return { output: issueOutput("create", created) };
  }

  const number = parseIssueNumber(required(config, "number", "an issue number"));

  if (operation === "get") {
    const issue = await githubRequest<GitHubIssue>(
      connection,
      "issues.get",
      `${base}/${number}`,
    );
    return { output: issueOutput("get", issue) };
  }

  const patch: Record<string, unknown> = {};
  const title = text(config, "title");
  if (title) patch.title = title;
  const bodyText = text(config, "body");
  if (bodyText) patch.body = bodyText;
  const labels = parseLabels(config.labels);
  if (labels.length > 0) patch.labels = labels;
  const assignees = parseAssignees(config.assignees);
  if (assignees.length > 0) patch.assignees = assignees;
  const state = text(config, "state");
  if (state === "open" || state === "closed") patch.state = state;

  if (Object.keys(patch).length === 0) {
    throw integrationError(
      GITHUB_ERRORS.configInvalid,
      "This update has nothing to change.",
      {
        hint: "Set at least one field (title, body, labels, assignees or state).",
        remediation: REMEDIATION.inspect,
      },
    );
  }

  const updated = await githubRequest<GitHubIssue>(
    connection,
    "issues.update",
    `${base}/${number}`,
    { method: "PATCH", body: patch },
  );
  return { output: issueOutput("update", updated) };
};

async function searchIssues(
  connection: ProviderConnection,
  repo: ReturnType<typeof parseRepository>,
  config: Config,
): Promise<Record<string, unknown>> {
  const query = required(config, "q", "a query");
  const state = text(config, "searchState");
  const terms = [
    query,
    `repo:${repo.fullName}`,
    state === "open" || state === "closed" ? `is:${state}` : "",
    // The endpoint returns pull requests too unless we say otherwise.
    query.includes("is:pr") ? "" : "is:issue",
  ]
    .filter(Boolean)
    .join(" ");

  const limitRaw = Number(config.limit);
  const perPage = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 20, 50));

  const result = await githubGetPage<GitHubIssue>(
    connection,
    "issues.search",
    "/search/issues",
    { query: { q: terms, per_page: perPage }, maxPages: 1 },
  );

  const issues = result.items.map((issue) => normalizeIssue(issue));
  return {
    issue: issues[0] ?? emptyIssue(),
    issues,
    count: issues.length,
    operation: "search",
  };
}

function issueOutput(operation: string, issue: GitHubIssue | undefined): Record<string, unknown> {
  const normalized = normalizeIssue(issue);
  return {
    issue: normalized,
    issues: normalized.number === null && !normalized.title ? [] : [normalized],
    count: normalized.number === null && !normalized.title ? 0 : 1,
    operation,
  };
}

function parseAssignees(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => parseLogin(item)).filter((login): login is string => !!login);
  }
  return String(raw ?? "")
    .split(",")
    .map((entry) => parseLogin(entry))
    .filter((login): login is string => !!login);
}

/* ------------------------------------------------------------------ */
/* Comment                                                             */
/* ------------------------------------------------------------------ */

interface GitHubComment {
  id?: number;
  html_url?: string;
  body?: string;
  user?: { login?: string };
  created_at?: string;
}

export const githubCommentHandler: NodeHandler = async (context) => {
  const config = context.config;
  const connection = await connect(context, config);
  const repo = parseRepository(required(config, "repository", "a repository"));
  const number = parseIssueNumber(required(config, "number", "an issue number"));
  const body = required(config, "body", "a comment");

  const comment = await githubRequest<GitHubComment>(
    connection,
    "issues.comments.create",
    `/repos/${repo.owner}/${repo.name}/issues/${number}/comments`,
    { method: "POST", body: { body } },
  );

  return {
    output: {
      comment: {
        id: comment.id ?? null,
        url: comment.html_url ?? "",
        body: comment.body ?? body,
        author: comment.user?.login ?? "",
        createdAt: comment.created_at ?? new Date().toISOString(),
      },
      issueNumber: number,
    },
  };
};

export const githubHandlers: Record<string, NodeHandler> = {
  "trigger.github": githubTriggerHandler,
  "action.github_issue": githubIssueHandler,
  "action.github_comment": githubCommentHandler,
};
