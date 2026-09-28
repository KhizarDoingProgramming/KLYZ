import { randomBytes } from "node:crypto";
import { auditAs } from "./audit";
import { requirePermission } from "./authz";
import { fromJson, now, queryAll, queryOne, run as sqlRun, toJson } from "./db";
import { HttpError, isRecord } from "./http";
import { ensureIdentitySeed, type Actor } from "./identity";
import { portableDefinitionFor, prepareImport, toHttpError } from "./portability";
import { createWorkflowFor, type ServerWorkflow } from "./workflow-service";
import { disarmScheduleTrigger } from "./triggers";
import { SYSTEM_TEMPLATES } from "./template-library";
import { limitByKey } from "./rate-limit";
import {
  PORTABLE_LIMITS,
  credentialKindsForNodes,
  integrationsForNodes,
  parsePortableWorkflow,
  portableFromWorkflow,
  type CredentialRequirement,
  type PortableIssue,
  type PortableWorkflow,
} from "@/lib/workflow/portable";
import { getDefinition } from "@/lib/workflow/registry";

/**
 * Templates — a workspace-scoped library of workflow blueprints.
 *
 * A template *is* a portable workflow document with a name, a category
 * and a summary of what it needs. Storing the same artifact that export
 * produces is the whole design: one schema, one validator, one
 * migration path, and no second definition format to keep in sync.
 *
 * Deliberately not a marketplace. Rows carry a `workspace_id`, so one
 * tenant's library is invisible to another; the built-ins carry the
 * reserved marker `*` (no workspace can hold it — ids are `ws_`
 * prefixed) and are read-only everywhere.
 */

