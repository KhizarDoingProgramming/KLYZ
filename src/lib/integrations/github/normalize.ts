import type { GitHubIssue, GitHubLabel, GitHubUser } from "./api";

/**
 * GitHub → KLYZ normalisation.
 *
 * The raw delivery stays available under `raw` for advanced mapping and
 * debugging, but everything a workflow normally references is a flat,
 * stable shape that does not change when GitHub adds fields to its
 * payload.
 */

export interface NormalizedActor {
  id: number | null;
  login: string;
  name: string;
  email: string | null;
  url: string | null;
  avatarUrl: string | null;
}

export interface NormalizedRepository {
  id: number | null;
  name: string;
  owner: string;
  fullName: string;
  url: string;
  defaultBranch: string | null;
  private: boolean | null;
}

export interface NormalizedIssue {
  id: number | null;
  number: number | null;
  title: string;
  body: string;
  state: string;
  author: NormalizedActor;
  labels: string[];
  assignees: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  commentCount: number;
}

export interface NormalizedEvent {
  event: string;
  action: string;
  repository: NormalizedRepository;
  /** Kept flat so `{{trigger.repository}}` reads well in expressions. */
  repositoryName: string;
  repositoryId: number | null;
  issueId: number | null;
  issueNumber: number | null;
  title: string;
  body: string;
  author: NormalizedActor;
  authorName: string;
  authorEmail: string | null;
  labels: string[];
  url: string;
  createdAt: string;
  /** Commit/push details — empty strings when the event has none. */
  branch: string;
  commitMessage: string;
  commitUrl: string;
  receivedAt: string;
  /** Untouched provider payload for advanced mapping. */
  raw: Record<string, unknown>;
}

const EMPTY_ACTOR: NormalizedActor = {
  id: null,
  login: "",
  name: "",
  email: null,
  url: null,
  avatarUrl: null,
};

export function normalizeActor(user: GitHubUser | null | undefined): NormalizedActor {
  if (!user) return { ...EMPTY_ACTOR };
  const login = user.login ?? "";
  return {
    id: user.id ?? null,
    login,
    name: login,
    /* GitHub only exposes an email on some payloads; a workflow that
       needs it should reply via Gmail using the sender it already has. */
    email: null,
    url: user.html_url ?? null,
    avatarUrl: user.avatar_url ?? null,
  };
}

export function normalizeRepository(
  repo: Record<string, unknown> | null | undefined,
): NormalizedRepository {
  if (!repo) {
    return {
      id: null,
      name: "",
      owner: "",
      fullName: "",
      url: "",
      defaultBranch: null,
      private: null,
    };
  }
  const owner = (repo.owner as { login?: string } | undefined)?.login ?? "";
  const name = String(repo.name ?? "");
  const id = typeof repo.id === "number" ? repo.id : null;
  return {
    id,
    name,
    owner,
    fullName: owner && name ? `${owner}/${name}` : name,
    url: String(repo.html_url ?? (owner && name ? `https://github.com/${owner}/${name}` : "")),
    defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : null,
    private: typeof repo.private === "boolean" ? repo.private : null,
  };
}

export function labelName(label: string | GitHubLabel): string {
  return typeof label === "string" ? label : (label.name ?? "");
}

