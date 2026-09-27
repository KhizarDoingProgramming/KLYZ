import { randomBytes } from "node:crypto";
import { auditAs } from "./audit";
import { can, requirePermission, assertWorkflowVersionAccess } from "./authz";
import { queryAll, queryOne } from "./db";
import { getDraftDefinitionFor, createWorkflowFor, type ServerWorkflow } from "./workflow-service";
import { disarmScheduleTrigger } from "./triggers";
import { HttpError, isRecord } from "./http";
import { ensureIdentitySeed, type Actor, type Role } from "./identity";
import {
  PORTABLE_LIMITS,
  PORTABLE_FORMAT,
  PORTABLE_VERSION,
  PortableFormatError,
  credentialKindsForNodes,
  integrationsForNodes,
  parsePortableWorkflow,
  portableFromWorkflow,
  portableToWorkflow,
  type CredentialRequirement,
  type PortableIssue,
  type PortableWorkflow,
} from "@/lib/workflow/portable";
import type { Workflow } from "@/lib/workflow/types";

/**
 * Export, import and the rules that keep them honest.
 *
 * The pure half of portability lives in `workflow/portable.ts` — it
 * knows about graphs, node capabilities and the format version, and it
 * touches no state. This module is the half that has state: it decides
 * *who* may export, *which* credential a placeholder maps to, *when*
 * the draft is actually written, and what gets audited.
 *
 * Two invariants are worth stating out loud because everything else
 * follows from them:
 *
 *  - **Import writes a draft, nothing else.** No version is minted, no
 *    execution starts, no trigger is armed — a schedule created from a
 *    file starts paused for the same reason a duplicated one does.
 *  - **The server is the only writer.** The client posts a document and
 *    gets back the server's copy; it never inserts a workflow row.
 */

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export interface WorkflowExport {
  portable: PortableWorkflow;
  filename: string;
  source: "draft" | "version";
  nodeCount: number;
  warnings: PortableIssue[];
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "workflow";
}

/**
 * Credential references become `{provider, name}` — the two things an
 * importing workspace needs in order to *recognise* a credential, and
 * neither of which is secret. Callers without `credential:read` get no
 * mapping at all rather than a partial one: a viewer should not learn
 * credential names by exporting a graph.
 */
function credentialResolver(actor: Actor, role: Role) {
  if (!can(role, "credential:read")) return undefined;
  return (credentialId: string): { provider: string; name: string } | null => {
    const row = queryOne<{ kind: string; name: string }>(
      "SELECT kind, name FROM credentials WHERE id = ? AND workspace_id = ?",
      credentialId,
      actor.workspaceId,
    );
    return row ? { provider: row.kind, name: row.name } : null;
  };
}

function definitionForExport(
  actor: Actor,
  id: string,
  versionId?: string,
): { definition: Workflow; source: "draft" | "version" } {
  if (!versionId) {
    return { definition: getDraftDefinitionFor(actor, id), source: "draft" };
  }
  const version = assertWorkflowVersionAccess(actor, versionId, "workflow:read");
  if (version.workflowId !== id) {
    throw new HttpError(404, "NOT_FOUND", "That workflow version does not exist.");
  }
  const row = queryOne<{ definition: string }>(
    "SELECT definition FROM workflow_versions WHERE id = ? AND workspace_id = ?",
    version.id,
    actor.workspaceId,
  );
  if (!row) {
    throw new HttpError(404, "NOT_FOUND", "That workflow version does not exist.");
  }
  let parsed: Workflow;
  try {
    parsed = JSON.parse(row.definition) as Workflow;
  } catch {
    throw new HttpError(500, "EXPORT_FAILED", "That version could not be read back.");
  }
  /* The version itself is never touched — only the projection's id
     field is normalised so the document names its workflow. */
  return { definition: { ...parsed, id }, source: "version" };
}

/**
 * The projection itself, without an audit row — shared with
 * "save as template", which is a read that produces a stored artifact
 * rather than a file leaving the workspace.
 *
 * Deterministic: the same definition always produces the same bytes, so
 * two exports of an unchanged workflow diff clean.
 */
export function portableDefinitionFor(
  actor: Actor,
  id: string,
  options: { versionId?: string } = {},
): { portable: PortableWorkflow; warnings: PortableIssue[]; source: "draft" | "version" } {
  ensureIdentitySeed();
  const role = requirePermission(actor, "workflow:read");
  const { definition, source } = definitionForExport(actor, id, options.versionId);
  const { portable, warnings } = portableFromWorkflow(definition, {
    resolveCredential: credentialResolver(actor, role),
  });
  return { portable, warnings, source };
}

