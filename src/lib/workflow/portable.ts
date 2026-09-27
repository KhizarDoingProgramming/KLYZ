import { getDefinition } from "./registry";
import {
  collectCredentialValueIssues,
  looksLikeSecret,
  stripRuntimeState,
  stripWebhookSecrets,
} from "./sanitize";
import { findMalformedExpressions } from "./expressions";
import { validateWorkflow } from "./validation";
import type { ConfigField, ValidationIssue, Workflow } from "./types";

/**
 * The one portable workflow representation.
 *
 * A KLYZ workflow lives in three places — the editor's draft, an
 * immutable `WorkflowVersion`, and (new) files and templates that move
 * between workspaces and machines. All three are *projections* of the
 * same graph; this module is the boundary between the stored form and
 * the movable form, and it is deliberately the only place that knows
 * both.
 *
 * Three rules govern everything here:
 *
 *  1. **The portable document is a projection, not a row.** No user id,
 *     workspace id, session id, execution id, version id, credential id
 *     or audit trail can appear in it, because the export path builds it
 *     field by field rather than copying the definition.
 *  2. **Node identity is logical, not database-local.** Export renames
 *     every node to a stable, type-derived id (`http_1`, `condition_1`)
 *     and remaps the edges, so a definition survives a round trip
 *     through a text editor, a diff and another workspace. Expressions
 *     reference `data.ref`, which is already portable and untouched.
 *  3. **Import is untrusted input.** `portableToWorkflow` validates
 *     structure, graph shape, node capability and expression syntax
 *     before it builds a `Workflow`, and it never executes, publishes
 *     or persists anything — that is the caller's job, after review.
 */

/* ------------------------------------------------------------------ */
/* Format identity and limits                                          */
/* ------------------------------------------------------------------ */

export const PORTABLE_FORMAT = "klyz.workflow";
export const PORTABLE_VERSION = 1;

/**
 * Bounds, in one place so routes and the editor quote the same numbers.
 *
 * They are generous on purpose: a real workflow is tens of nodes, not
 * hundreds, and an import that arrives at a megabyte is either an
 * accident or an attack. Everything below is about *bounding* work, not
 * about making workflows small.
 */
export const PORTABLE_LIMITS = {
  /** Serialized portable document. */
  maxBytes: 256 * 1024,
  /** Raw import request body (document + name + credential mapping). */
  maxRequestBytes: 512 * 1024,
  maxNodes: 200,
  maxEdges: 400,
  maxNameLength: 200,
  maxDescriptionLength: 2_000,
  maxTags: 12,
  maxTagLength: 40,
  /** Any single string inside a config value. */
  maxStringChars: 8_000,
  /** Nesting depth for config values. */
  maxDepth: 6,
  maxIdChars: 128,
  maxTemplatesPerWorkspace: 200,
} as const;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * How a credential *field* travels: never an id, never a value, only
 * "this field wanted a GitHub credential called 'Main account'". The
 * importing workspace decides whether it has one.
 */
export interface PortableCredentialRef {
  provider: string;
  name: string;
}

export interface PortableNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  /** Expression alias — the same string `{{…}}` references. */
  ref?: string;
  label?: string;
  config: Record<string, unknown>;
  /** Credential fields, keyed by field name, as safe references. */
  credentials?: Record<string, PortableCredentialRef>;
}

export interface PortableEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  branch?: string;
}

export interface PortableTrigger {
  type: string;
  config: Record<string, unknown>;
}

export interface PortableWorkflow {
  format: typeof PORTABLE_FORMAT;
  version: number;
  name: string;
  description: string;
  trigger: PortableTrigger;
  nodes: PortableNode[];
  edges: PortableEdge[];
  metadata?: {
    tags?: string[];
    nodeCount?: number;
    source?: string;
  };
}

/** A credential the imported workflow still needs before it can run. */
export interface CredentialRequirement {
  /** `<nodeId>.<field>` — the key the import endpoint accepts. */
  key: string;
  nodeId: string;
  nodeLabel: string;
  field: string;
  fieldLabel: string;
  /** Credential kinds this field accepts. */
  providers: string[];
  /** Name the exporter saw, when it had one. */
  name?: string;
  /** True when the importer resolved it to a stored credential. */
  resolved: boolean;
}

