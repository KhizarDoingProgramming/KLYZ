/**
 * Manual run input — the JSON payload the editor hands to a manual run.
 *
 * The payload becomes the run's `input`, which the engine exposes to
 * every node as `trigger.payload`. Parsing lives here instead of in the
 * component so the "valid object or refuse before executing" rule is
 * testable without a browser.
 */

/** Shown in the editor before the first run — a payload loops can consume. */
export const DEFAULT_RUN_INPUT = `{
  "items": ["alpha", "beta", "gamma"]
}`;

export type RunInputResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Parse what the user typed into the run-input box.
 *
 * Empty input is valid and yields `{}` — a run may legitimately need no
 * payload. Anything else must be a JSON **object**: an array or a bare
 * scalar would leave `trigger.payload` shapeless, so it is rejected with
 * a message that says what to write instead.
 */
export function parseRunInput(text: string): RunInputResult {
  const source = text.trim();
  if (source === "") return { ok: true, input: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "check the syntax.";
    return {
      ok: false,
      error: `Run input is not valid JSON (${detail}). Nothing was started — fix the payload and run again.`,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error:
        "Run input must be a JSON object, for example {\"items\": [\"a\"]}. " +
        "An array or a bare value cannot be read as {{trigger.payload.…}}.",
    };
  }

  return { ok: true, input: parsed as Record<string, unknown> };
}
