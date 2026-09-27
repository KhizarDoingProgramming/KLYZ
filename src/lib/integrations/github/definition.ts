import type { NodeDefinition, OutputField } from "@/lib/workflow/types";
import { GITHUB_EVENTS } from "./config";

const str = (key: string, label: string) => ({ key, label, type: "string" as const });
const num = (key: string, label: string) => ({ key, label, type: "number" as const });

const CREDENTIAL_HELP =
  "Connect a GitHub account on the Integrations page. The token is encrypted and only sent to api.github.com.";

const REPO_FIELD = {
  key: "repository",
  label: "Repository",
  kind: "text" as const,
  required: true,
  placeholder: "klyz/platform",
  mono: true,
  help: "owner/name — the repository this step reads from or writes to.",
};

const NUMBER_FIELD = {
  key: "number",
  label: "Issue number",
  kind: "text" as const,
  required: true,
  placeholder: "{{trigger.issueNumber}}",
  mono: true,
  bindable: true,
};

/**
 * GitHub trigger.
 *
 * Live runs are fed a verified delivery by the provider receiver; a
 * hand-run uses the optional sample payload, exactly like the manual
 * trigger, so the editor can preview mapping without pretending a
 * delivery arrived.
 */
export const githubTriggerDefinition: NodeDefinition = {
  type: "trigger.github",
  category: "trigger",
  title: "GitHub event",
  description: "Starts the workflow when something happens in a GitHub repository.",
  icon: "github",
  summary: "Repository events",
  trigger: true,
  cost: 60,
  credentials: ["github"],
  tags: ["github", "webhook"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    REPO_FIELD,
    {
      key: "event",
      label: "Event",
      kind: "select",
      required: true,
      options: GITHUB_EVENTS.map((event) => ({ value: event.value, label: event.label })),
      help: "Publishing this workflow registers a webhook for exactly this event.",
    },
    {
      key: "branch",
      label: "Branch filter",
      kind: "text",
      placeholder: "main",
      mono: true,
      showWhen: { key: "event", equals: "push" },
      help: "Leave empty to match every branch.",
    },
    {
      key: "sample",
      label: "Sample payload",
      kind: "code",
      rows: 6,
      mono: true,
      placeholder: '{ "action": "opened", "issue": { "number": 1042, "title": "…" } }',
      help: "GitHub JSON. Used only when you run this workflow by hand — live runs receive the real delivery.",
    },
  ],
  outputs: [
    str("event", "Event"),
    str("action", "Action"),
    str("repository", "Repository"),
    num("repositoryId", "Repository id"),
    num("issueId", "Issue id"),
    num("issueNumber", "Issue number"),
    str("title", "Title"),
    str("body", "Body"),
    str("author", "Author"),
    str("authorEmail", "Author email"),
    { key: "labels", label: "Labels", type: "array" },
    str("url", "URL"),
    str("createdAt", "Created at"),
    str("branch", "Branch"),
    str("commitMessage", "Commit message"),
    str("commitUrl", "Commit URL"),
    str("receivedAt", "Received at"),
    { key: "raw", label: "Raw payload", type: "object" },
  ],
};

const ISSUE_CHILDREN: OutputField[] = [
  num("number", "Number"),
  str("title", "Title"),
  str("body", "Body"),
  str("state", "State"),
  str("url", "URL"),
  str("author", "Author"),
  { key: "labels", label: "Labels", type: "array" },
  { key: "assignees", label: "Assignees", type: "array" },
  str("createdAt", "Created at"),
  str("updatedAt", "Updated at"),
  num("commentCount", "Comments"),
];

/** Create, update, get or search issues in a repository. */
export const githubIssueDefinition: NodeDefinition = {
  type: "action.github_issue",
  category: "action",
  title: "GitHub issue",
  description: "Creates, updates, reads or searches issues in a GitHub repository.",
  icon: "file",
  summary: "Works with an issue",
  cost: 150,
  credentials: ["github"],
  tags: ["github"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    {
      key: "operation",
      label: "Operation",
      kind: "select",
      required: true,
      options: [
        { value: "create", label: "Create issue" },
        { value: "update", label: "Update issue" },
        { value: "get", label: "Get issue" },
        { value: "search", label: "Search issues" },
      ],
    },
    REPO_FIELD,
    {
      key: "title",
      label: "Title",
      kind: "expression",
      required: true,
      bindable: true,
      showWhen: { key: "operation", equals: "create" },
      placeholder: "{{trigger.title}}",
    },
    {
      key: "body",
      label: "Body",
      kind: "textarea",
      rows: 7,
      bindable: true,
      showWhen: { key: "operation", equals: ["create", "update"] },
      placeholder: "Reported from {{trigger.url}}",
      help: "Markdown is supported by GitHub.",
    },
    {
      key: "labels",
      label: "Labels",
      kind: "text",
      mono: true,
      bindable: true,
      showWhen: { key: "operation", equals: ["create", "update"] },
      placeholder: "bug, needs-triage",
      help: "Comma separated. Labels must already exist in the repository.",
    },
    {
      key: "assignees",
      label: "Assignees",
      kind: "text",
      mono: true,
      bindable: true,
      showWhen: { key: "operation", equals: ["create", "update"] },
      placeholder: "octocat, nadia-k",
      help: "Comma separated GitHub logins.",
    },
    {
      key: "state",
      label: "State",
      kind: "select",
      showWhen: { key: "operation", equals: "update" },
      options: [
        { value: "open", label: "Open" },
        { value: "closed", label: "Closed" },
      ],
    },
    NUMBER_FIELD,
    {
      key: "q",
      label: "Query",
      kind: "text",
      mono: true,
      bindable: true,
      required: true,
      showWhen: { key: "operation", equals: "search" },
      placeholder: "is:issue is:open label:bug repo:klyz/platform",
      help: "GitHub issue search syntax. The repository is appended automatically.",
    },
    {
      key: "searchState",
      label: "State",
      kind: "select",
      showWhen: { key: "operation", equals: "search" },
      options: [
        { value: "any", label: "Any" },
        { value: "open", label: "Open" },
        { value: "closed", label: "Closed" },
      ],
    },
    {
      key: "limit",
      label: "Max results",
      kind: "number",
      showWhen: { key: "operation", equals: "search" },
      placeholder: "20",
      help: "Capped at 50 per run.",
    },
  ],
  outputs: [
    { key: "issue", label: "Issue", type: "object", children: ISSUE_CHILDREN },
    { key: "issues", label: "Issues", type: "array" },
    num("count", "Matched"),
    str("operation", "Operation"),
  ],
};

/** Add a comment to an issue or pull request. */
export const githubCommentDefinition: NodeDefinition = {
  type: "action.github_comment",
  category: "action",
  title: "GitHub comment",
  description: "Adds a comment to an issue or pull request.",
  icon: "list",
  summary: "Comments on an issue",
  cost: 130,
  credentials: ["github"],
  tags: ["github"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    REPO_FIELD,
    NUMBER_FIELD,
    {
      key: "body",
      label: "Comment",
      kind: "textarea",
      required: true,
      rows: 6,
      bindable: true,
      placeholder: "Reproduced on {{trigger.repository}} — triaging now.",
    },
  ],
  outputs: [
    {
      key: "comment",
      label: "Comment",
      type: "object",
      children: [
        num("id", "Id"),
        str("url", "URL"),
        str("body", "Body"),
        str("author", "Author"),
        str("createdAt", "Created at"),
      ],
    },
    num("issueNumber", "Issue number"),
  ],
};
