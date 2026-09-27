import type { AiCompletion, AiMessage, AiProvider, AiRequest } from "./provider";

/**
 * Deterministic local model — the stand-in for tests and local runs.
 *
 * It answers the four AI step contracts (`extract`, `summarize`,
 * `classify`, `generate`) from the request itself: every value is derived
 * from the text the step sent, never invented, and the same request
 * always produces the same reply. That is what makes it usable as a test
 * double for the *real* execution path — the handler, its config
 * resolution, its output validation and its error mapping all run
 * unmodified; only the network round-trip is replaced.
 *
 * It is opt-in (`KLYZ_AI_PROVIDER=mock`), never a default, and
 * `aiProviderKind()` refuses it in production.
 *
 * To recognise a contract it greps the same markers the handlers emit,
 * so a prompt change that breaks the mock breaks it loudly in tests.
 */

const MARKERS = {
  extract: "Extract the listed fields",
  summarize: "Summarise the user's content",
  classify: "from this list:",
  generate: "Answer with the text itself",
} as const;

function messageText(messages: AiMessage[], role: AiMessage["role"]): string {
  const found = messages.find((message) => message.role === role);
  return found?.content ?? "";
}

/** Text between the first `<label>…</label>` pair, or the whole input. */
function tagged(label: string, source: string): string {
  const open = `<${label}>`;
  const close = `</${label}>`;
  const start = source.indexOf(open);
  if (start < 0) return source;
  const from = start + open.length;
  const end = source.indexOf(close, from);
  return (end < 0 ? source.slice(from) : source.slice(from, end)).trim();
}

function firstSentence(text: string, limit = 160): string {
  const source = text.trim();
  if (!source) return "";
  const sentence = source.split(/\n|(?<=[.!?])\s+/)[0]?.trim() ?? "";
  if (!sentence) return source.slice(0, limit);
  return sentence.length <= limit ? sentence : `${sentence.slice(0, limit - 1)}…`;
}

/** `Fields (name → type): a, b, c` — a single line of bare names. */
function fieldNames(user: string): string[] {
  const start = user.indexOf("Fields (name → type):");
  if (start < 0) return [];
  const line = user.slice(start + "Fields (name → type):".length).split("\n")[0] ?? "";
  return line
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** `from this list: "a", "b". Reply with …` — quoted names, one list. */
function labelsFromSystem(system: string): string[] {
  const start = system.indexOf(MARKERS.classify);
  if (start < 0) return [];
  const rest = system.slice(start + MARKERS.classify.length);
  const end = rest.indexOf(". Reply");
  const segment = end >= 0 ? rest.slice(0, end) : (rest.split("\n")[0] ?? rest);
  const quoted = [...segment.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    match[1] ?? "",
  );
  if (quoted.length > 0) return quoted;
  return segment
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Value for one declared field, read out of the content the step sent.
 * The declared type is not forwarded in the prompt, so the rule is keyed
 * on the field name: counters become numbers, list-ish names become
 * arrays, everything else is the first sentence. Nothing is invented —
 * a name with no match in the content stays `null`.
 */
function deriveField(key: string, content: string): unknown {
  const text = content.trim();
  if (!text) return null;
  if (/(count|number|total|amount|qty|age|index|length)/i.test(key)) {
    const match = text.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }
  if (/(tags|items|list|labels|emails|names|words)/i.test(key)) {
    const parts = text.includes(",") ? text.split(",") : text.split(/\s+/);
    return parts
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 16);
  }
  return firstSentence(text);
}

function respond(system: string, user: string): string {
  const content = tagged("content", user);

  if (system.includes(MARKERS.extract)) {
    const fields: Record<string, unknown> = {};
    for (const key of fieldNames(user)) fields[key] = deriveField(key, content);
    return JSON.stringify(fields);
  }

  if (system.includes(MARKERS.summarize)) {
    return JSON.stringify({ summary: firstSentence(content) || "No content supplied." });
  }

  if (system.includes(MARKERS.classify)) {
    const labels = labelsFromSystem(system);
    const text = content.trim().toLowerCase();
    const matches = labels.filter((label) => text.includes(label.toLowerCase()));
    const chosen = matches.length > 0 ? matches : labels.slice(0, 1);
    const scores: Record<string, number> = {};
    for (const label of labels) scores[label] = chosen.includes(label) ? 1 : 0;
    return JSON.stringify({ label: chosen.join(", "), scores });
  }

  if (system.includes(MARKERS.generate)) {
    const prompt = user.replace(/<context>[\s\S]*<\/context>/g, "").trim();
    return `Mock: ${firstSentence(prompt) || "no prompt supplied."}`;
  }

  return (
    "The mock AI provider implements the four AI step contracts only. " +
    "Set KLYZ_AI_PROVIDER=openai and KLYZ_AI_API_KEY to call a real model."
  );
}

export class MockAiProvider implements AiProvider {
  readonly name = "klyz-mock";
  readonly model = "klyz/mock-local";

  async complete(request: AiRequest): Promise<AiCompletion> {
    const startedAt = Date.now();
    const system = messageText(request.messages, "system");
    const user = messageText(request.messages, "user");
    const text = respond(system, user);
    const completionTokens = Math.ceil(text.length / 4);

    return {
      text,
      model: this.model,
      provider: this.name,
      durationMs: Math.max(0, Date.now() - startedAt),
      usage: {
        promptTokens: Math.ceil((system.length + user.length) / 4),
        completionTokens,
        totalTokens: Math.ceil((system.length + user.length) / 4) + completionTokens,
      },
    };
  }
}
