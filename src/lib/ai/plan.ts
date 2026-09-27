import type { CredentialKind } from "@/lib/workflow/types";

/**
 * The structured workflow plan — the only thing the model is allowed to
 * return.
 *
 * A plan is *proposed data*, never a workflow: it names real node types,
 * carries configuration the editor understands, and records everything
 * the model could not decide (unresolved), assumed (assumptions), needs
 * (connections) or would do twice (side effects). It only becomes a
 * workflow after `validatePlan` → human review → the normal editor path.
 *
 * Parsing is deliberately hand-rolled and strict rather than schema-lib
 * driven: the repository ships no validation dependency, the surface is
 * small, and malformed model output must fail loudly with a list of
 * reasons instead of being coerced into something plausible.
 */

export interface PlanNode {
  /** Stable id inside the plan, e.g. `n1`. Becomes the graph node id. */
  id: string;
  /** Must be a type registered in the KLYZ node registry. */
  type: string;
  /** Expression alias later steps reference as `{{ref.path}}`. */
  ref?: string;
  label?: string;
  config: Record<string, unknown>;
  /** Why this node exists — shown next to it in review. */
  why: string;
}

export interface PlanEdge {
  id: string;
  source: string;
  target: string;
  /** Named outgoing branch for branching nodes (`true`/`false`, case name…). */
  branch?: string;
}

export type PlanStageName = "trigger" | "processing" | "logic" | "action" | "result";

export interface PlanStage {
  stage: PlanStageName;
  label: string;
}

export type UnresolvedSeverity = "missing" | "ambiguous" | "unsupported";

export interface PlanUnresolved {
  label: string;
  reason: string;
  severity: UnresolvedSeverity;
  nodeId?: string;
  field?: string;
}

export interface PlanConnection {
  credential: CredentialKind;
  label: string;
  reason: string;
  nodeId?: string;
}

export interface PlanSideEffect {
  label: string;
  reason: string;
  nodeId?: string;
}

export interface WorkflowPlan {
  title: string;
  description: string;
  /** One-paragraph summary of what the user asked for. */
  summary: string;
  intent: PlanStage[];
  nodes: PlanNode[];
  edges: PlanEdge[];
  assumptions: string[];
  unresolved: PlanUnresolved[];
  requiredConnections: PlanConnection[];
  warnings: string[];
  sideEffects: PlanSideEffect[];
}

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/** Hard ceilings applied while parsing — bounds the model's blast radius. */
export const PLAN_LIMITS = {
  nodes: 60,
  edges: 120,
  intent: 12,
  assumptions: 24,
  unresolved: 40,
  connections: 24,
  warnings: 24,
  sideEffects: 40,
  title: 140,
  description: 800,
  summary: 800,
  text: 400,
  why: 400,
  label: 80,
  ref: 60,
  configString: 4_000,
  configDepth: 6,
  configItems: 100,
} as const;

const STAGE_NAMES: readonly PlanStageName[] = [
  "trigger",
  "processing",
  "logic",
  "action",
  "result",
];

/** Mirrors the `CredentialKind` union — the model may only ask for these. */
const CREDENTIAL_KINDS = [
  "gmail",
  "github",
  "slack",
  "notion",
  "google_sheets",
  "postgres",
  "http_basic",
  "http_bearer",
  "http_header",
] as const satisfies readonly CredentialKind[];

const UNRESOLVED_SEVERITIES: readonly UnresolvedSeverity[] = [
  "missing",
  "ambiguous",
  "unsupported",
];

const NODE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const NODE_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const REF_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
/** Reserved roots the engine provides on every run. */
const RESERVED_REFS = new Set(["trigger", "context"]);

export class PlanParseError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`The model returned an unusable plan: ${issues.join(" · ")}`);
    this.name = "PlanParseError";
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

class Reader {
  readonly issues: string[] = [];

  fail(message: string): void {
    if (this.issues.length < 40) this.issues.push(message);
  }

