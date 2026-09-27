/**
 * KLYZ domain model.
 *
 * Everything here is plain, serializable data. A workflow *definition*
 * (what should happen) is kept strictly separate from an *execution*
 * (what actually happened) so a real backend can own runtime state.
 */

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

export const NODE_CATEGORIES = [
  "trigger",
  "action",
  "logic",
  "ai",
  "data",
  "utility",
] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];

/* ------------------------------------------------------------------ */
/* Statuses                                                            */
/* ------------------------------------------------------------------ */

export const WORKFLOW_STATUSES = [
  "draft",
  "active",
  "paused",
  "disabled",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const EXECUTION_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const NODE_STATUSES = [
  "idle",
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
  "waiting",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const EDGE_STATUSES = [
  "idle",
  "active",
  "completed",
  "failed",
  "skipped",
  "waiting",
] as const;
export type EdgeStatus = (typeof EDGE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Node configuration schema                                           */
/* ------------------------------------------------------------------ */

type FieldKind =
  | "text"
  | "textarea"
  | "code"
  | "expression"
  | "select"
  | "number"
  | "toggle"
  | "keyvalue"
  /** Pick of a stored credential (secret values never round-trip here). */
  | "credential"
  /** Compound editor for a transform operation's parameters. */
  | "operations";

interface FieldOption {
  value: string;
  label: string;
}

export interface ConfigField {
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  help?: string;
  required?: boolean;
  options?: FieldOption[];
  /** Enables the data picker — the field accepts references to upstream output. */
  bindable?: boolean;
  /** Fields that only appear when another field holds a specific value. */
  showWhen?: { key: string; equals: string | string[] };
  mono?: boolean;
  rows?: number;
}

/** One row of a `keyvalue` config field's value. */
export interface KeyValueEntry {
  id: string;
  key: string;
  value: string;
}

type OutputType = "string" | "number" | "boolean" | "object" | "array";

export interface OutputField {
  key: string;
  label: string;
  type: OutputType;
  children?: OutputField[];
}

export type CredentialKind =
  | "gmail"
  | "github"
  | "slack"
  | "notion"
  | "google_sheets"
  | "postgres"
  | "http_basic"
  | "http_bearer"
  | "http_header";

export interface NodeDefinition {
  type: string;
  category: NodeCategory;
  title: string;
  description: string;
  /** Lucide icon key — kept as a string so definitions stay serializable. */
  icon: string;
  /** Rendered as the node's primary line when no custom label is set. */
  summary: string;
  fields: ConfigField[];
  outputs: OutputField[];
  credentials?: CredentialKind[];
  /** Trigger nodes have no inbound edge. */
  trigger?: boolean;
  /** Logic nodes that expose named outgoing branches. */
  branches?: string[];
  /** Estimated per-run cost in ms — used for demo execution timing. */
  cost: number;
  /** Documentation-ish tag shown in the node palette. */
  tags?: string[];
}

/* ------------------------------------------------------------------ */
/* Graph                                                               */
/* ------------------------------------------------------------------ */

export interface KlyzNodeData extends Record<string, unknown> {
  /** Expression alias, e.g. `{{github.issue.title}}`. */
  ref: string;
  /** Optional user-supplied rename shown instead of the definition title. */
  label?: string;
  config: Record<string, unknown>;
  /** Runtime-only — never persisted with the workflow definition. */
  status?: NodeStatus;
}

export interface KlyzEdgeData extends Record<string, unknown> {
  /** Named branch for logic nodes ("true", "false", "high", ...). */
  branch?: string;
  /** Runtime-only. */
  status?: EdgeStatus;
}

/* ------------------------------------------------------------------ */
/* Workflow definition                                                 */
/* ------------------------------------------------------------------ */

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastExecutedAt: string | null;
  executionCount: number;
  successRate: number;
  avgDurationMs: number;
  triggerType: string;
  nodeCount: number;
}

export interface Workflow extends WorkflowSummary {
  /** React Flow node array — stored as JSON so the backend owns the graph. */
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    data: KlyzNodeData;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
    data?: KlyzEdgeData;
  }>;
}

/**
 * A workflow as the API returns it: summary, editable graph, and where
 * the draft currently stands against the published versions.
 */
export interface WorkflowDocument extends Workflow {
  /** Optimistic-concurrency token — send it back to save the draft. */
  revision: number;
  publishedVersionId: string | null;
  publishedVersion: number;
  hasUnpublishedChanges: boolean;
}

/** One row of a workflow's immutable version history. */
export interface WorkflowVersionInfo {
  id: string;
  version: number;
  hash: string;
  createdAt: string;
  createdBy: string | null;
  nodeCount: number;
  isPublished: boolean;
}

/* ------------------------------------------------------------------ */
/* Execution errors                                                    */
/* ------------------------------------------------------------------ */

export interface ExecutionError {
  code: string;
  message: string;
  detail?: string;
  status?: number;
  hint?: string;
  remediation?: { label: string; kind: "reconnect" | "retry" | "inspect" };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  id: string;
  severity: ValidationSeverity;
  nodeId?: string;
  edgeId?: string;
  message: string;
  hint?: string;
}
