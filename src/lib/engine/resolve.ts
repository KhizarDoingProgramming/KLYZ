import {
  interpolate,
  type DataScope,
} from "@/lib/workflow/expressions";

/**
 * Value-preserving template resolution for the engine.
 *
 * The editor's `interpolate` returns strings (preview-only). Execution
 * needs types: a field that is exactly one `{{reference}}` yields the
 * raw value (object, number, boolean), while a string that merely
 * embeds references is interpolated as text. Nothing here ever evals
 * code — references resolve against the run scope only.
 */

const FULL_EXPRESSION = /^\{\{\s*([^}]+?)\s*\}\}$/;

import { ExpressionLexer, ExpressionParser } from "@/lib/workflow/ast";
import { evaluateAST } from "@/lib/workflow/evaluator";

export function resolveValue(value: unknown, scope: DataScope): unknown {
  if (typeof value === "string") {
    const full = value.match(FULL_EXPRESSION);
    if (full?.[1]) {
      try {
        const lexer = new ExpressionLexer(full[1].trim());
        const tokens = lexer.lex();
        const parser = new ExpressionParser(tokens);
        const ast = parser.parse();
        const resolved = evaluateAST(ast, scope);
        return resolved === undefined ? null : resolved;
      } catch (e) {
        throw new Error(`Failed to evaluate expression "{{${full[1]}}}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return interpolate(value, scope);
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, scope));
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      next[key] = resolveValue(item, scope);
    }
    return next;
  }
  return value;
}

export function resolveConfig(
  config: Record<string, unknown>,
  scope: DataScope,
): Record<string, unknown> {
  return resolveValue(config, scope) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Tolerant JSON-ish parsing (the Transform node's mapping field)      */
/* ------------------------------------------------------------------ */

/**
 * Accepts real JSON plus the relaxed form shown in the editor's
 * placeholder: unquoted keys and unquoted `{{expressions}}` as values.
 * Expressions are quoted before parsing, then resolved afterwards by
 * `resolveValue` — so `"email": {{user.email}}` yields a real value.
 */
export function parseJsonLike(text: string): unknown {
  const prepared = text
    // bare keys: { email: … } or , name: …
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":')
    // bare expression values: "key": {{path.to.value}}
    .replace(/("(?:[^"\\]|\\.)*"\s*:\s*)(\{\{[^}]+\}\})/g, '$1"$2"')
    // expression at top of an array: [ {{a}}, {{b}} ]
    .replace(/(\[\s*)(\{\{[^}]+\}\})/g, '$1"$2"')
    .replace(/(,\s*)(\{\{[^}]+\}\})/g, '$1"$2"');

  try {
    return JSON.parse(prepared);
  } catch {
    throw new ParseError();
  }
}

export class ParseError extends Error {
  constructor() {
    super("The value could not be parsed as JSON.");
    this.name = "ParseError";
  }
}