  string(value: unknown, path: string, max: number, fallback = ""): string {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "string") {
      this.fail(`${path} must be a string`);
      return fallback;
    }
    const trimmed = value.trim();
    if (!trimmed && fallback) return fallback;
    return clip(trimmed, max);
  }

  optionalString(value: unknown, path: string, max: number): string | undefined {
    if (value === undefined || value === null) return undefined;
    const text = this.string(value, path, max);
    return text || undefined;
  }

  stringArray(value: unknown, path: string, cap: number, max: number): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      this.fail(`${path} must be an array of strings`);
      return [];
    }
    const out: string[] = [];
    for (const [index, item] of value.slice(0, cap).entries()) {
      if (typeof item !== "string" || !item.trim()) {
        this.fail(`${path}[${index}] must be a non-empty string`);
        continue;
      }
      out.push(clip(item.trim(), max));
    }
    if (value.length > cap) this.fail(`${path} has more than ${cap} entries`);
    return out;
  }

  /** Config values: primitives and small bounded structures only. */
  config(value: unknown, path: string): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (!isRecord(value)) {
      this.fail(`${path} must be an object`);
      return {};
    }
    return this.value(value, path, 0) as Record<string, unknown>;
  }

  private value(raw: unknown, path: string, depth: number): unknown {
    if (depth > PLAN_LIMITS.configDepth) {
      this.fail(`${path} is nested too deeply`);
      return null;
    }
    if (raw === null) return null;
    if (typeof raw === "boolean" || typeof raw === "number") return raw;
    if (typeof raw === "string") return clip(raw, PLAN_LIMITS.configString);
    if (Array.isArray(raw)) {
      if (raw.length > PLAN_LIMITS.configItems) {
        this.fail(`${path} has more than ${PLAN_LIMITS.configItems} items`);
        return raw.slice(0, PLAN_LIMITS.configItems).map((item, i) =>
          this.value(item, `${path}[${i}]`, depth + 1),
        );
      }
      return raw.map((item, i) => this.value(item, `${path}[${i}]`, depth + 1));
    }
    if (isRecord(raw)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(raw)) {
        if (key.length > 80) {
          this.fail(`${path} has a key longer than 80 characters`);
          continue;
        }
        out[key] = this.value(item, `${path}.${key}`, depth + 1);
      }
      return out;
    }
    this.fail(`${path} must be a string, number, boolean, array or object`);
    return null;
  }

  take(): void {
    if (this.issues.length > 0) throw new PlanParseError(this.issues);
  }
}

function parseNode(raw: unknown, index: number, reader: Reader): PlanNode | null {
  const path = `nodes[${index}]`;
  if (!isRecord(raw)) {
    reader.fail(`${path} must be an object`);
    return null;
  }
  const id = reader.string(raw.id, `${path}.id`, 40);
  if (!NODE_ID_RE.test(id)) {
    reader.fail(`${path}.id must be 1-40 characters of letters, digits, "_" or "-"`);
    return null;
  }
  const type = reader.string(raw.type, `${path}.type`, 60);
  if (!NODE_TYPE_RE.test(type)) {
    reader.fail(`${path}.type must look like a KLYZ node type (e.g. "action.slack_message")`);
    return null;
  }
  const ref = reader.optionalString(raw.ref, `${path}.ref`, PLAN_LIMITS.ref);
  if (ref && (!REF_RE.test(ref) || RESERVED_REFS.has(ref))) {
    reader.fail(`${path}.ref must be a simple identifier that is not "trigger" or "context"`);
  }
  return {
    id,
    type,
    ...(ref ? { ref } : {}),
    ...(typeof raw.label === "string" ? { label: reader.string(raw.label, `${path}.label`, PLAN_LIMITS.label) } : {}),
    config: reader.config(raw.config, `${path}.config`),
    why: reader.string(raw.why, `${path}.why`, PLAN_LIMITS.why, "Part of the requested automation."),
  };
}

