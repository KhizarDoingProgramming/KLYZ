import { createHash } from "node:crypto";
import { NODE_DEFINITIONS } from "@/lib/workflow/registry";
import { sideEffectsFor } from "@/lib/execution/debugger";
import type { CredentialKind, NodeDefinition, OutputField } from "@/lib/workflow/types";

/**
 * The capability catalog — what KLYZ can actually do, derived from the
 * node registry so it cannot drift from the implementation.
 *
 * The model is told about capabilities *only* through this catalog: a
 * node type that is not in `NODE_DEFINITIONS` is not in the catalog, is
 * not in the prompt, and cannot pass validation. Nothing here invents
 * behaviour — every entry is a projection of a registered definition.
 *
 * It is deterministic (same registry → same bytes) so the digest can be
 * used as a cache key and as a version stamp in responses.
 */

export interface CapabilityField {
  key: string;
  label: string;
  kind: string;
  required?: boolean;
  bindable?: boolean;
  /** Select options as `[value, label]` pairs, clipped. */
  options?: Array<[string, string]>;
  /** Short inline example (`{{gmail.body}}`) — shows the expression shape. */
  example?: string;
  help?: string;
}

export interface Capability {
  type: string;
  category: string;
  title: string;
  /** What it does, in one line. */
  purpose: string;
  /** One-line editor summary. */
  summary: string;
  trigger: boolean;
  branches?: string[];
  credentials?: CredentialKind[];
  /** Fields the model must fill for the step to be runnable. */
  requires: CapabilityField[];
  /** Everything else the model may fill. */
  optional: CapabilityField[];
  /** Output keys available as `{{ref.key}}` downstream. */
  outputs: string[];
  /** True when the step changes something outside KLYZ. */
  sideEffect: boolean;
  cost: number;
}

const MAX_TEXT = 200;
const MAX_HELP = 160;
const MAX_OPTIONS = 14;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function outputKeys(outputs: OutputField[], prefix = ""): string[] {
  const keys: string[] = [];
  for (const field of outputs) {
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    keys.push(path);
    if (field.children?.length) keys.push(...outputKeys(field.children, path));
    if (keys.length >= 40) break;
  }
  return keys;
}

function toCapabilityField(
  field: NodeDefinition["fields"][number],
): CapabilityField {
  const mapped: CapabilityField = {
    key: field.key,
    label: clip(field.label, 60),
    kind: field.kind,
  };
  if (field.required) mapped.required = true;
  if (field.bindable) mapped.bindable = true;
  if (field.options?.length) {
    mapped.options = field.options.slice(0, MAX_OPTIONS).map((option) => [
      String(option.value),
      clip(String(option.label), 60),
    ]);
  }
  if (field.placeholder) mapped.example = clip(field.placeholder, 60);
  if (field.help) mapped.help = clip(field.help, MAX_HELP);
  return mapped;
}

/** Node types that write outside KLYZ — conservative: HTTP counts. */
function sideEffectTypes(): Set<string> {
  const set = new Set<string>();
  for (const type of Object.keys(NODE_DEFINITIONS)) {
    const [effect] = sideEffectsFor([{ id: type, type, data: {} }]);
    if (effect) set.add(type);
  }
  /* `action.http` depends on the configured method — flag it regardless,
     so a generated POST is always surfaced at review time. */
  if (set.has("action.http") || NODE_DEFINITIONS["action.http"]) set.add("action.http");
  return set;
}

let cached: Capability[] | null = null;

export function capabilityCatalog(): Capability[] {
  if (cached) return cached;
  const effects = sideEffectTypes();
  const catalog: Capability[] = [];
  for (const type of Object.keys(NODE_DEFINITIONS).sort()) {
    const definition = NODE_DEFINITIONS[type];
    if (!definition) continue;
    const requires = definition.fields.filter((field) => field.required).map(toCapabilityField);
    const optional = definition.fields.filter((field) => !field.required).map(toCapabilityField);
    const capability: Capability = {
      type: definition.type,
      category: definition.category,
      title: definition.title,
      purpose: clip(definition.description, MAX_TEXT),
      summary: clip(definition.summary, MAX_TEXT),
      trigger: definition.trigger === true,
      ...(definition.branches?.length ? { branches: [...definition.branches] } : {}),
      ...(definition.credentials?.length ? { credentials: [...definition.credentials] } : {}),
      requires,
      optional,
      outputs: outputKeys(definition.outputs),
      sideEffect: effects.has(type),
      cost: definition.cost,
    };
    catalog.push(capability);
  }
  cached = catalog;
  return catalog;
}

/** Compact JSON for the prompt — keys are already terse by construction. */
export function capabilityCatalogJson(): string {
  return JSON.stringify(capabilityCatalog());
}

let digest: string | null = null;

/** Stable digest of the catalog: stamped on responses, usable as a cache key. */
export function capabilityDigest(): string {
  if (digest) return digest;
  digest = createHash("sha256").update(capabilityCatalogJson()).digest("hex").slice(0, 16);
  return digest;
}

/** Capability lookup used by validation to explain an unsupported type. */
export function capabilityFor(type: string): Capability | undefined {
  return capabilityCatalog().find((entry) => entry.type === type);
}