/** A problem found while exporting or importing. Shaped like editor issues. */
export type PortableIssue = ValidationIssue & { path?: string };

export class PortableFormatError extends Error {
  readonly status: number;
  readonly issues: PortableIssue[];

  constructor(status: number, code: string, message: string, issues: PortableIssue[] = []) {
    super(message);
    this.name = "PortableFormatError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  readonly code: string;
}

function fail(
  status: number,
  code: string,
  message: string,
  issues: PortableIssue[] = [],
): never {
  throw new PortableFormatError(status, code, message, issues);
}

function issue(
  id: string,
  severity: "error" | "warning",
  message: string,
  extra: Partial<PortableIssue> = {},
): PortableIssue {
  return { id, severity, message, ...extra };
}

/* ------------------------------------------------------------------ */
/* Issue classification                                                */
/* ------------------------------------------------------------------ */

/**
 * Import blocks on *structure*, not on completeness.
 *
 * A graph that is malformed, uses a capability this build does not
 * have, or references something that is not there cannot be repaired
 * by a human in the editor — accepting it would create a workflow that
 * is broken in ways the UI cannot express, so it is refused with the
 * exact problem. Missing configuration, an unconnected credential or an
 * awkward-but-legal shape is reported as a warning: the draft is
 * created, the editor shows what is left to fill in, and publishing
 * still runs the same `assertRunnable` gate it always has.
 */
const BLOCKING_PREFIXES = [
  "capability_",
  "unknown_",
  "graph_cycle",
  "no_trigger",
  "multiple_triggers_",
  "edge_missing_",
  "edge_self_",
  "orphan_",
  "dup_ref_",
  "ref_",
  "expression_",
  "credential_value_",
  "import_",
];

export function isBlockingImportIssue(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((candidate) =>
    BLOCKING_PREFIXES.some((prefix) => candidate.id.startsWith(prefix)),
  );
}

/* ------------------------------------------------------------------ */
/* Stable node identity                                                */
/* ------------------------------------------------------------------ */

function prefixFor(type: string): string {
  const last = type.split(".").pop() ?? "step";
  const cleaned = last
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return cleaned || "step";
}

/**
 * Type-derived ids: `action.http` → `http_1`, `http_2`, … Counters are
 * per prefix and assigned in graph order, so the result is stable for a
 * given definition and always unique inside it.
 */
export function stableNodeIds(
  nodes: Array<{ id: string; type: string }>,
): Map<string, string> {
  const counters = new Map<string, number>();
  const mapping = new Map<string, string>();
  for (const node of nodes) {
    const prefix = prefixFor(node.type);
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    mapping.set(node.id, `${prefix}_${next}`);
  }
  return mapping;
}

/* ------------------------------------------------------------------ */
/* Config sanitising                                                   */
/* ------------------------------------------------------------------ */

const FORBIDDEN_KEYS = new Set(["__proto__"]);

function sanitizeConfigValue(
  value: unknown,
  depth: number,
  path: string,
  issues: PortableIssue[],
  nodeId: string,
): unknown {
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > PORTABLE_LIMITS.maxStringChars) {
      issues.push(
        issue(
          `import_value_too_long`,
          "error",
          `"${path}" is longer than ${PORTABLE_LIMITS.maxStringChars} characters.`,
          { nodeId, path },
        ),
      );
      return "";
    }
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  if (depth >= PORTABLE_LIMITS.maxDepth) {
    issues.push(
      issue(
        "import_value_too_deep",
        "error",
        `"${path}" is nested deeper than ${PORTABLE_LIMITS.maxDepth} levels.`,
        { nodeId, path },
      ),
    );
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      sanitizeConfigValue(entry, depth + 1, `${path}[${index}]`, issues, nodeId),
    );
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (FORBIDDEN_KEYS.has(key)) {
        issues.push(
          issue(
            "import_unsafe_key",
            "error",
            `"${path}.${key}" is not an allowed configuration key.`,
            { nodeId, path: `${path}.${key}` },
          ),
        );
        continue;
      }
      out[key] = sanitizeConfigValue(entry, depth + 1, `${path}.${key}`, issues, nodeId);
    }
    return out;
  }
  /* functions, symbols, bigints — never reachable from JSON.parse, but
     the export path can see them if a caller hands us live objects. */
  return null;
}

