import { getIntegrationHandler } from "@/lib/integrations/registry";
import { getDefinition } from "@/lib/workflow/registry";
import { ExpressionLexer, ExpressionParser } from "@/lib/workflow/ast";
import { evaluateAST } from "@/lib/workflow/evaluator";
import type { DataScope } from "@/lib/workflow/expressions";
import type { KeyValueEntry } from "@/lib/workflow/types";
import { aiNodeHandlers } from "@/lib/server/ai/nodes";
import { evaluateCondition } from "./conditions";
import { resolveValue } from "./resolve";
import { CancelledError, EngineError, type NodeHandler } from "./types";

/**
 * Operational node handlers.
 *
 * Each handler does real work — parsing, evaluating, storing, waiting —
 * and returns the values later steps can reference. Node types without
 * a handler fail with `NODE_NOT_IMPLEMENTED`: the engine never fakes a
 * green check for work it did not do.
 */

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new CancelledError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveSleep, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function keyValues(value: unknown): KeyValueEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is KeyValueEntry =>
      !!item &&
      typeof item === "object" &&
      typeof (item as KeyValueEntry).key === "string",
  );
}

const DELAY_PRESETS: Record<string, number> = {
  "30s": 30_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
};

const MAX_DELAY_MS = 86_400_000;

/** Real duration for a Delay node, in milliseconds. */
export function delayDurationMs(config: Record<string, unknown>): number {
  const duration = config.duration;
  if (duration === "custom") {
    const raw = Number(config.custom);
    if (!Number.isFinite(raw) || raw < 0) {
      throw new EngineError(
        "CONFIG_INVALID",
        "The custom delay needs a non-negative number of milliseconds.",
        { hint: "Set a duration in the step configuration." },
      );
    }
    return Math.min(raw, MAX_DELAY_MS);
  }
  return DELAY_PRESETS[String(duration)] ?? 0;
}

/* ------------------------------------------------------------------ */
/* Triggers                                                            */
/* ------------------------------------------------------------------ */

const triggerHandler: NodeHandler = (context) => {
  let payload = context.triggerInput;
  if (payload === undefined || payload === null) {
    const sample = context.config.sample;
    if (typeof sample === "string" && sample.trim() !== "") {
      try {
        payload = JSON.parse(sample);
      } catch {
        throw new EngineError(
          "TRIGGER_PAYLOAD_INVALID",
          "The sample payload is not valid JSON.",
          { detail: "Fix the trigger's sample payload before running." },
        );
      }
    } else {
      payload = {};
    }
  }
  return { output: { payload } };
};

/* ------------------------------------------------------------------ */
/* Set values                                                          */
/* ------------------------------------------------------------------ */

const variablesHandler: NodeHandler = (context) => {
  const vars: Record<string, unknown> = {};
  for (const entry of keyValues(context.config.values)) {
    if (!entry.key) continue;
    vars[entry.key] = resolveValue(entry.value, context.scope);
  }
  
  if (!context.scope.variables) {
    context.scope.variables = {};
  }
  Object.assign(context.scope.variables as Record<string, unknown>, vars);

  return { output: { vars } };
};

/* ------------------------------------------------------------------ */
/* Transform                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Condition                                                           */
/* ------------------------------------------------------------------ */

const conditionHandler: NodeHandler = (context) => {
  const left = resolveValue(context.config.left ?? null, context.scope);
  const operator = String(context.config.operator ?? "eq");
  const right = resolveValue(context.config.right ?? null, context.scope);
  const caseSensitive = Boolean(context.config.caseSensitive);

  let result: boolean;
  try {
    result = evaluateCondition({ left, operator, right, caseSensitive });
  } catch (error) {
    throw new EngineError(
      "CONDITION_INVALID",
      error instanceof Error ? error.message : "The condition could not be evaluated.",
      { hint: "Check the operator and values in the step.", cause: error },
    );
  }

  return {
    output: {
      result,
      matchedBranch: result ? "true" : "false",
    },
    branch: result ? "true" : "false",
  };
};

/* ------------------------------------------------------------------ */
/* Delay / wait                                                        */
/* ------------------------------------------------------------------ */

const delayHandler: NodeHandler = async (context) => {
  const ms = delayDurationMs(context.config);
  context.publishStatus("waiting");
  try {
    await abortableSleep(ms, context.signal);
  } finally {
    if (!context.signal.aborted) context.publishStatus("running");
  }
  return { output: { resumedAt: new Date().toISOString() } };
};

/* ------------------------------------------------------------------ */
/* Log                                                                 */
/* ------------------------------------------------------------------ */

const LOG_LEVELS = new Set(["info", "warn", "error"]);

const logHandler: NodeHandler = (context) => {
  const raw = context.config.message;
  const message =
    typeof raw === "string"
      ? raw
      : raw === undefined || raw === null
        ? ""
        : JSON.stringify(raw);
  const levelRaw = String(context.config.level ?? "info");
  const level = LOG_LEVELS.has(levelRaw) ? levelRaw : "info";
  // A log entry is a record on the execution — later steps can read it.
  return { output: { message, level, loggedAt: new Date().toISOString() } };
};

