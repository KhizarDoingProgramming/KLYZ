/**
 * Structured condition evaluation.
 *
 * Conditions are plain data (left / operator / right), evaluated here —
 * never eval'd as code. Groups (`all` / `any`) are the shape the config
 * panel can grow into; a bare single condition is treated as an `all`
 * group of one.
 */

export const CONDITION_OPERATORS = [
  "eq",
  "neq",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "notExists",
  "matches",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface Condition {
  left: unknown;
  operator: ConditionOperator | string;
  right?: unknown;
  caseSensitive?: boolean;
}

export interface ConditionGroup {
  combinator: "all" | "any";
  conditions: Condition[];
}

export class ConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConditionError";
  }
}

const MAX_PATTERN_LENGTH = 200;

function asComparableString(value: unknown, caseSensitive: boolean): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return caseSensitive ? text : text.toLowerCase();
}

function looseEquals(left: unknown, right: unknown, caseSensitive: boolean): boolean {
  if (left === null || left === undefined) {
    return right === null || right === undefined;
  }
  if (right === null || right === undefined) return false;
  if (typeof left === "number" || typeof right === "number") {
    const a = Number(left);
    const b = Number(right);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      return asComparableString(left, caseSensitive) === asComparableString(right, caseSensitive);
    }
    return a === b;
  }
  if (typeof left === "boolean" || typeof right === "boolean") {
    return Boolean(left) === Boolean(right);
  }
  if (typeof left === "string" || typeof right === "string") {
    return asComparableString(left, caseSensitive) === asComparableString(right, caseSensitive);
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareNumeric(left: unknown, right: unknown): number | null {
  const a = typeof left === "number" ? left : Number(left);
  const b = typeof right === "number" ? right : Number(right);
  if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b;
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return null;
}

function containsValue(left: unknown, right: unknown, caseSensitive: boolean): boolean {
  if (Array.isArray(left)) {
    return left.some((item) => looseEquals(item, right, caseSensitive));
  }
  if (left !== null && left !== undefined && typeof left === "object") {
    const key = String(right);
    return Object.prototype.hasOwnProperty.call(left, key);
  }
  return asComparableString(left, caseSensitive).includes(
    asComparableString(right, caseSensitive),
  );
}

export function evaluateCondition(condition: Condition): boolean {
  const caseSensitive = condition.caseSensitive ?? false;
  const { left, right } = condition;

  switch (condition.operator) {
    case "eq":
      return looseEquals(left, right, caseSensitive);
    case "neq":
      return !looseEquals(left, right, caseSensitive);
    case "contains":
      return containsValue(left, right, caseSensitive);
    case "notContains":
      return !containsValue(left, right, caseSensitive);
    case "startsWith":
      return asComparableString(left, caseSensitive).startsWith(
        asComparableString(right, caseSensitive),
      );
    case "endsWith":
      return asComparableString(left, caseSensitive).endsWith(
        asComparableString(right, caseSensitive),
      );
    case "gt": {
      const delta = compareNumeric(left, right);
      return delta !== null ? delta > 0 : false;
    }
    case "gte": {
      const delta = compareNumeric(left, right);
      return delta !== null ? delta >= 0 : false;
    }
    case "lt": {
      const delta = compareNumeric(left, right);
      return delta !== null ? delta < 0 : false;
    }
    case "lte": {
      const delta = compareNumeric(left, right);
      return delta !== null ? delta <= 0 : false;
    }
    case "exists":
      return left !== null && left !== undefined;
    case "notExists":
      return left === null || left === undefined;
    case "matches": {
      const pattern = right === null || right === undefined ? "" : String(right);
      if (pattern.length > MAX_PATTERN_LENGTH) {
        throw new ConditionError("The pattern is too long to match against.");
      }
      try {
        return new RegExp(pattern).test(
          left === null || left === undefined ? "" : String(left),
        );
      } catch {
        throw new ConditionError("The pattern is not a valid regular expression.");
      }
    }
    default:
      throw new ConditionError(`Unknown operator "${String(condition.operator)}".`);
  }
}

/** ALL / ANY evaluation. An empty group is vacuously `all`-true. */
export function evaluateGroup(group: ConditionGroup): boolean {
  if (group.combinator === "any") {
    return group.conditions.some((condition) => evaluateCondition(condition));
  }
  return group.conditions.every((condition) => evaluateCondition(condition));
}

/** Normalises the panel's flat single-condition config into a group. */
export function singleConditionGroup(condition: Condition): ConditionGroup {
  return { combinator: "all", conditions: [condition] };
}
