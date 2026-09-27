/**
 * Expression / data-mapping layer.
 *
 * Users reference upstream output with `{{ nodeRef.path.to.value }}`.
 * This module parses, validates and resolves those references. It is the
 * same code the config panel, the data picker and (later) the execution
 * engine will share — so what you see while editing is what runs.
 */

const EXPRESSION_RE = /\{\{\s*([^}]+?)\s*\}\}/g;



export function containsExpression(value: string): boolean {
  EXPRESSION_RE.lastIndex = 0;
  return EXPRESSION_RE.test(value);
}

/** A scope maps a node's `ref` to the output that node produced. */
export type DataScope = Record<string, unknown>;

export function resolvePath(scope: DataScope, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cursor: unknown = scope;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

import { ExpressionLexer, ExpressionParser, type ASTNode } from "./ast";
import { evaluateAST } from "./evaluator";

/** Replaces every `{{…}}` with its resolved value (demo + preview only). */
export function interpolate(template: string, scope: DataScope): string {
  return template.replace(EXPRESSION_RE, (_full, path: string) => {
    try {
      const lexer = new ExpressionLexer(path.trim());
      const tokens = lexer.lex();
      const parser = new ExpressionParser(tokens);
      const ast = parser.parse();
      const value = evaluateAST(ast, scope);
      if (value === undefined || value === null) return "";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    } catch (e) {
      // Fallback or error handling
      console.warn("Expression evaluation failed:", e);
      return "";
    }
  });
}

/**
 * Validates references against the set of node refs that are actually
 * upstream of the current node. Returns paths that cannot resolve.
 */
export function findBrokenRefs(value: unknown, availableRefs: Set<string>): string[] {
  const broken: string[] = [];

  const visitAst = (node: ASTNode) => {
    if (node.type === 'Path') {
      const root = node.path.split('.')[0]?.split('[')[0];
      if (root && !availableRefs.has(root) && root !== 'trigger' && root !== 'context') {
        broken.push(node.path);
      }
    } else if (node.type === 'BinaryExpression') {
      visitAst(node.left);
      visitAst(node.right);
    } else if (node.type === 'UnaryExpression') {
      visitAst(node.argument);
    } else if (node.type === 'FunctionCall') {
      node.args.forEach(visitAst);
    }
  };

  const visit = (input: unknown): void => {
    if (typeof input === "string") {
      EXPRESSION_RE.lastIndex = 0;
      for (const match of input.matchAll(EXPRESSION_RE)) {
        const raw = match[1];
        if (raw) {
          try {
            const lexer = new ExpressionLexer(raw.trim());
            const parser = new ExpressionParser(lexer.lex());
            visitAst(parser.parse());
          } catch {
            // Ignore parse errors here; they will be handled during execution.
            // But we could optionally push the raw as broken.
          }
        }
      }
      return;
    }
    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }
    if (input && typeof input === "object") {
      Object.values(input as Record<string, unknown>).forEach(visit);
    }
  };
  visit(value);
  return broken;
}

/**
 * Syntax check for `{{ … }}` expressions.
 *
 * `findBrokenRefs` deliberately ignores parse errors — a half-written
 * expression in the editor should not turn into a wall of red. Import
 * is the opposite case: the definition came from outside, nothing will
 * "fix it up" as the user types, and an expression the engine cannot
 * parse must be reported before the workflow is created rather than
 * discovered when a run fails.
 */
export function findMalformedExpressions(value: unknown): string[] {
  const malformed: string[] = [];

  const visit = (input: unknown): void => {
    if (typeof input === "string") {
      EXPRESSION_RE.lastIndex = 0;
      for (const match of input.matchAll(EXPRESSION_RE)) {
        const raw = match[1];
        if (!raw) continue;
        try {
          const lexer = new ExpressionLexer(raw.trim());
          const parser = new ExpressionParser(lexer.lex());
          parser.parse();
        } catch {
          malformed.push(raw.trim());
        }
      }
      return;
    }
    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }
    if (input && typeof input === "object") {
      Object.values(input as Record<string, unknown>).forEach(visit);
    }
  };

  visit(value);
  return malformed;
}