/**
 * Project a workflow (draft or one immutable version) into a file.
 *
 * Writes the `workflow.exported` audit row: an export is bytes leaving
 * the workspace, and that is worth a line in the log even though the
 * bytes are sanitised.
 */
export function exportWorkflowFor(
  actor: Actor,
  id: string,
  options: { versionId?: string } = {},
): WorkflowExport {
  const { portable, warnings, source } = portableDefinitionFor(actor, id, options);

  auditAs(actor, "workflow.exported", {
    resourceType: "workflow",
    resourceId: id,
    metadata: {
      name: portable.name,
      source,
      nodeCount: portable.nodes.length,
      warnings: warnings.length,
    },
  });

  return {
    portable,
    filename: `${slugify(portable.name)}.klyz.json`,
    source,
    nodeCount: portable.nodes.length,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Credential mapping                                                  */
/* ------------------------------------------------------------------ */

function readCredentialChoices(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    throw new HttpError(400, "BAD_REQUEST", "credentials must be an object.");
  }
  const choices: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
      throw new HttpError(400, "BAD_ID", "That credential is not valid.");
    }
    choices[key] = value;
  }
  return choices;
}

function assertChoiceFits(
  actor: Actor,
  key: string,
  credentialId: string,
  requirement: CredentialRequirement,
): void {
  const row = queryOne<{ kind: string }>(
    "SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?",
    credentialId,
    actor.workspaceId,
  );
  if (!row) {
    /* Another tenant's credential id is indistinguishable from a typo. */
    throw new HttpError(404, "NOT_FOUND", "That credential does not exist.");
  }
  if (requirement.providers.length > 0 && !requirement.providers.includes(row.kind)) {
    throw new HttpError(
      422,
      "CREDENTIAL_KIND_MISMATCH",
      `"${requirement.fieldLabel}" needs one of: ${requirement.providers.join(", ")}.`,
      { key, providers: requirement.providers, actual: row.kind },
    );
  }
}

/**
 * Auto-mapping for a placeholder the exporter left behind.
 *
 * Only an exact `kind` + `name` match maps, and only when it is
 * unambiguous. Guessing "the workspace has one GitHub credential, it is
 * probably the right one" is how a workflow ends up posting to somebody
 * else's channel — so anything else stays unresolved and surfaces as a
 * requirement the user completes.
 */
export function autoMapCredential(
  actor: Actor,
  requirement: Omit<CredentialRequirement, "resolved" | "key">,
): string | null {
  if (!requirement.providers.length || !requirement.name) return null;
  const placeholders = requirement.providers.map(() => "?").join(",");
  const rows = queryAll<{ id: string; name: string }>(
    `SELECT id, name FROM credentials
      WHERE workspace_id = ? AND kind IN (${placeholders})`,
    actor.workspaceId,
    ...requirement.providers,
  );
  const matches = rows.filter((row) => row.name === requirement.name);
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export interface ImportInput {
  definition: unknown;
  name?: string;
  description?: string;
  /** Validate and summarise without writing anything. */
  dryRun?: boolean;
  credentials?: unknown;
}

export interface ImportSummary {
  name: string;
  description: string;
  triggerType: string;
  nodeCount: number;
  edgeCount: number;
  integrations: string[];
  credentialKinds: string[];
  steps: Array<{ id: string; type: string; label: string }>;
}

export interface PreparedImport {
  definition: Workflow;
  requirements: CredentialRequirement[];
  warnings: PortableIssue[];
  summary: ImportSummary;
  id: string;
}

function summarise(definition: Workflow): ImportSummary {
  return {
    name: definition.name,
    description: definition.description ?? "",
    triggerType: definition.triggerType,
    nodeCount: definition.nodes.length,
    edgeCount: definition.edges.length,
    integrations: integrationsForNodes(definition.nodes),
    credentialKinds: credentialKindsForNodes(definition.nodes),
    steps: definition.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: String(node.data?.label ?? ""),
    })),
  };
}

/**
 * Parse, prove and map an untrusted document — without writing it.
 *
 * Shared by the import route, the template route and any future caller
 * that needs to show a user what they are about to accept. The order
 * matters: parse, prove capabilities, map credentials, re-apply the
 * save-time secret policy, run the existing validator. A failure at any
 * step leaves the workspace exactly as it was.
 */