export function normalizeIssue(issue: GitHubIssue | null | undefined): NormalizedIssue {
  if (!issue) {
    return {
      id: null,
      number: null,
      title: "",
      body: "",
      state: "",
      author: { ...EMPTY_ACTOR },
      labels: [],
      assignees: [],
      url: "",
      createdAt: "",
      updatedAt: "",
      closedAt: null,
      commentCount: 0,
    };
  }
  return {
    id: issue.id ?? null,
    number: issue.number ?? null,
    title: issue.title ?? "",
    body: issue.body ?? "",
    state: issue.state ?? "",
    author: normalizeActor(issue.user),
    labels: (issue.labels ?? []).map(labelName).filter(Boolean),
    assignees: (issue.assignees ?? [])
      .map((assignee) => assignee.login ?? "")
      .filter(Boolean),
    url: issue.html_url ?? "",
    createdAt: issue.created_at ?? "",
    updatedAt: issue.updated_at ?? "",
    closedAt: issue.closed_at ?? null,
    commentCount: typeof issue.comments === "number" ? issue.comments : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Turn a GitHub webhook payload into the workflow's trigger output.
 *
 * Supports `issues`, `pull_request`, `push` and `release` deliveries —
 * the events the trigger node can subscribe to. Unknown events still
 * produce a usable (mostly empty) shape instead of throwing, so a hook
 * with a wider subscription degrades rather than breaks.
 */
export function normalizeGitHubEvent(
  hookEvent: string,
  payload: unknown,
  receivedAt = new Date().toISOString(),
): NormalizedEvent {
  const body = isRecord(payload) ? payload : {};
  const repository = normalizeRepository(body.repository as Record<string, unknown>);

  const base: NormalizedEvent = {
    event: hookEvent,
    action: String(body.action ?? ""),
    repository,
    repositoryName: repository.fullName,
    repositoryId: repository.id,
    issueId: null,
    issueNumber: null,
    title: "",
    body: "",
    author: { ...EMPTY_ACTOR },
    authorName: "",
    authorEmail: null,
    labels: [],
    url: repository.url,
    createdAt: "",
    branch: "",
    commitMessage: "",
    commitUrl: "",
    receivedAt,
    raw: body,
  };

  if (hookEvent === "issues" || hookEvent === "pull_request") {
    const issue = normalizeIssue(body.issue as GitHubIssue | undefined);
    const pull = body.pull_request as GitHubIssue | undefined;
    return {
      ...base,
      issueId: issue.id,
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
      author: issue.author,
      authorName: issue.author.login,
      labels: issue.labels,
      url: issue.url || repository.url,
      createdAt: issue.createdAt,
      /* pull_request payloads keep their own html_url on `pull_request`. */
      ...(pull ? { url: pull.html_url ?? issue.url, createdAt: pull.created_at ?? issue.createdAt } : {}),
    };
  }

  if (hookEvent === "push") {
    const ref = String(body.ref ?? "");
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    const commits = Array.isArray(body.commits) ? body.commits : [];
    const head = body.head_commit;
    const commit =
      isRecord(head) && typeof head.id === "string"
        ? head
        : isRecord(commits[commits.length - 1])
          ? (commits[commits.length - 1] as Record<string, unknown>)
          : null;
    const sender = normalizeActor(body.sender as GitHubUser | undefined);
    return {
      ...base,
      action: "pushed",
      branch,
      title: commit ? String(commit.message ?? "").split("\n")[0] ?? "" : "",
      body: commit ? String(commit.message ?? "") : "",
      url: commit?.url ? String(commit.url) : repository.url,
      commitMessage: commit ? String(commit.message ?? "") : "",
      commitUrl: commit?.url ? String(commit.url) : "",
      createdAt: commit?.timestamp ? String(commit.timestamp) : receivedAt,
      author: sender,
      authorName: sender.login,
    };
  }

  if (hookEvent === "release") {
    const release = body.release as Record<string, unknown> | undefined;
    const sender = normalizeActor(body.sender as GitHubUser | undefined);
    return {
      ...base,
      title: String(release?.name ?? release?.tag_name ?? ""),
      body: String(release?.body ?? ""),
      url: String(release?.html_url ?? repository.url),
      createdAt: String(release?.published_at ?? receivedAt),
      author: sender,
      authorName: sender.login,
    };
  }

  const sender = normalizeActor(body.sender as GitHubUser | undefined);
  return { ...base, author: sender, authorName: sender.login };
}

/** Output object exposed to later nodes (matches the declared outputs). */
export function eventOutputs(event: NormalizedEvent): Record<string, unknown> {
  return {
    event: event.event,
    action: event.action,
    repository: event.repositoryName,
    repositoryId: event.repositoryId,
    issueId: event.issueId,
    issueNumber: event.issueNumber,
    title: event.title,
    body: event.body,
    author: event.authorName,
    authorEmail: event.authorEmail,
    labels: event.labels,
    url: event.url,
    createdAt: event.createdAt,
    branch: event.branch,
    commitMessage: event.commitMessage,
    commitUrl: event.commitUrl,
    receivedAt: event.receivedAt,
    raw: event.raw,
  };
}
