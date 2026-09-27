import type { ValidationIssue, Workflow } from "@/lib/workflow/types";

/**
 * Config keys that carry a secret rather than a setting.
 *
 * Shared by the save-time refusal in `workflow-service` and the export
 * gate below, so a value that is rejected on the way *in* can never
 * leave on the way *out*.
 */
export const SECRET_KEY_RE =
  /^(secret|token|apikey|api_key|access_token|refresh_token|password|passphrase|privatekey|private_key|clientsecret|client_secret|credential_value)$/i;

export const MASKED_VALUE_RE = /^[\s*•·x#]+$/i;

/**
 * Does this key/value pair look like a raw credential?
 *
 * Three things are deliberately *not* secrets: a masked value
 * (`••••••`), an expression that resolves at run time, and an empty
 * string. The webhook trigger's own `secret` field is handled by
 * `stripWebhookSecrets` before this is ever consulted.
 */
export function looksLikeSecret(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.length < 4) return false;
  if (!SECRET_KEY_RE.test(key)) return false;
  if (MASKED_VALUE_RE.test(value)) return false;
  if (value.includes("{{")) return false;
  return true;
}

/**
 * Definition sanitising before storage.
 *
 * The webhook node's `secret` field is how the editor *submits* a
 * secret; it must never be persisted (workflow versions are readable
 * through the API). The secret lives encrypted in the `webhooks` table —
 * this strips it from every definition that is about to be versioned or
 * hashed, so rotating a secret never bumps the workflow version either.
 */
export function stripWebhookSecrets(definition: Workflow): Workflow {
  let changed = false;
  const nodes = definition.nodes.map((node) => {
    if (node.type !== "trigger.webhook") return node;
    const config = node.data?.config;
    if (!config || typeof config !== "object") return node;
    const secret = (config as Record<string, unknown>).secret;
    if (typeof secret !== "string" || secret === "") return node;
    changed = true;
    return {
      ...node,
      data: {
        ...node.data,
        config: { ...(config as Record<string, unknown>), secret: "" },
      },
    };
  });
  return changed ? { ...definition, nodes } : definition;
}

/**
 * Drop the run-time colours the canvas paints onto nodes and edges.
 *
 * `KlyzNodeData.status` and `KlyzEdgeData.status` are documented as
 * runtime-only. They are stripped before a definition is written so a
 * finished run can never change the definition's hash and mint a
 * spurious version.
 */
export function stripRuntimeState(definition: Workflow): Workflow {
  const nodes = definition.nodes.map((node) =>
    node.data && node.data.status !== undefined
      ? { ...node, data: { ...node.data, status: undefined } }
      : node,
  );
  const edges = definition.edges.map((edge) =>
    edge.data && edge.data.status !== undefined
      ? { ...edge, data: { ...edge.data, status: undefined } }
      : edge,
  );
  return { ...definition, nodes, edges };
}

/**
 * Every config value that would put a secret inside a definition.
 *
 * Pure so the import gate can run the *same* policy the save gate does
 * without importing server code — one rule, two boundaries.
 */
export function collectCredentialValueIssues(definition: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of definition.nodes) {
    const config = node.data?.config;
    if (!config || typeof config !== "object") continue;
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      if (node.type === "trigger.webhook" && key.toLowerCase() === "secret") continue;
      if (!looksLikeSecret(key, value)) continue;
      issues.push({
        id: `credential_value_${node.id}_${key}`,
        severity: "error",
        nodeId: node.id,
        message: `Step "${node.data?.label ?? node.id}" stores a credential value directly.`,
        hint: "Pick a saved credential instead of pasting the secret here.",
      });
    }
  }
  return issues;
}