export function prepareImport(
  actor: Actor,
  input: unknown,
  options: { id: string },
): PreparedImport {
  try {
    return prepareImportInner(actor, input, options);
  } catch (error) {
    throw toHttpError(error);
  }
}

function prepareImportInner(
  actor: Actor,
  input: unknown,
  options: { id: string },
): PreparedImport {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:write");

  if (!isRecord(input)) {
    throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
  }
  const body = input as Record<string, unknown>;
  if (body.definition === undefined) {
    throw new HttpError(400, "BAD_REQUEST", "A portable workflow definition is required.");
  }
  const encoded = JSON.stringify(body.definition);
  if (encoded.length > PORTABLE_LIMITS.maxBytes) {
    throw new HttpError(
      413,
      "IMPORT_TOO_LARGE",
      `The definition is larger than ${Math.round(PORTABLE_LIMITS.maxBytes / 1024)} KB.`,
    );
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    throw new HttpError(400, "BAD_REQUEST", "name must be a string.");
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    throw new HttpError(400, "BAD_REQUEST", "description must be a string.");
  }

  const choices = readCredentialChoices(body.credentials);

  /* A choice can only be checked against a requirement, and
     requirements only exist once the document has been read — so read
     it once for its shape, prove the choices, then build for real. */
  parsePortableWorkflow(body.definition);
  const probe = portableToWorkflow(body.definition, { id: options.id });
  const requirementIndex = new Map(probe.requirements.map((r) => [r.key, r]));

  const credentialIds: Record<string, string> = {};
  for (const [key, credentialId] of Object.entries(choices)) {
    const requirement = requirementIndex.get(key);
    if (!requirement) {
      throw new HttpError(
        422,
        "CREDENTIAL_UNKNOWN_FIELD",
        `"${key}" is not a credential field in this workflow.`,
        { key },
      );
    }
    assertChoiceFits(actor, key, credentialId, requirement);
    credentialIds[key] = credentialId;
  }

  const result = portableToWorkflow(body.definition, {
    id: options.id,
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.description === "string" ? { description: body.description } : {}),
    credentialIds,
    findCredential: (requirement) => autoMapCredential(actor, requirement),
  });

  return {
    definition: result.definition,
    requirements: result.requirements,
    warnings: result.warnings,
    summary: summarise(result.definition),
    id: options.id,
  };
}

export interface ImportOutcome {
  workflow: ServerWorkflow | null;
  summary: ImportSummary;
  requirements: CredentialRequirement[];
  warnings: PortableIssue[];
}

export function importWorkflowFor(actor: Actor, input: unknown): ImportOutcome {
  const body = isRecord(input) ? (input as Record<string, unknown>) : {};
  const dryRun = body.dryRun === true;
  const id = `wf_${randomBytes(9).toString("base64url")}`;

  const prepared = prepareImport(actor, input, { id: dryRun ? "wf_preview" : id });
  if (dryRun) {
    return {
      workflow: null,
      summary: prepared.summary,
      requirements: prepared.requirements,
      warnings: prepared.warnings,
    };
  }

  const workflow = createWorkflowFor(actor, { id, definition: prepared.definition });
  /* Publishing keeps the enable switch it finds, so a schedule that
     arrived from a file would start firing the moment anyone published
     it. Imported schedules start paused. */
  disarmScheduleTrigger(workflow.id);

  auditAs(actor, "workflow.imported", {
    resourceType: "workflow",
    resourceId: workflow.id,
    metadata: {
      name: workflow.name,
      nodeCount: workflow.nodeCount,
      trigger: workflow.triggerType,
      integrations: prepared.summary.integrations.slice(0, 8),
      unresolved: prepared.requirements.filter((r) => !r.resolved).length,
      warnings: prepared.warnings.length,
      format: PORTABLE_FORMAT,
      formatVersion: PORTABLE_VERSION,
    },
  });

  return {
    workflow,
    summary: prepared.summary,
    requirements: prepared.requirements,
    warnings: prepared.warnings,
  };
}

/**
 * The pure parser reports failures with its own error type so it can be
 * used without a request context. Routes translate it here, in one
 * place, instead of remembering to do it at every call site.
 */
export function toHttpError(error: unknown): unknown {
  if (error instanceof PortableFormatError) {
    return new HttpError(error.status, error.code, error.message, {
      issues: error.issues,
    });
  }
  return error;
}

export { PortableFormatError };
