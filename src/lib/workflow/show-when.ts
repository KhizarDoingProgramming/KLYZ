import type { ConfigField } from "./types";

/**
 * Is a config field visible for the current config?
 *
 * `showWhen` gates optional and required fields alike — the editor uses
 * it to toggle sections and validation uses it to skip fields the user
 * cannot currently fill in.
 */
export function isVisible(field: ConfigField, config: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  const current = config[field.showWhen.key];
  const expected = field.showWhen.equals;
  return Array.isArray(expected)
    ? expected.includes(String(current))
    : String(current) === expected;
}