export const TEMPLATE_CATEGORIES = [
  "general",
  "notifications",
  "data",
  "ai",
  "integrations",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const SYSTEM_WORKSPACE = "*";

export interface TemplateView {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  system: boolean;
  nodeCount: number;
  triggerType: string;
  integrations: string[];
  requiredCredentials: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  definition: string;
  node_count: number;
  trigger_type: string;
  integrations: string;
  required_credentials: string;
  system: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/* ------------------------------------------------------------------ */
/* Built-ins                                                           */
/* ------------------------------------------------------------------ */

let systemTemplatesChecked = false;

/**
 * Insert the built-in library once per process.
 *
 * A single existence probe first, so the normal case costs one indexed
 * read instead of five writes; `ON CONFLICT DO NOTHING` keeps two processes
 * racing on first boot idempotent.
 */
export function ensureSystemTemplates(force = false): void {
  if (systemTemplatesChecked && !force) return;
  const existing = queryOne<{ id: string }>(
    "SELECT id FROM templates WHERE system = 1 LIMIT 1",
  );
  if (existing) {
    systemTemplatesChecked = true;
    return;
  }
  const at = now();
  for (const template of SYSTEM_TEMPLATES) {
    const { portable } = portableFromWorkflow(template.definition);
    sqlRun(
      `INSERT INTO templates
         (id, workspace_id, name, description, category, icon, definition, node_count,
          trigger_type, integrations, required_credentials, system, created_by,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
       ON CONFLICT DO NOTHING`,
      template.id,
      SYSTEM_WORKSPACE,
      template.name,
      template.description,
      template.category,
      template.icon,
      toJson(portable) ?? "{}",
      portable.nodes.length,
      triggerTypeOf(portable),
      toJson(integrationsForNodes(portable.nodes)) ?? "[]",
      toJson(credentialKindsForNodes(portable.nodes)) ?? "[]",
      at,
      at,
    );
  }
  systemTemplatesChecked = true;
}

/** Test hook — the next read re-checks whether the built-ins exist. */
export function resetSystemTemplateCache(): void {
  systemTemplatesChecked = false;
}

function triggerTypeOf(portable: PortableWorkflow): string {
  if (portable.trigger.type) return portable.trigger.type;
  return portable.nodes.find((node) => node.type.startsWith("trigger."))?.type ?? "trigger.manual";
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

function toView(row: TemplateRow): TemplateView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    icon: row.icon,
    system: row.system === 1,
    nodeCount: row.node_count,
    triggerType: row.trigger_type,
    integrations: fromJson<string[]>(row.integrations, []),
    requiredCredentials: fromJson<string[]>(row.required_credentials, []),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function rowFor(actor: Actor, id: string): TemplateRow {
  const row = queryOne<TemplateRow>(
    "SELECT * FROM templates WHERE id = ? AND workspace_id IN (?, ?)",
    id,
    actor.workspaceId,
    SYSTEM_WORKSPACE,
  );
  if (!row) {
    throw new HttpError(404, "NOT_FOUND", "That template does not exist.");
  }
  return row;
}

export interface TemplateListOptions {
  category?: string;
  query?: string;
}

export function listTemplatesFor(
  actor: Actor,
  options: TemplateListOptions = {},
): TemplateView[] {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:read");
  ensureSystemTemplates();

  const rows = queryAll<TemplateRow>(
    `SELECT * FROM templates
      WHERE workspace_id IN (?, ?)
      ORDER BY system DESC, updated_at DESC`,
    actor.workspaceId,
    SYSTEM_WORKSPACE,
  );
  const needle = (options.query ?? "").trim().toLowerCase();
  return rows
    .map(toView)
    .filter((template) => {
      if (options.category && options.category !== "all" && template.category !== options.category) {
        return false;
      }
      if (!needle) return true;
      return (
        template.name.toLowerCase().includes(needle) ||
        template.description.toLowerCase().includes(needle) ||
        template.integrations.some((id) => id.includes(needle))
      );
    });
}

export function getTemplateFor(
  actor: Actor,
  id: string,
): { template: TemplateView; portable: PortableWorkflow } {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:read");
  ensureSystemTemplates();
  const row = rowFor(actor, id);
  const portable = fromJson<PortableWorkflow | null>(row.definition, null);
  if (!portable) {
    throw new HttpError(500, "TEMPLATE_UNREADABLE", "That template could not be read.");
  }
  return { template: toView(row), portable };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

function assertWritable(row: TemplateRow): void {
  if (row.system === 1) {
    throw new HttpError(
      422,
      "TEMPLATE_SYSTEM",
      "Built-in templates are read-only — create one to start from it, then edit the workflow.",
    );
  }
}

function assertNotSystemId(id: string): void {
  if (SYSTEM_TEMPLATES.some((template) => template.id === id)) {
    throw new HttpError(
      422,
      "TEMPLATE_SYSTEM",
      "That id belongs to a built-in template.",
    );
  }
}

function assertCapacity(actor: Actor): void {
  const row = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM templates WHERE workspace_id = ?",
    actor.workspaceId,
  );
  if ((row?.n ?? 0) >= PORTABLE_LIMITS.maxTemplatesPerWorkspace) {
    throw new HttpError(
      422,
      "TEMPLATE_LIMIT",
      `A workspace may hold at most ${PORTABLE_LIMITS.maxTemplatesPerWorkspace} templates.`,
    );
  }
}

function normaliseCategory(value: unknown): string {
  const category = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (TEMPLATE_CATEGORIES as readonly string[]).includes(category)
    ? category
    : "general";
}

function writeRow(actor: Actor, templateId: string, portable: PortableWorkflow, meta: {
  name: string;
  description: string;
  category: string;
  icon: string;
}): void {
  const at = now();
  sqlRun(
    `INSERT INTO templates
       (id, workspace_id, name, description, category, icon, definition, node_count,
        trigger_type, integrations, required_credentials, system, created_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    templateId,
    actor.workspaceId,
    meta.name,
    meta.description,
    meta.category,
    meta.icon,
    toJson(portable) ?? "{}",
    portable.nodes.length,
    triggerTypeOf(portable),
    toJson(integrationsForNodes(portable.nodes)) ?? "[]",
    toJson(credentialKindsForNodes(portable.nodes)) ?? "[]",
    actor.userId,
    at,
    at,
  );
}

export interface CreateTemplateInput {
  workflowId?: unknown;
  name?: unknown;
  description?: unknown;
  category?: unknown;
  icon?: unknown;
  definition?: unknown;
}

/**
 * Save a blueprint.
 *
 * From a workflow it is the *draft* that is captured — the published
 * version is a run-time artifact, not the thing a person edits — and it
 * goes through the same exporter a file would, so credentials are
 * reduced to references before anything is written.
 */
export function createTemplateFor(actor: Actor, input: unknown): TemplateView {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:write");
  limitByKey("template:write", actor.workspaceId, 30, 60_000);
  assertCapacity(actor);

  if (!isRecord(input)) {
    throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
  }
  const body = input as CreateTemplateInput;

  const templateId = `tpl_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  assertNotSystemId(templateId);

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, PORTABLE_LIMITS.maxNameLength)
      : undefined;
  const description =
    typeof body.description === "string"
      ? body.description.slice(0, PORTABLE_LIMITS.maxDescriptionLength)
      : undefined;

  let portable: PortableWorkflow;
  if (typeof body.workflowId === "string" && body.workflowId) {
    const projection = portableDefinitionFor(actor, body.workflowId);
    portable = projection.portable;
  } else if (body.definition !== undefined) {
    /* A template body is untrusted input too: parse it with the same
       structural validator an import uses, refuse capabilities this
       build does not have, and store it exactly as given so credential
       placeholders survive the round trip untouched. */
    try {
      const parsed = parsePortableWorkflow(body.definition);
      const unknown = parsed.nodes.filter((node) => !getDefinition(node.type));
      if (unknown.length > 0) {
        throw new HttpError(
          422,
          "IMPORT_UNSUPPORTED",
          "This definition uses steps this build does not have.",
          {
            issues: unknown.map((node) => ({
              id: "capability_unknown_node",
              severity: "error",
              nodeId: node.id,
              message: `This build has no step called "${node.type}".`,
            })),
          },
        );
      }
      portable = name ? { ...parsed, name } : parsed;
    } catch (error) {
      throw toHttpError(error);
    }
  } else {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      "Supply either a workflowId or a portable definition.",
    );
  }

  const meta = {
    name: name ?? portable.name ?? "Untitled template",
    description: description ?? portable.description ?? "",
    category: normaliseCategory(body.category),
    icon:
      typeof body.icon === "string" && body.icon.trim()
        ? body.icon.trim().slice(0, 40)
        : "workflow",
  };

  writeRow(actor, templateId, portable, meta);

  auditAs(actor, "template.created", {
    resourceType: "template",
    resourceId: templateId,
    metadata: {
      name: meta.name,
      category: meta.category,
      nodeCount: portable.nodes.length,
      fromWorkflow: typeof body.workflowId === "string" ? body.workflowId : null,
    },
  });
  return toView(rowFor(actor, templateId));
}

export function updateTemplateFor(actor: Actor, id: string, input: unknown): TemplateView {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:write");
  limitByKey("template:write", actor.workspaceId, 30, 60_000);
  ensureSystemTemplates();
  const row = rowFor(actor, id);
  assertWritable(row);

  if (!isRecord(input)) {
    throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
  }
  const patch = input as Record<string, unknown>;

  const name =
    typeof patch.name === "string" && patch.name.trim()
      ? patch.name.trim().slice(0, PORTABLE_LIMITS.maxNameLength)
      : row.name;
  const description =
    typeof patch.description === "string"
      ? patch.description.slice(0, PORTABLE_LIMITS.maxDescriptionLength)
      : row.description;
  const category = patch.category !== undefined ? normaliseCategory(patch.category) : row.category;
  const icon =
    typeof patch.icon === "string" && patch.icon.trim()
      ? patch.icon.trim().slice(0, 40)
      : row.icon;

  sqlRun(
    `UPDATE templates
        SET name = ?, description = ?, category = ?, icon = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
    name,
    description,
    category,
    icon,
    now(),
    row.id,
    actor.workspaceId,
  );

  auditAs(actor, "template.updated", {
    resourceType: "template",
    resourceId: row.id,
    metadata: { name, category },
  });
  return toView(rowFor(actor, row.id));
}

export function deleteTemplateFor(actor: Actor, id: string): void {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:write");
  limitByKey("template:write", actor.workspaceId, 30, 60_000);
  ensureSystemTemplates();
  const row = rowFor(actor, id);
  assertWritable(row);

  sqlRun("DELETE FROM templates WHERE id = ? AND workspace_id = ?", row.id, actor.workspaceId);
  auditAs(actor, "template.deleted", {
    resourceType: "template",
    resourceId: row.id,
    metadata: { name: row.name },
  });
}

/* ------------------------------------------------------------------ */
/* Create a workflow from a template                                   */
/* ------------------------------------------------------------------ */

export interface TemplateCreation {
  workflow: ServerWorkflow;
  summary: ReturnType<typeof prepareImport>["summary"];
  requirements: CredentialRequirement[];
  warnings: PortableIssue[];
}

/**
 * Turn a blueprint into a draft.
 *
 * Everything that applies to an import applies here — the template body
 * is parsed by the same untrusted-input path, credentials are mapped or
 * left as requirements, nothing is published, and a schedule stays
 * paused. The only difference is where the document came from.
 */
export function createWorkflowFromTemplateFor(
  actor: Actor,
  id: string,
  input: unknown = {},
): TemplateCreation {
  ensureIdentitySeed();
  requirePermission(actor, "workflow:write");
  limitByKey("workflow:from_template", actor.workspaceId, 30, 60_000);
  ensureSystemTemplates();
  const row = rowFor(actor, id);

  if (!isRecord(input)) {
    throw new HttpError(400, "BAD_REQUEST", "A JSON body is required.");
  }
  const body = input as Record<string, unknown>;
  const portable = fromJson<PortableWorkflow | null>(row.definition, null);
  if (!portable) {
    throw new HttpError(500, "TEMPLATE_UNREADABLE", "That template could not be read.");
  }

  const newId = `wf_${randomBytes(9).toString("base64url")}`;
  const prepared = prepareImport(
    actor,
    {
      definition: portable,
      ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim() } : {}),
      ...(body.credentials !== undefined ? { credentials: body.credentials } : {}),
    },
    { id: newId },
  );

  const workflow = createWorkflowFor(actor, { id: newId, definition: prepared.definition });
  disarmScheduleTrigger(workflow.id);

  auditAs(actor, "workflow.created_from_template", {
    resourceType: "workflow",
    resourceId: workflow.id,
    metadata: {
      templateId: row.id,
      templateName: row.name,
      nodeCount: workflow.nodeCount,
      unresolved: prepared.requirements.filter((r) => !r.resolved).length,
    },
  });

  return {
    workflow,
    summary: prepared.summary,
    requirements: prepared.requirements,
    warnings: prepared.warnings,
  };
}