const transformHandler: NodeHandler = (context) => {
  const source = resolveValue(context.config.source, context.scope);
  const operations = keyValues(context.config.operations);

  let result: unknown = Array.isArray(source) ? [...source] : typeof source === 'object' && source ? { ...source } : source;

  // Simple declarative transform: if it's an array, map over it using the operations as a new shape.
  // If it's an object, apply the operations to it.
  if (Array.isArray(result) && operations.length > 0) {
    result = result.map(item => {
      const newItem: Record<string, unknown> = {};
      const itemScope = { ...context.scope, item };
      for (const op of operations) {
        if (!op.key) continue;
        newItem[op.key] = resolveValue(op.value, itemScope);
      }
      return newItem;
    });
  } else if (typeof result === 'object' && result !== null && operations.length > 0) {
    const newItem: Record<string, unknown> = {};
    const itemScope = { ...context.scope, item: result };
    for (const op of operations) {
      if (!op.key) continue;
      newItem[op.key] = resolveValue(op.value, itemScope);
    }
    result = newItem;
  }

  return { output: { result } };
};

const switchHandler: NodeHandler = (context) => {
  const value = resolveValue(context.config.value, context.scope);
  const cases = keyValues(context.config.cases);

  let matchedCase = "fallback";
  for (const c of cases) {
    // Treat the case value as a string comparison for simplicity, or evaluate it
    const caseValue = resolveValue(c.value, context.scope);
    if (value === caseValue) {
      matchedCase = c.key;
      break;
    }
  }

  return {
    output: { matchedCase },
    branch: matchedCase,
  };
};

/* ------------------------------------------------------------------ */
/* Filter                                                              */
/* ------------------------------------------------------------------ */

const TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Evaluates a Filter expression against the run scope.
 *
 * The field is authored as `{{payload.email}} != null` — a template
 * wrapper around a real expression. The wrappers become parentheses so
 * the shared lexer/parser sees one expression tree instead of a string
 * that was already interpolated into meaningless text.
 */
function evaluateFilterExpression(raw: unknown, scope: DataScope): boolean {
  const source = typeof raw === "string" ? raw.trim() : "";
  if (!source) {
    throw new EngineError("CONFIG_INVALID", "The filter needs an expression.", {
      hint: "Set “Keep when” to the condition that lets data through.",
    });
  }
  const parsed = source.replace(TEMPLATE, "($1)");
  let value: unknown;
  try {
    const ast = new ExpressionParser(new ExpressionLexer(parsed).lex()).parse();
    value = evaluateAST(ast, scope);
  } catch (error) {
    throw new EngineError(
      "CONDITION_INVALID",
      error instanceof Error ? error.message : "The filter expression could not be evaluated.",
      {
        detail: "Check the operators and references in “Keep when”.",
        hint: "Pick values from the data picker instead of typing paths by hand.",
        cause: error,
      },
    );
  }
  return Boolean(value);
}

const filterHandler: NodeHandler = (context) => {
  const passed = evaluateFilterExpression(context.rawConfig.expression, context.scope);
  const output = { passed };
  if (passed) return { output };
  const onSkip = String(context.config.onSkip ?? "skip");
  if (onSkip === "stop") return { output, stop: true };
  return { output, skipped: true };
};

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

const jsonHandler: NodeHandler = (context) => {
  const mode = String(context.config.mode ?? "parse");
  const source = context.config.source;

  if (mode === "stringify") {
    let text: string;
    try {
      text = JSON.stringify(source ?? null) ?? "null";
    } catch (error) {
      throw new EngineError("CONFIG_INVALID", "This value cannot be serialised to JSON.", {
        detail: error instanceof Error ? error.message : undefined,
        hint: "Remove circular references before serialising.",
        cause: error,
      });
    }
    return { output: { value: text } };
  }

  if (typeof source !== "string") {
    throw new EngineError("CONFIG_INVALID", "JSON parsing needs text input.", {
      detail: `The input resolved to ${source === null || source === undefined ? "nothing" : typeof source}.`,
      hint: "Point “Input” at a step that produces a string, or switch the mode to serialise.",
    });
  }
  try {
    return { output: { value: JSON.parse(source) } };
  } catch (error) {
    throw new EngineError("CONFIG_INVALID", "The input is not valid JSON.", {
      detail: error instanceof Error ? error.message : undefined,
      hint: "Check the text being parsed, or switch the mode to serialise.",
      cause: error,
    });
  }
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const HANDLERS: Record<string, NodeHandler> = {
  "data.variables": variablesHandler,
  "data.transform": transformHandler,
  "data.json": jsonHandler,
  "logic.condition": conditionHandler,
  "logic.switch": switchHandler,
  "logic.filter": filterHandler,
  "logic.delay": delayHandler,
  "action.log": logHandler,
  ...aiNodeHandlers,
};

export function getHandler(nodeType: string): NodeHandler | undefined {
  /* Integration modules own their nodes — the registry wins over the
     core handlers so connectors never fork behaviour in this file. */
  const integration = getIntegrationHandler(nodeType);
  if (integration) return integration;
  if (HANDLERS[nodeType]) return HANDLERS[nodeType];
  if (getDefinition(nodeType)?.trigger) return triggerHandler;
  return undefined;
}

export function missingHandlerError(nodeType: string): EngineError {
  const definition = getDefinition(nodeType);
  const title = definition?.title ?? nodeType;
  return new EngineError(
    "NODE_NOT_IMPLEMENTED",
    `"${title}" has no execution handler yet`,
    {
      detail:
        "This step type is not runnable in the local engine, so the execution stopped here instead of pretending to succeed.",
      hint: "Remove or replace this step to complete the run.",
      remediation: { label: "Inspect configuration", kind: "inspect" },
    },
  );
}
