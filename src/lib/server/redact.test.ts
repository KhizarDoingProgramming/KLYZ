import { describe, expect, it } from "vitest";
import { REDACTED, maskSecret, redact, redactHeaders, redactMessage, redactUrl } from "./redact";

describe("redact", () => {
  it("masks credential-bearing keys at any depth", () => {
    const out = redact({
      title: "hello",
      authorization: "Bearer abc",
      headers: { Cookie: "sid=1", "X-Api-Key": "k" },
      nested: [{ access_token: "tok" }, { clientSecret: "s3cr3t" }],
    }) as {
      title: string;
      authorization: string;
      headers: Record<string, string>;
      nested: Array<Record<string, string>>;
    };

    expect(out.title).toBe("hello");
    expect(out.authorization).toBe(REDACTED);
    expect(out.headers.Cookie).toBe(REDACTED);
    expect(out.headers["X-Api-Key"]).toBe(REDACTED);
    expect(out.nested[0]!.access_token).toBe(REDACTED);
    expect(out.nested[1]!.clientSecret).toBe(REDACTED);
  });

  it("does not treat ordinary words as secrets", () => {
    const out = redact({ author: "Ada", authority: "admin", authors: ["Ada", "Grace"] }) as Record<
      string,
      unknown
    >;
    expect(out.author).toBe("Ada");
    expect(out.authority).toBe("admin");
    /* `authors` splits into one word — `auth` only counts when it is a whole word. */
    expect(out.authors).toEqual(["Ada", "Grace"]);
  });

  it("never mutates the input and flattens dates", () => {
    const source = { at: new Date(0), token: "abc" };
    const out = redact(source) as Record<string, unknown>;
    expect(out.at).toBe("1970-01-01T00:00:00.000Z");
    expect(out.token).toBe(REDACTED);
    expect(source.token).toBe("abc");
  });

  it("cuts runaway nesting instead of recursing forever", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 20; index += 1) deep = { child: deep };

    let cursor: unknown = redact(deep);
    let levels = 0;
    while (cursor && typeof cursor === "object" && "child" in cursor) {
      cursor = (cursor as { child: unknown }).child;
      levels += 1;
    }
    expect(levels).toBeLessThanOrEqual(9);
    expect(cursor).toBe(REDACTED);
  });
});

describe("redactMessage", () => {
  it("masks bearer tokens and credentials embedded in URLs", () => {
    const message =
      "fetch failed for https://user:sk-live-123@api.example.com/v1 with Bearer sk-live-123";
    const out = redactMessage(message);
    expect(out).not.toContain("sk-live-123");
    expect(out).toContain(`Bearer ${REDACTED}`);
    expect(out).toContain(`user:${REDACTED}@`);
    expect(out).toContain("https://user:");
  });

  it("leaves ordinary messages untouched", () => {
    expect(redactMessage("connection refused")).toBe("connection refused");
  });
});

describe("maskSecret", () => {
  it("keeps just enough to correlate, never the value", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret("short")).toBe(REDACTED);
    expect(maskSecret("ghp_abcdefghijklmnop")).toBe(`ghp_${REDACTED}`);
  });
});

describe("redactHeaders", () => {
  it("lower-cases names and masks only the sensitive ones", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer abc",
        "Content-Type": "application/json",
        "X-Forwarded-For": undefined,
      }),
    ).toEqual({
      authorization: REDACTED,
      "content-type": "application/json",
    });
  });
});

describe("redactUrl", () => {
  it("strips userinfo and masks secret query parameters", () => {
    expect(redactUrl("https://user:pass@example.com/hook?api_key=abc&team=klyz")).toBe(
      `https://example.com/hook?api_key=${encodeURIComponent(REDACTED)}&team=klyz`,
    );
  });

  it("accepts a URL object — assertTarget hands one over", () => {
    expect(redactUrl(new URL("https://example.com/x?access_token=tok&page=2"))).toBe(
      `https://example.com/x?access_token=${encodeURIComponent(REDACTED)}&page=2`,
    );
  });

  it("returns non-URLs untouched instead of throwing", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});

describe("redactMessage", () => {
  it("scrubs connection strings, bearer tokens and webhook secrets", () => {
    expect(redactMessage("dial postgres://user:hunter2@db:5432/app failed")).toBe(
      "dial postgres://[redacted] failed",
    );
    expect(redactMessage("Authorization: Bearer sk_live_123")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactMessage("bad sig whsec_abc123")).toBe(`bad sig whsec_${REDACTED}`);
  });
});
