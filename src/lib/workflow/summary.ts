import { getDefinition } from "./registry";
import { containsExpression } from "./expressions";
import type { ConfigField } from "./types";

interface SummaryLine {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}

const OPERATOR_TEXT: Record<string, string> = {
  eq: "equals",
  neq: "not equal to",
  contains: "contains",
  gt: "greater than",
  lt: "less than",
  exists: "exists",
  matches: "matches",
};

function clip(value: string, max = 40): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function display(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) {
    const keys = value
      .map((entry) => String((entry as { key?: string }).key ?? ""))
      .filter(Boolean);
    if (keys.length > 0) return keys.join(", ");
    return `${value.length} entries`;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * The 2–3 lines shown inside a node. They answer "what is this step
 * actually configured to do?" without opening the inspector.
 */
export function summarizeNode(
  type: string,
  config: Record<string, unknown>,
): SummaryLine[] {
  const definition = getDefinition(type);
  if (!definition) return [];

  if (type === "logic.condition") {
    const operator = OPERATOR_TEXT[String(config.operator ?? "eq")] ?? "equals";
    const left = display(config.left) || "value";
    const right = display(config.right);
    return [
      {
        label: "Rule",
        value: right ? `${left} ${operator} ${right}` : `${left} ${operator}`,
        mono: true,
      },
    ];
  }

  if (type === "action.http") {
    const method = String(config.method ?? "GET");
    const url = display(config.url) || "https://…";
    return [{ label: method, value: url, mono: true }];
  }

  if (type === "action.postgres" || type === "data.postgres") {
    const firstLine = display(config.query).split("\n")[0] ?? "";
    if (firstLine) return [{ label: "Query", value: firstLine, mono: true }];
  }

  if (type === "logic.transform" || type === "data.json") {
    const source = display(config.mapping ?? config.source);
    if (source) return [{ label: "Mapping", value: source.split("\n")[0] ?? "", mono: true }];
  }

  const lines: SummaryLine[] = [];
  const candidates = definition.fields.filter((field) => isSummaryField(field));

  for (const field of candidates) {
    if (lines.length >= 2) break;
    const raw = config[field.key];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = display(raw);
    if (!value) continue;

    lines.push({
      label: field.label,
      value: clip(value, field.kind === "expression" ? 34 : 30),
      mono: field.mono || field.kind === "expression" || containsExpression(value),
    });
  }

  if (lines.length === 0 && definition.category === "trigger") {
    lines.push({ label: "Trigger", value: definition.summary, muted: true });
  }

  return lines;
}

const DEPRIORITISED: ConfigField["kind"][] = ["textarea", "code", "keyvalue", "toggle"];

function isSummaryField(field: ConfigField): boolean {
  if (field.key === "auth" || field.key === "timeout" || field.key === "readMode") return false;
  return !DEPRIORITISED.includes(field.kind);
}
