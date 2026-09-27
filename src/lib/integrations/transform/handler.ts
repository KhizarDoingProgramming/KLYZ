import { ParseError, parseJsonLike, resolveValue } from "@/lib/engine/resolve";
import { EngineError, type NodeHandler, type NodeRunContext } from "@/lib/engine/types";
import { TRANSFORM_ERRORS, integrationError } from "../errors";
import { applyOperation } from "./operations";

/**
 * Transform handlers.
 *
 * `logic.transform` keeps its original JSON-ish mapping behaviour (moved
 * here from the core handler table so the module owns it); the
 * operations node runs the pure functions in ./operations.ts.
 */
export const transformMappingHandler: NodeHandler = (context: NodeRunContext) => {
  /* The authored mapping still contains `{{…}}` — the outer config pass
     interpolates them as text, which would destroy the JSON structure.
     Parse the raw text (relaxed JSON), then resolve typed values. */
  const authored = context.rawConfig?.mapping;
  const mapping = typeof authored === "string" ? authored : context.config.mapping;
  const text = typeof mapping === "string" ? mapping.trim() : "";
  if (!text) {
    throw new EngineError("CONFIG_INVALID", "The transform needs a mapping.", {
      hint: "Open the step and describe which values to produce.",
    });
  }
  let parsed: unknown;
  try {
    parsed = parseJsonLike(text);
  } catch {
    throw new EngineError("CONFIG_INVALID", "The mapping is not valid JSON.", {
      detail:
        'Use JSON with {{references}} for values, e.g. {"email": {{user.email}}}.',
      hint: "Check the mapping syntax.",
      cause: new ParseError(),
    });
  }
  const value = resolveValue(parsed, context.scope);
  return { output: { value: (value ?? {}) as Record<string, unknown> } };
};

export const operationsHandler: NodeHandler = (context: NodeRunContext) => {
  const operation = String(context.config.operation ?? "").trim();
  if (!operation) {
    throw integrationError(
      TRANSFORM_ERRORS.invalidConfig,
      "This data transform has no operation selected.",
      { hint: "Pick an operation — Filter, Map, Sort, Aggregate …" },
    );
  }

  const result = applyOperation(
    operation,
    context.config,
    context.rawConfig ?? context.config,
    context.config.input ?? null,
    {
      resolveItem: (raw, item, index) =>
        resolveValue(raw, { ...context.scope, item, index }),
      scope: context.scope as Record<string, unknown>,
    },
  );

  return { output: { value: result.value, count: result.count } };
};
