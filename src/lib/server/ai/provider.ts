import {
  aiApiKey,
  aiBaseUrl,
  aiEnabled,
  aiMaxTokens,
  aiModel,
  aiProviderKind,
  aiTimeoutMs,
} from "@/lib/config/env";
import { redactMessage } from "@/lib/server/redact";
import { AI_CODES, aiError } from "./errors";
import { MockAiProvider } from "./mock";

/**
 * Provider-agnostic model access.
 *
 * One small internal client instead of an SDK: KLYZ only ever needs a
 * single bounded JSON-generating call, and keeping it in-repo means the
 * timeout, the response cap, the error mapping and the "never log the
 * key" rule are all in one place. The interface is deliberately narrow
 * (`complete`) so swapping OpenRouter for any OpenAI-compatible endpoint
 * — or a future in-house model — is a config change, not a refactor.
 *
 * Secrets: the key lives in the environment and is only ever attached to
 * the outbound request header. Nothing here logs request or response
 * bodies; the audit line carries model, duration and status only.
 */

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiRequest {
  messages: AiMessage[];
  maxTokens?: number;
  timeoutMs?: number;
  /** Sampling temperature — 0 where a step needs deterministic output. */
  temperature?: number;
  /** Cancels the round-trip (client disconnect, user pressed stop). */
  signal?: AbortSignal;
}

export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiCompletion {
  text: string;
  model: string;
  provider: string;
  durationMs: number;
  usage?: AiUsage;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(request: AiRequest): Promise<AiCompletion>;
}

/** Bodies larger than this are refused before being parsed. */
const MAX_RESPONSE_CHARS = 400_000;

function readUsage(raw: unknown): AiUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const pick = (key: string): number | undefined =>
    typeof record[key] === "number" ? (record[key] as number) : undefined;
  const usage: AiUsage = {};
  const prompt = pick("prompt_tokens");
  const completion = pick("completion_tokens");
  const total = pick("total_tokens");
  if (prompt !== undefined) usage.promptTokens = prompt;
  if (completion !== undefined) usage.completionTokens = completion;
  if (total !== undefined) usage.totalTokens = total;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as { message?: unknown }).message;
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    /* Some endpoints stream content as typed parts. */
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .join("");
    }
  }
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

class OpenAiCompatibleProvider implements AiProvider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: { baseUrl: string; apiKey: string; model: string }) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    /* Host only — never the path, never the key. */
    try {
      this.name = new URL(options.baseUrl).hostname;
    } catch {
      this.name = "custom";
    }
  }

  async complete(request: AiRequest): Promise<AiCompletion> {
    const timeoutMs = request.timeoutMs ?? aiTimeoutMs();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          /* Server-side only: never reaches the browser bundle. */
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          max_tokens: request.maxTokens ?? aiMaxTokens(),
          temperature: request.temperature ?? 0.2,
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw aiError(
          504,
          AI_CODES.TIMEOUT,
          `The AI provider did not answer within ${Math.round(timeoutMs / 1000)}s.`,
        );
      }
      throw aiError(
        502,
        AI_CODES.PROVIDER_ERROR,
        `The AI provider could not be reached: ${redactMessage(
          error instanceof Error ? error.message : "network error",
        )}`,
      );
    }

    const durationMs = Date.now() - startedAt;
    const body = await response.text().catch(() => "");

    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      if (response.status === 429) {
        throw aiError(
          429,
          AI_CODES.RATE_LIMITED,
          retryAfter
            ? `The AI provider is rate limiting requests. Retry in ${retryAfter}s.`
            : "The AI provider is rate limiting requests.",
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw aiError(
          502,
          AI_CODES.PROVIDER_ERROR,
          "The AI provider rejected the configured credentials. Check KLYZ_AI_API_KEY.",
        );
      }
      throw aiError(
        502,
        AI_CODES.PROVIDER_ERROR,
        `The AI provider answered ${response.status}: ${redactMessage(body.slice(0, 400))}`,
      );
    }

    if (body.length > MAX_RESPONSE_CHARS) {
      throw aiError(
        502,
        AI_CODES.PROVIDER_ERROR,
        `The AI provider returned ${body.length} characters, over the ${MAX_RESPONSE_CHARS}-character limit.`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw aiError(502, AI_CODES.PROVIDER_ERROR, "The AI provider returned a non-JSON response.");
    }

    const text = extractText(payload);
    if (!text.trim()) {
      throw aiError(422, AI_CODES.INVALID_OUTPUT, "The AI provider returned an empty completion.");
    }

    return {
      text,
      model: this.model,
      provider: this.name,
      durationMs,
      ...(readUsage((payload as { usage?: unknown }).usage)
        ? { usage: readUsage((payload as { usage?: unknown }).usage) }
        : {}),
    };
  }
}

/** Throws `AI_CONFIGURATION_MISSING` when the feature is not set up. */
export function aiProvider(): AiProvider {
  /* Opt-in only (`KLYZ_AI_PROVIDER=mock`) and refused in production by
     `aiProviderKind()`, so the deterministic stand-in can never become
     the way a shipped deployment answers AI steps. */
  let kind: "openai" | "mock";
  try {
    kind = aiProviderKind();
  } catch (error) {
    throw aiError(
      503,
      AI_CODES.CONFIGURATION_MISSING,
      error instanceof Error
        ? error.message
        : "The AI provider configuration is invalid.",
      { variable: "KLYZ_AI_PROVIDER", docs: "/docs/ai.md" },
    );
  }
  if (kind === "mock") return new MockAiProvider();
  if (!aiEnabled()) {
    throw aiError(
      503,
      AI_CODES.CONFIGURATION_MISSING,
      "The AI builder is not configured. Set KLYZ_AI_API_KEY to enable it.",
      { variable: "KLYZ_AI_API_KEY", docs: "/docs/ai.md" },
    );
  }
  return new OpenAiCompatibleProvider({
    baseUrl: aiBaseUrl(),
    apiKey: aiApiKey(),
    model: aiModel(),
  });
}

/** Configuration state for the UI — never includes the key. */
export function aiStatus(): { enabled: boolean; model: string; baseUrl: string } {
  return { enabled: aiEnabled(), model: aiModel(), baseUrl: aiBaseUrl() };
}