function parseEdge(raw: unknown, index: number, used: Set<string>, reader: Reader): PlanEdge | null {
  const path = `edges[${index}]`;
  if (!isRecord(raw)) {
    reader.fail(`${path} must be an object`);
    return null;
  }
  const source = reader.string(raw.source, `${path}.source`, 40);
  const target = reader.string(raw.target, `${path}.target`, 40);
  if (!NODE_ID_RE.test(source) || !NODE_ID_RE.test(target)) {
    reader.fail(`${path} must reference node ids`);
    return null;
  }
  const branch = reader.optionalString(raw.branch, `${path}.branch`, 40);
  let id = reader.optionalString(raw.id, `${path}.id`, 60) ?? `e_${source}_${target}`;
  if (branch) id += `_${branch}`;
  let candidate = id;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${id}_${suffix++}`;
  used.add(candidate);
  return { id: candidate, source, target, ...(branch ? { branch } : {}) };
}

function parseUnresolved(raw: unknown, index: number, reader: Reader): PlanUnresolved | null {
  const path = `unresolved[${index}]`;
  if (!isRecord(raw)) {
    reader.fail(`${path} must be an object`);
    return null;
  }
  const label = reader.string(raw.label, `${path}.label`, PLAN_LIMITS.label);
  if (!label) {
    reader.fail(`${path}.label is required`);
    return null;
  }
  const severity = reader.string(raw.severity, `${path}.severity`, 20, "missing");
  if (!UNRESOLVED_SEVERITIES.includes(severity as UnresolvedSeverity)) {
    reader.fail(`${path}.severity must be one of ${UNRESOLVED_SEVERITIES.join(", ")}`);
    return null;
  }
  const nodeId = reader.optionalString(raw.nodeId, `${path}.nodeId`, 40);
  const field = reader.optionalString(raw.field, `${path}.field`, 60);
  return {
    label,
    reason: reader.string(raw.reason, `${path}.reason`, PLAN_LIMITS.text, "Not specified in the request."),
    severity: severity as UnresolvedSeverity,
    ...(nodeId ? { nodeId } : {}),
    ...(field ? { field } : {}),
  };
}

function parseConnection(raw: unknown, index: number, reader: Reader): PlanConnection | null {
  const path = `requiredConnections[${index}]`;
  if (!isRecord(raw)) {
    reader.fail(`${path} must be an object`);
    return null;
  }
  const credential = reader.string(raw.credential, `${path}.credential`, 30);
  if (!CREDENTIAL_KINDS.includes(credential as CredentialKind)) {
    reader.fail(`${path}.credential must be one of ${CREDENTIAL_KINDS.join(", ")}`);
    return null;
  }
  const nodeId = reader.optionalString(raw.nodeId, `${path}.nodeId`, 40);
  return {
    credential: credential as CredentialKind,
    label: reader.string(raw.label, `${path}.label`, PLAN_LIMITS.label, credential),
    reason: reader.string(raw.reason, `${path}.reason`, PLAN_LIMITS.text, "Needed by a step in this workflow."),
    ...(nodeId ? { nodeId } : {}),
  };
}

function parseSideEffect(raw: unknown, index: number, reader: Reader): PlanSideEffect | null {
  const path = `sideEffects[${index}]`;
  if (!isRecord(raw)) {
    reader.fail(`${path} must be an object`);
    return null;
  }
  const label = reader.string(raw.label, `${path}.label`, PLAN_LIMITS.label);
  if (!label) {
    reader.fail(`${path}.label is required`);
    return null;
  }
  const nodeId = reader.optionalString(raw.nodeId, `${path}.nodeId`, 40);
  return {
    label,
    reason: reader.string(raw.reason, `${path}.reason`, PLAN_LIMITS.text, "Changes something outside KLYZ."),
    ...(nodeId ? { nodeId } : {}),
  };
}

function parseStage(raw: unknown, index: number, reader: Reader): PlanStage | null {
  const path = `intent[${index}]`;
  if (!isRecord(raw)) {
    reader.fail(`${path} must be an object`);
    return null;
  }
  const stage = reader.string(raw.stage, `${path}.stage`, 20);
  if (!STAGE_NAMES.includes(stage as PlanStageName)) {
    reader.fail(`${path}.stage must be one of ${STAGE_NAMES.join(", ")}`);
    return null;
  }
  const label = reader.string(raw.label, `${path}.label`, PLAN_LIMITS.label);
  if (!label) {
    reader.fail(`${path}.label is required`);
    return null;
  }
  return { stage: stage as PlanStageName, label };
}

/** Rejects keys the schema does not know — the model may not smuggle fields in. */
function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  reader: Reader,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) reader.fail(`${path} has an unknown field "${key}"`);
  }
}

const PLAN_KEYS = [
  "title",
  "description",
  "summary",
  "intent",
  "nodes",
  "edges",
  "assumptions",
  "unresolved",
  "requiredConnections",
  "warnings",
  "sideEffects",
] as const;

const NODE_KEYS = ["id", "type", "ref", "label", "config", "why"] as const;
const EDGE_KEYS = ["id", "source", "target", "branch"] as const;

/**
 * Parse raw model output into a plan. Throws `PlanParseError` with every
 * reason found — the caller shows them instead of retrying forever.
 */
export function parseWorkflowPlan(raw: unknown): WorkflowPlan {
  const reader = new Reader();
  if (!isRecord(raw)) throw new PlanParseError(["the response must be a JSON object"]);

  rejectUnknownKeys(raw, PLAN_KEYS, "plan", reader);

  const title = reader.string(raw.title, "title", PLAN_LIMITS.title);
  if (!title) reader.fail("title is required");

  const nodesRaw = Array.isArray(raw.nodes) ? raw.nodes : null;
  if (!nodesRaw) reader.fail("nodes must be an array");
  const edgesRaw = Array.isArray(raw.edges) ? raw.edges : null;
  if (!edgesRaw) reader.fail("edges must be an array");

  const nodes: PlanNode[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (nodesRaw ?? []).slice(0, PLAN_LIMITS.nodes).entries()) {
    rejectUnknownKeys(isRecord(item) ? item : {}, NODE_KEYS, `nodes[${index}]`, reader);
    const node = parseNode(item, index, reader);
    if (!node) continue;
    if (seen.has(node.id)) {
      reader.fail(`nodes[${index}].id "${node.id}" is duplicated`);
      continue;
    }
    seen.add(node.id);
    nodes.push(node);
  }
  if ((nodesRaw?.length ?? 0) > PLAN_LIMITS.nodes) {
    reader.fail(`nodes exceeds the ${PLAN_LIMITS.nodes}-node limit`);
  }
  if (nodesRaw && nodesRaw.length === 0) reader.fail("nodes must not be empty");

  const edges: PlanEdge[] = [];
  const usedEdgeIds = new Set<string>();
  for (const [index, item] of (edgesRaw ?? []).slice(0, PLAN_LIMITS.edges).entries()) {
    rejectUnknownKeys(isRecord(item) ? item : {}, EDGE_KEYS, `edges[${index}]`, reader);
    const edge = parseEdge(item, index, usedEdgeIds, reader);
    if (edge) edges.push(edge);
  }
  if ((edgesRaw?.length ?? 0) > PLAN_LIMITS.edges) {
    reader.fail(`edges exceeds the ${PLAN_LIMITS.edges}-edge limit`);
  }

  const stages: PlanStage[] = [];
  const intentRaw = raw.intent;
  if (intentRaw !== undefined && intentRaw !== null) {
    if (!Array.isArray(intentRaw)) reader.fail("intent must be an array");
    else {
      for (const [index, item] of intentRaw.slice(0, PLAN_LIMITS.intent).entries()) {
        const stage = parseStage(item, index, reader);
        if (stage) stages.push(stage);
      }
    }
  }

  const unresolved: PlanUnresolved[] = [];
  const unresolvedRaw = raw.unresolved;
  if (unresolvedRaw !== undefined && unresolvedRaw !== null) {
    if (!Array.isArray(unresolvedRaw)) reader.fail("unresolved must be an array");
    else {
      for (const [index, item] of unresolvedRaw.slice(0, PLAN_LIMITS.unresolved).entries()) {
        const entry = parseUnresolved(item, index, reader);
        if (entry) unresolved.push(entry);
      }
    }
  }

  const requiredConnections: PlanConnection[] = [];
  const connectionsRaw = raw.requiredConnections;
  if (connectionsRaw !== undefined && connectionsRaw !== null) {
    if (!Array.isArray(connectionsRaw)) reader.fail("requiredConnections must be an array");
    else {
      for (const [index, item] of connectionsRaw.slice(0, PLAN_LIMITS.connections).entries()) {
        const entry = parseConnection(item, index, reader);
        if (entry) requiredConnections.push(entry);
      }
    }
  }

  const sideEffects: PlanSideEffect[] = [];
  const effectsRaw = raw.sideEffects;
  if (effectsRaw !== undefined && effectsRaw !== null) {
    if (!Array.isArray(effectsRaw)) reader.fail("sideEffects must be an array");
    else {
      for (const [index, item] of effectsRaw.slice(0, PLAN_LIMITS.sideEffects).entries()) {
        const entry = parseSideEffect(item, index, reader);
        if (entry) sideEffects.push(entry);
      }
    }
  }

  reader.take();

  return {
    title,
    description: reader.string(raw.description, "description", PLAN_LIMITS.description),
    summary: reader.string(raw.summary, "summary", PLAN_LIMITS.summary),
    intent: stages,
    nodes,
    edges,
    assumptions: reader.stringArray(raw.assumptions, "assumptions", PLAN_LIMITS.assumptions, PLAN_LIMITS.text),
    unresolved,
    requiredConnections,
    warnings: reader.stringArray(raw.warnings, "warnings", PLAN_LIMITS.warnings, PLAN_LIMITS.text),
    sideEffects,
  };
}

/* ------------------------------------------------------------------ */
/* Small helpers used by the UI                                        */
/* ------------------------------------------------------------------ */

export function planNodeById(plan: WorkflowPlan, id: string): PlanNode | undefined {
  return plan.nodes.find((node) => node.id === id);
}

/** Node ids referenced by an edge, checked before conversion. */
export function planGraphIsConnected(plan: WorkflowPlan): boolean {
  const ids = new Set(plan.nodes.map((node) => node.id));
  return plan.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target));
}
