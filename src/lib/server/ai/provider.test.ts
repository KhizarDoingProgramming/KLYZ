import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/http";
import { AI_CODES } from "./errors";
import { aiProvider, aiStatus } from "./provider";

/**
 * The provider seam: one bounded JSON call, mapped errors, and a hard
 * rule that the configured key never appears in anything a user could
 * read back.
 */

const KEY = "sk-test-key-that-must-not-leak";
const BASE = "https://provider.test/v1";

const fetchMock = vi.fn();

function completionBody(content: string, usage?: Record<string, number>): string {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
    ...(usage ? { usage } : {}),
  });
}

async function expectHttpError(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected the call to throw an HttpError");
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("KLYZ_AI_API_KEY", KEY);
  vi.stubEnv("KLYZ_AI_MODEL", "openai/test-model");
  vi.stubEnv("KLYZ_AI_BASE_URL", BASE);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenAiCompatibleProvider", () => {
  it("posts messages to the configured endpoint and returns text, model and usage", async () => {
    fetchMock.mockResolvedValue(
      new Response(completionBody("hello", { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const completion = await aiProvider().complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(completion.text).toBe("hello");
    expect(completion.model).toBe("openai/test-model");
    expect(completion.provider).toBe("provider.test");
    expect(completion.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/chat/completions`);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("openai/test-model");
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("maps provider rate limiting to AI_RATE_LIMITED with the retry hint", async () => {
    fetchMock.mockResolvedValue(
      new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    );
    const error = await expectHttpError(aiProvider().complete({ messages: [] }));
    expect(error.status).toBe(429);
    expect(error.code).toBe(AI_CODES.RATE_LIMITED);
    expect(error.message).toContain("30s");
    expect(error.message).not.toContain(KEY);
  });

  it("maps rejected credentials to a provider error that names the variable, not the key", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const error = await expectHttpError(aiProvider().complete({ messages: [] }));
    expect(error.status).toBe(502);
    expect(error.code).toBe(AI_CODES.PROVIDER_ERROR);
    expect(error.message).toContain("KLYZ_AI_API_KEY");
    expect(error.message).not.toContain(KEY);
  });

  it("maps 5xx bodies through redaction", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: `boom with authorization: Bearer ${KEY}` }), {
        status: 500,
      }),
    );
    const error = await expectHttpError(aiProvider().complete({ messages: [] }));
    expect(error.code).toBe(AI_CODES.PROVIDER_ERROR);
    expect(error.message).toContain("500");
    expect(error.message).not.toContain(KEY);
  });

  it("rejects non-JSON and empty completions", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>nope</html>", { status: 200 }));
    const nonJson = await expectHttpError(aiProvider().complete({ messages: [] }));
    expect(nonJson.code).toBe(AI_CODES.PROVIDER_ERROR);
    expect(nonJson.message).toContain("non-JSON");

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const empty = await expectHttpError(aiProvider().complete({ messages: [] }));
    expect(empty.status).toBe(422);
    expect(empty.code).toBe(AI_CODES.INVALID_OUTPUT);
  });

  it("rejects oversized response bodies", async () => {
    fetchMock.mockResolvedValue(new Response("x".repeat(410_000), { status: 200 }));
    const error = await expectHttpError(aiProvider().complete({ messages: [] }));
    expect(error.code).toBe(AI_CODES.PROVIDER_ERROR);
    expect(error.message).toContain("limit");
  });

  it("times out with AI_TIMEOUT when the provider stalls", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );

    const error = await expectHttpError(
      aiProvider().complete({ messages: [], timeoutMs: 10 }),
    );
    expect(error.status).toBe(504);
    expect(error.code).toBe(AI_CODES.TIMEOUT);
  });

  it("maps unreachable networks to a redacted provider error", async () => {
    fetchMock.mockRejectedValue(new Error(`getaddrinfo ENOTFOUND https://user:${KEY}@x.test`));
    const error = await expectHttpError(aiProvider().complete({ messages: [] }));
    expect(error.status).toBe(502);
    expect(error.code).toBe(AI_CODES.PROVIDER_ERROR);
    expect(error.message).not.toContain(KEY);
  });
});

describe("aiProvider / aiStatus", () => {
  it("refuses to construct a provider without a key", () => {
    vi.stubEnv("KLYZ_AI_API_KEY", "");
    const error = (() => {
      try {
        aiProvider();
      } catch (caught) {
        return caught as HttpError;
      }
      throw new Error("expected aiProvider() to throw");
    })();
    expect(error.status).toBe(503);
    expect(error.code).toBe(AI_CODES.CONFIGURATION_MISSING);
    expect(error.message).toContain("KLYZ_AI_API_KEY");
  });

  it("reports status without ever exposing the key", () => {
    const status = aiStatus();
    expect(status.enabled).toBe(true);
    expect(status.model).toBe("openai/test-model");
    expect(status.baseUrl).toBe(BASE);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("reports disabled status cleanly", () => {
    vi.stubEnv("KLYZ_AI_API_KEY", "");
    expect(aiStatus()).toEqual({
      enabled: false,
      model: "openai/test-model",
      baseUrl: BASE,
    });
  });
});

describe("KLYZ_AI_PROVIDER=mock", () => {
  it("answers deterministically without touching the network", async () => {
    vi.stubEnv("KLYZ_AI_PROVIDER", "mock");
    const provider = aiProvider();
    expect(provider.name).toBe("klyz-mock");

    const request = {
      messages: [
        { role: "system" as const, content: "Summarise the user's content. Reply with one JSON object: {\"summary\": \"string\"}." },
        { role: "user" as const, content: "<content>\nPayments retried three times.\n</content>" },
      ],
    };
    const first = await provider.complete(request);
    const second = await provider.complete(request);

    expect(first.text).toBe(second.text);
    expect(first.text).toContain("summary");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is enabled even with no key configured", () => {
    vi.stubEnv("KLYZ_AI_PROVIDER", "mock");
    vi.stubEnv("KLYZ_AI_API_KEY", "");
    expect(aiStatus().enabled).toBe(true);
  });

  it("is refused in production so it can never be a shipped default", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KLYZ_AI_PROVIDER", "mock");
    expect(() => aiProvider()).toThrow(/refused in production/);
  });

  it("rejects an unknown provider name", () => {
    vi.stubEnv("KLYZ_AI_PROVIDER", "gpt5");
    expect(() => aiProvider()).toThrow(/KLYZ_AI_PROVIDER must be/);
  });
});