function sanitizeConfig(
  config: unknown,
  issues: PortableIssue[],
  nodeId: string,
): Record<string, unknown> {
  if (config === null || config === undefined) return {};
  if (typeof config !== "object" || Array.isArray(config)) {
    issues.push(
      issue("import_bad_config", "error", "Step configuration must be an object.", {
        nodeId,
      }),
    );
    return {};
  }
  const sanitized = sanitizeConfigValue(config, 0, "config", issues, nodeId);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

/* ------------------------------------------------------------------ */
/* Credential helpers                                                  */
/* ------------------------------------------------------------------ */

function credentialFields(type: string): ConfigField[] {
  return (getDefinition(type)?.fields ?? []).filter(
    (field) => field.kind === "credential",
  );
}

function providersFor(type: string, field: ConfigField): string[] {
  const declared = getDefinition(type)?.credentials;
  if (declared && declared.length > 0) return [...declared];
  return field.kind === "credential" ? [] : [];
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export interface PortableExportContext {
  /**
   * Turn a stored credential id into the only thing that may travel:
   * its kind and its display name. Returning `null` means "I do not
   * know this one" — the field is dropped and a warning is raised.
   */
  resolveCredential?: (credentialId: string) => PortableCredentialRef | null;
}

export interface PortableExportResult {
  portable: PortableWorkflow;
  warnings: PortableIssue[];
}

/**
 * Project a stored definition into the portable form.
 *
 * Deterministic: the same definition always produces byte-identical
 * JSON (no timestamps, no ids, no map iteration order). That is what
 * makes exports diffable and hashable.
 */
export function portableFromWorkflow(
  rawDefinition: Workflow,
  context: PortableExportContext = {},
): PortableExportResult {
  const warnings: PortableIssue[] = [];
  /* Runtime colours and the webhook secret are stripped first — the
     same two functions the hashing and versioning paths use, so an
     export and a published version agree about what the graph is. */
  const definition = stripRuntimeState(stripWebhookSecrets(rawDefinition));
  const idMap = stableNodeIds(definition.nodes);

  const nodes: PortableNode[] = definition.nodes.map((node) => {
    const config = sanitizeConfig(node.data?.config ?? {}, warnings, node.id);
    const credentials: Record<string, PortableCredentialRef> = {};

    for (const field of credentialFields(node.type)) {
      const value = config[field.key];
      if (typeof value !== "string" || value.trim() === "") {
        delete config[field.key];
        continue;
      }
      const reference = context.resolveCredential?.(value) ?? null;
      if (!reference) {
        delete config[field.key];
        warnings.push(
          issue(
            "warning_credential_unresolved",
            "warning",
            `The stored credential on "${node.data?.label ?? node.type}" could not be read, so it was not exported.`,
            { nodeId: node.id },
          ),
        );
        continue;
      }
      credentials[field.key] = reference;
      delete config[field.key];
    }

    /* Defence in depth: `assertNoCredentialValues` already refuses to
       save a secret, but an export is also the last gate before bytes
       leave the process. Anything that still looks like a secret is
       dropped rather than written to the file. */
    for (const [key, value] of Object.entries(config)) {
      if (looksLikeSecret(key, value)) {
        delete config[key];
        warnings.push(
          issue(
            "warning_secret_removed",
            "warning",
            `Removed "${key}" from "${node.data?.label ?? node.type}" — secrets are never exported.`,
            { nodeId: node.id, path: key },
          ),
        );
      }
    }
    if (node.type === "trigger.webhook") delete config.secret;

    const portable: PortableNode = {
      id: idMap.get(node.id)!,
      type: node.type,
      position: {
        x: Number.isFinite(node.position?.x) ? node.position.x : 0,
        y: Number.isFinite(node.position?.y) ? node.position.y : 0,
      },
      config,
    };
    if (typeof node.data?.ref === "string" && node.data.ref) portable.ref = node.data.ref;
    if (typeof node.data?.label === "string" && node.data.label) {
      portable.label = node.data.label;
    }
    if (Object.keys(credentials).length > 0) portable.credentials = credentials;
    return portable;
  });

  const edges: PortableEdge[] = definition.edges.map((edge, index) => {
    const portable: PortableEdge = {
      id: `edge_${index + 1}`,
      source: idMap.get(edge.source) ?? edge.source,
      target: idMap.get(edge.target) ?? edge.target,
    };
    if (edge.sourceHandle) portable.sourceHandle = edge.sourceHandle;
    if (edge.targetHandle) portable.targetHandle = edge.targetHandle;
    if (edge.data?.branch) portable.branch = edge.data.branch;
    return portable;
  });

  const triggerNode = definition.nodes.find((node) => getDefinition(node.type)?.trigger);
  const trigger: PortableTrigger = triggerNode
    ? {
        type: triggerNode.type,
        config: sanitizeConfig(triggerNode.data?.config ?? {}, warnings, triggerNode.id),
      }
    : { type: "", config: {} };
  if (triggerNode && triggerNode.type === "trigger.webhook") delete trigger.config.secret;
  if (triggerNode) {
    for (const field of credentialFields(triggerNode.type)) delete trigger.config[field.key];
  }
  if (!triggerNode) {
    warnings.push(
      issue(
        "warning_no_trigger",
        "warning",
        "This workflow has no trigger, so it cannot start on its own.",
      ),
    );
  }

  const tags = Array.isArray(definition.tags)
    ? definition.tags.filter((tag) => typeof tag === "string").slice(0, PORTABLE_LIMITS.maxTags)
    : [];

  const portable: PortableWorkflow = {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    name: (definition.name ?? "").slice(0, PORTABLE_LIMITS.maxNameLength),
    description: (definition.description ?? "").slice(0, PORTABLE_LIMITS.maxDescriptionLength),
    trigger,
    nodes,
    edges,
    metadata: { tags, nodeCount: nodes.length },
  };

  return { portable, warnings };
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(422, "IMPORT_INVALID", `${where} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max: number, label: string, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") {
    fail(422, "IMPORT_INVALID", `${label} must be a string.`);
  }
  if (value.length > max) {
    fail(422, "IMPORT_INVALID", `${label} may not exceed ${max} characters.`);
  }
  return value;
}

/**
 * Structural validation of an untrusted document.
 *
 * Everything after this point can assume the shape it expects, which
 * keeps the graph checks below readable instead of defensive.
 */
export function parsePortableWorkflow(raw: unknown): PortableWorkflow {
  if (typeof raw === "string") {
    if (Buffer !== undefined && Buffer.byteLength(raw, "utf8") > PORTABLE_LIMITS.maxBytes) {
      fail(
        413,
        "IMPORT_TOO_LARGE",
        `The definition is larger than ${Math.round(PORTABLE_LIMITS.maxBytes / 1024)} KB.`,
      );
    }
    try {
      raw = JSON.parse(raw);
    } catch {
      fail(400, "IMPORT_MALFORMED_JSON", "That file is not valid JSON.");
    }
  }

  const document = asRecord(raw, "The definition");

  if (document.format !== PORTABLE_FORMAT) {
    fail(
      422,
      "IMPORT_UNSUPPORTED_FORMAT",
      `Expected a "${PORTABLE_FORMAT}" document.`,
      [
        issue(
          "import_format",
          "error",
          `format must be "${PORTABLE_FORMAT}", received ${JSON.stringify(document.format)}.`,
        ),
      ],
    );
  }

  const version = Number(document.version);
  if (!Number.isInteger(version) || version < 1) {
    fail(422, "IMPORT_UNSUPPORTED_VERSION", "The document has no usable format version.", [
      issue("import_version", "error", "version must be a positive integer."),
    ]);
  }
  if (version > PORTABLE_VERSION) {
    fail(
      422,
      "IMPORT_UNSUPPORTED_VERSION",
      `This document was written by a newer KLYZ (format v${version}; this build reads up to v${PORTABLE_VERSION}).`,
      [
        issue(
          "import_version",
          "error",
          `format version ${version} is newer than the supported version ${PORTABLE_VERSION}.`,
        ),
      ],
    );
  }
  /* v1 is current. When v2 arrives the migration lives here and only
     here — never scattered through the editor or the routes. */
  const documentV1 = document as Record<string, unknown>;

  const name = boundedString(documentV1.name, PORTABLE_LIMITS.maxNameLength, "name", "Imported workflow");
  const description = boundedString(
    documentV1.description,
    PORTABLE_LIMITS.maxDescriptionLength,
    "description",
    "",
  );

  if (!Array.isArray(documentV1.nodes)) {
    fail(422, "IMPORT_INVALID", "nodes must be an array.", [
      issue("import_nodes", "error", "nodes must be an array."),
    ]);
  }
  if (!Array.isArray(documentV1.edges)) {
    fail(422, "IMPORT_INVALID", "edges must be an array.", [
      issue("import_edges", "error", "edges must be an array."),
    ]);
  }
  const nodes = documentV1.nodes;
  const edges = documentV1.edges;

  if (nodes.length === 0) {
    fail(422, "IMPORT_EMPTY", "This document has no steps.", [
      issue("import_empty", "error", "nodes must contain at least a trigger."),
    ]);
  }
  if (nodes.length > PORTABLE_LIMITS.maxNodes) {
    fail(
      422,
      "IMPORT_TOO_MANY_STEPS",
      `A portable workflow may hold at most ${PORTABLE_LIMITS.maxNodes} steps (received ${nodes.length}).`,
      [issue("import_too_many_nodes", "error", `${nodes.length} nodes exceeds the limit.`)],
    );
  }
  if (edges.length > PORTABLE_LIMITS.maxEdges) {
    fail(
      422,
      "IMPORT_TOO_MANY_STEPS",
      `A portable workflow may hold at most ${PORTABLE_LIMITS.maxEdges} connections (received ${edges.length}).`,
      [issue("import_too_many_edges", "error", `${edges.length} edges exceeds the limit.`)],
    );
  }

  /* Config sanitising reports what it had to throw away. Those
     reports are collected here and turned into a refusal below — a
     document that is too deep, too long or carrying a forbidden key is
     one this build cannot read, and silently keeping a truncated copy
     of it would corrupt the user's graph without telling them. */
  const structural: PortableIssue[] = [];

  const triggerDocument = asRecord(documentV1.trigger ?? {}, "trigger");
  const trigger: PortableTrigger = {
    type: boundedString(triggerDocument.type, 64, "trigger.type"),
    config: sanitizeConfig(triggerDocument.config ?? {}, structural, "trigger"),
  };

  const seen = new Set<string>();
  const parsedNodes: PortableNode[] = nodes.map((entry, index) => {
    const node = asRecord(entry, `nodes[${index}]`);
    const id = boundedString(node.id, PORTABLE_LIMITS.maxIdChars, `nodes[${index}].id`);
    if (!id) {
      fail(422, "IMPORT_INVALID", `nodes[${index}] has no id.`);
    }
    if (seen.has(id)) {
      fail(422, "IMPORT_DUPLICATE_ID", `Two steps share the id "${id}".`, [
        issue("import_duplicate_node_id", "error", `Duplicate node id "${id}".`, { nodeId: id }),
      ]);
    }
    seen.add(id);

    const type = boundedString(node.type, 64, `nodes[${index}].type`);
    if (!type) fail(422, "IMPORT_INVALID", `nodes[${index}] has no type.`);

    const positionRaw = node.position;
    const position =
      positionRaw && typeof positionRaw === "object" && !Array.isArray(positionRaw)
        ? {
            x: finite((positionRaw as Record<string, unknown>).x),
            y: finite((positionRaw as Record<string, unknown>).y),
          }
        : { x: 0, y: 0 };

    const parsed: PortableNode = {
      id,
      type,
      position,
      config: sanitizeConfig(node.config ?? {}, structural, id),
    };
    if (typeof node.ref === "string" && node.ref) {
      parsed.ref = boundedString(node.ref, PORTABLE_LIMITS.maxIdChars, `nodes[${index}].ref`);
    }
    if (typeof node.label === "string" && node.label) {
      parsed.label = boundedString(node.label, 200, `nodes[${index}].label`);
    }
    if (node.credentials && typeof node.credentials === "object") {
      const credentials: Record<string, PortableCredentialRef> = {};
      for (const [field, reference] of Object.entries(
        node.credentials as Record<string, unknown>,
      )) {
        if (!reference || typeof reference !== "object") continue;
        const record = reference as Record<string, unknown>;
        credentials[field] = {
          provider: boundedString(record.provider, 64, `credentials.${field}.provider`),
          name: boundedString(record.name, 200, `credentials.${field}.name`),
        };
      }
      if (Object.keys(credentials).length > 0) parsed.credentials = credentials;
    }
    return parsed;
  });

  const edgeIds = new Set<string>();
  const parsedEdges: PortableEdge[] = edges.map((entry, index) => {
    const edge = asRecord(entry, `edges[${index}]`);
    const id = boundedString(edge.id, PORTABLE_LIMITS.maxIdChars, `edges[${index}].id`) || `edge_${index + 1}`;
    if (edgeIds.has(id)) {
      fail(422, "IMPORT_DUPLICATE_ID", `Two connections share the id "${id}".`, [
        issue("import_duplicate_edge_id", "error", `Duplicate edge id "${id}".`, { edgeId: id }),
      ]);
    }
    edgeIds.add(id);
    const parsed: PortableEdge = {
      id,
      source: boundedString(edge.source, PORTABLE_LIMITS.maxIdChars, `edges[${index}].source`),
      target: boundedString(edge.target, PORTABLE_LIMITS.maxIdChars, `edges[${index}].target`),
    };
    if (typeof edge.sourceHandle === "string") parsed.sourceHandle = edge.sourceHandle;
    if (typeof edge.targetHandle === "string") parsed.targetHandle = edge.targetHandle;
    if (typeof edge.branch === "string") parsed.branch = edge.branch.slice(0, 64);
    return parsed;
  });

  if (structural.length > 0) {
    fail(
      422,
      "IMPORT_INVALID",
      "That document has configuration values this build cannot read.",
      structural,
    );
  }

  const metadataRaw = documentV1.metadata;
  const metadata: PortableWorkflow["metadata"] = {};
  if (metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)) {
    const record = metadataRaw as Record<string, unknown>;
    if (Array.isArray(record.tags)) {
      metadata.tags = record.tags
        .filter((tag): tag is string => typeof tag === "string")
        .slice(0, PORTABLE_LIMITS.maxTags)
        .map((tag) => tag.slice(0, PORTABLE_LIMITS.maxTagLength));
    }
    if (typeof record.source === "string") metadata.source = record.source.slice(0, 40);
    if (Number.isFinite(Number(record.nodeCount))) {
      metadata.nodeCount = Number(record.nodeCount);
    }
  }

  return {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    name,
    description,
    trigger,
    nodes: parsedNodes,
    edges: parsedEdges,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function finite(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export interface PortableImportContext {
  /** Id the new workflow will carry — generated by the caller. */
  id: string;
  name?: string;
  description?: string;
  /**
   * Explicit credential choices, keyed `<nodeId>.<field>`. The caller
   * has already proved each id exists in *its* workspace; this module
   * only checks the kind fits the field.
   */
  credentialIds?: Record<string, string>;
  /**
   * Automatic mapping used when nothing was specified: given a
   * requirement the exporter left behind, return a credential id or
   * `null` to leave it unresolved.
   */
  findCredential?: (requirement: Omit<CredentialRequirement, "resolved" | "key">) => string | null;
}

export interface PortableImportResult {
  definition: Workflow;
  requirements: CredentialRequirement[];
  warnings: PortableIssue[];
}

/**
 * Untrusted document → a `Workflow` draft.
 *
 * Nothing here touches the database, runs a step, mints a version or
 * enables a trigger. The caller reviews `warnings`/`requirements`, then
 * persists through the normal authoring path — which re-validates,
 * because defence in depth is cheaper than a bad publish.
 */
export function portableToWorkflow(
  raw: unknown,
  context: PortableImportContext,
): PortableImportResult {
  const portable = parsePortableWorkflow(raw);
  const blocking: PortableIssue[] = [];
  const warnings: PortableIssue[] = [];

  /* ---- capability check, before anything trusts a node type ---- */
  for (const node of portable.nodes) {
    if (!getDefinition(node.type)) {
      blocking.push(
        issue(
          "capability_unknown_node",
          "error",
          `This build has no step called "${node.type}".`,
          { nodeId: node.id, hint: "Remove it, or export from a KLYZ with that integration." },
        ),
      );
    }
  }

  /* ---- trigger agreement: the summary must match the graph ---- */
  const triggerNodes = portable.nodes.filter((node) => getDefinition(node.type)?.trigger);
  if (triggerNodes.length > 0 && portable.trigger.type) {
    if (!triggerNodes.some((node) => node.type === portable.trigger.type)) {
      blocking.push(
        issue(
          "import_trigger_mismatch",
          "error",
          `The document claims a "${portable.trigger.type}" trigger but the graph contains ${
            triggerNodes.map((node) => node.type).join(", ") || "none"
          }.`,
          { hint: "Re-export the workflow so the summary and the graph agree." },
        ),
      );
    }
  }

  /* ---- stable ids: regenerate so a definition from anywhere lands
           on ids this editor understands, edges included ---- */
  const idMap = stableNodeIds(portable.nodes);
  const byPortableId = new Map(portable.nodes.map((node) => [node.id, node]));

  const nodes = portable.nodes.map((node) => {
    const definition = getDefinition(node.type);
    const config = { ...node.config };

    /* credential placeholders never become config here — the caller
       decides, and reports anything it could not decide as a
       requirement the user completes in the editor. */
    const requirementsForNode: CredentialRequirement[] = [];
    /* Keyed on the *remapped* id, because that is the id the caller
       sees in `requirements[].key` and is therefore the id it will
       send back as a choice. Keying on the document's own id would
       make every explicit choice silently fail to match. */
    const mappedId = idMap.get(node.id)!;
    for (const field of credentialFields(node.type)) {
      const explicit = context.credentialIds?.[`${mappedId}.${field.key}`];
      const placeholder = node.credentials?.[field.key];
      const chosen =
        explicit ||
        (placeholder
          ? context.findCredential?.({
              nodeId: node.id,
              nodeLabel: node.label ?? definition?.title ?? node.type,
              field: field.key,
              fieldLabel: field.label,
              providers: providersFor(node.type, field),
              name: placeholder.name,
            }) ?? null
          : null) ||
        null;
      if (chosen) config[field.key] = chosen;
      else delete config[field.key];
      requirementsForNode.push({
        key: `${mappedId}.${field.key}`,
        nodeId: mappedId,
        nodeLabel: node.label ?? definition?.title ?? node.type,
        field: field.key,
        fieldLabel: field.label,
        providers: providersFor(node.type, field),
        name: placeholder?.name,
        resolved: Boolean(chosen),
      });
    }

    const ref = typeof node.ref === "string" && node.ref ? node.ref : undefined;
    return {
      node: {
        id: idMap.get(node.id)!,
        type: node.type,
        position: node.position,
        data: { ref, label: node.label, config } as Workflow["nodes"][number]["data"],
      },
      requirements: requirementsForNode,
    };
  });

  const edgeTargets = new Set(portable.nodes.map((node) => idMap.get(node.id)!));
  const edges = portable.edges.map((edge, index) => {
    if (!byPortableId.has(edge.source) || !byPortableId.has(edge.target)) {
      blocking.push(
        issue(
          "edge_missing_dangling",
          "error",
          `Connection ${edge.id} points at a step that is not in the document.`,
          { edgeId: edge.id, hint: "Remove the connection and reconnect the steps." },
        ),
      );
    }
    const target = {
      id: `edge_${index + 1}`,
      source: idMap.get(edge.source) ?? edge.source,
      target: idMap.get(edge.target) ?? edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
      ...(edge.branch ? { data: { branch: edge.branch } } : {}),
    };
    if (!edgeTargets.has(target.source) || !edgeTargets.has(target.target)) {
      /* already reported above; keep the edge out of the graph so
         validation does not double-report it as a structural error */
    }
    return target;
  });

  const triggerNode = nodes.find((entry) => getDefinition(entry.node.type)?.trigger);
  const tags = portable.metadata?.tags ?? [];

  const definition: Workflow = {
    id: context.id,
    name: (context.name ?? portable.name ?? "Imported workflow").slice(
      0,
      PORTABLE_LIMITS.maxNameLength,
    ),
    description: (context.description ?? portable.description ?? "").slice(
      0,
      PORTABLE_LIMITS.maxDescriptionLength,
    ),
    status: "draft",
    tags,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastExecutedAt: null,
    executionCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    triggerType: triggerNode?.node.type ?? portable.trigger.type ?? "trigger.manual",
    nodeCount: nodes.length,
    nodes: nodes.map((entry) => entry.node),
    edges,
  };

  if (blocking.length > 0) {
    fail(422, "IMPORT_UNSUPPORTED", "This definition cannot be imported safely.", blocking);
  }

  /* ---- expression syntax: the same parser the engine runs ---- */
  for (const node of definition.nodes) {
    for (const malformed of findMalformedExpressions(node.data.config)) {
      blocking.push(
        issue(
          "expression_malformed",
          "error",
          `{{${malformed}}} is not a valid expression.`,
          {
            nodeId: node.id,
            hint: "Expressions use the same syntax as the data picker — check for a missing }} or a typo.",
          },
        ),
      );
    }
  }

  /* ---- a definition that would be refused on save must be refused
           here too: import is the one path where the caller is not the
           editor, and a secret pasted into a file must not be the way
           one gets into a draft ---- */
  for (const secret of collectCredentialValueIssues(definition)) {
    blocking.push({
      ...secret,
      hint: "Exports and templates never carry secrets. Choose a stored credential after importing.",
    });
  }

  if (blocking.length > 0) {
    fail(422, "IMPORT_UNSUPPORTED", "This definition cannot be imported safely.", blocking);
  }

  /* ---- the existing validator, unchanged: the same gate the editor
           and the execution API already use ---- */
  const issues = validateWorkflow(definition);
  const structural = issues.filter((candidate) => isBlockingImportIssue([candidate]).length > 0);
  if (structural.length > 0) {
    fail(422, "IMPORT_UNSUPPORTED", "This definition cannot be imported safely.", structural);
  }

  const requirements: CredentialRequirement[] = nodes.flatMap((entry) => entry.requirements);
  for (const candidate of issues) {
    const onCredential = requirements.some(
      (requirement) =>
        requirement.nodeId === candidate.nodeId &&
        candidate.id === `missing_${candidate.nodeId}_${requirement.field}`,
    );
    if (onCredential) continue;
    warnings.push({ ...candidate, severity: "warning" });
  }
  for (const requirement of requirements) {
    if (requirement.resolved) continue;
    warnings.push(
      issue(
        `credential_${requirement.key}`,
        "warning",
        `${requirement.nodeLabel} still needs ${requirement.fieldLabel.toLowerCase()}.`,
        { nodeId: requirement.nodeId, hint: "Pick a credential when you connect the integration." },
      ),
    );
  }

  return { definition, requirements, warnings };
}

/* ------------------------------------------------------------------ */
/* Requirements derived from a definition                              */
/* ------------------------------------------------------------------ */

/** Integration family a node belongs to — used by templates and previews. */
export function integrationForNodeType(type: string): string | null {
  const match = /^([a-z]+)\.([a-z0-9_]+)$/.exec(type);
  if (!match) return null;
  const family = match[1] ?? "";
  const name = match[2] ?? "";
  if (family === "ai") return "ai";
  if (family === "trigger" && (name === "manual" || name === "schedule" || name === "webhook")) {
    return name === "webhook" ? "webhook" : null;
  }
  if (name.startsWith("github") || family === "github") return "github";
  if (name.startsWith("gmail")) return "gmail";
  if (name.startsWith("slack")) return "slack";
  if (name.startsWith("notion")) return "notion";
  if (name.startsWith("sheets")) return "google_sheets";
  if (name === "postgres") return "postgres";
  if (name === "http") return "http";
  return family;
}

/** Sorted, deduplicated integration ids a graph depends on. */
export function integrationsForNodes(nodes: Array<{ type: string }>): string[] {
  const ids = new Set<string>();
  for (const node of nodes) {
    const id = integrationForNodeType(node.type);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/** Credential kinds a graph asks for, deduplicated and sorted. */
export function credentialKindsForNodes(nodes: Array<{ type: string }>): string[] {
  const kinds = new Set<string>();
  for (const node of nodes) {
    for (const kind of getDefinition(node.type)?.credentials ?? []) kinds.add(kind);
  }
  return [...kinds].sort();
}
