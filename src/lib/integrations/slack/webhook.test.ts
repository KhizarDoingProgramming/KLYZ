import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  normalizeSlackEvent,
  parseSlackChallenge,
  parseSlackDelivery,
  verifySlackSignature,
} from "./webhook";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const TIMESTAMP = "1758888888";
const NOW = Number(TIMESTAMP) * 1000;
const BODY = JSON.stringify({
  type: "event_callback",
  team_id: "T0KLYZ",
  event: {
    type: "message",
    channel: "C0ENGLAND1",
    channel_type: "channel",
    user: "U0PERSON",
    text: "deploy finished",
    ts: "1758888888.000100",
  },
});

/** The signature Slack would send — computed here, never hard-coded. */
function sign(body: string, secret: string, timestamp: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

describe("parseSlackDelivery", () => {
  it("reads the two headers Slack sends, whatever the casing", () => {
    const headers = parseSlackDelivery({
      "X-Slack-Signature": "v0=abc",
      "X-SLACK-REQUEST-TIMESTAMP": TIMESTAMP,
    });
    expect(headers).toEqual({ signature: "v0=abc", timestamp: TIMESTAMP });
  });

  it("accepts a Headers instance", () => {
    const headers = parseSlackDelivery(
      new Headers({ "x-slack-signature": "v0=abc", "x-slack-request-timestamp": TIMESTAMP }),
    );
    expect(headers.signature).toBe("v0=abc");
    expect(headers.timestamp).toBe(TIMESTAMP);
  });

  it("returns nulls when nothing is sent", () => {
    expect(parseSlackDelivery({})).toEqual({ signature: null, timestamp: null });
    expect(parseSlackDelivery(new Headers()).signature).toBeNull();
  });
});

describe("verifySlackSignature", () => {
  it("accepts the signature Slack computes over the raw body", () => {
    const result = verifySlackSignature({
      rawBody: BODY,
      signature: sign(BODY, SECRET, TIMESTAMP),
      timestamp: TIMESTAMP,
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: true });
    expect(
      verifySlackSignature({
        rawBody: Buffer.from(BODY),
        signature: sign(BODY, SECRET, TIMESTAMP),
        timestamp: TIMESTAMP,
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a wrong secret and a tampered body", () => {
    expect(
      verifySlackSignature({
        rawBody: BODY,
        signature: sign(BODY, "not_the_secret", TIMESTAMP),
        timestamp: TIMESTAMP,
        secret: SECRET,
        now: NOW,
      }).reason,
    ).toBe("mismatch");
    expect(
      verifySlackSignature({
        rawBody: `${BODY} `,
        signature: sign(BODY, SECRET, TIMESTAMP),
        timestamp: TIMESTAMP,
        secret: SECRET,
        now: NOW,
      }).reason,
    ).toBe("mismatch");
  });

  it("reports missing headers as missing", () => {
    const base = { rawBody: BODY, secret: SECRET, now: NOW };
    expect(verifySlackSignature({ ...base, signature: null, timestamp: TIMESTAMP })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(verifySlackSignature({ ...base, signature: "v0=abc", timestamp: null })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(
      verifySlackSignature({ ...base, signature: "v0=abc", timestamp: TIMESTAMP, secret: "" }),
    ).toEqual({ ok: false, reason: "missing" });
  });

  it("reports anything that is not v0=<hex>, or a non-numeric timestamp, as malformed", () => {
    const base = { rawBody: BODY, secret: SECRET, now: NOW, timestamp: TIMESTAMP };
    for (const signature of ["nonsense", "sha256=abc", "v0=", "v0=zzzz"]) {
      expect(verifySlackSignature({ ...base, signature }).reason).toBe("malformed");
    }
    expect(
      verifySlackSignature({ ...base, signature: "v0=abc", timestamp: "yesterday" }).reason,
    ).toBe("malformed");
  });

  it("refuses deliveries outside the five-minute window, past and future", () => {
    const signature = sign(BODY, SECRET, TIMESTAMP);
    expect(
      verifySlackSignature({
        rawBody: BODY,
        signature,
        timestamp: TIMESTAMP,
        secret: SECRET,
        now: NOW + 299_000,
      }),
    ).toEqual({ ok: true });
    expect(
      verifySlackSignature({
        rawBody: BODY,
        signature,
        timestamp: TIMESTAMP,
        secret: SECRET,
        now: NOW + 301_000,
      }).reason,
    ).toBe("stale");
    expect(
      verifySlackSignature({
        rawBody: BODY,
        signature,
        timestamp: TIMESTAMP,
        secret: SECRET,
        now: NOW - 301_000,
      }).reason,
    ).toBe("stale");
    expect(
      verifySlackSignature({
        rawBody: BODY,
        signature,
        timestamp: TIMESTAMP,
        secret: SECRET,
        now: NOW + 6_000,
        toleranceMs: 5_000,
      }).reason,
    ).toBe("stale");
  });
});

describe("normalizeSlackEvent", () => {
  const envelope = JSON.parse(BODY) as Record<string, unknown>;
  const message = envelope.event as Record<string, unknown>;
  const send = (event: Record<string, unknown>, top: Record<string, unknown> = {}) =>
    normalizeSlackEvent({ ...envelope, ...top, event: { ...message, ...event } });

  it("accepts a plain message delivery", () => {
    const normalized = normalizeSlackEvent(envelope, new Date(0).toISOString());
    expect(normalized).toMatchObject({
      type: "message",
      channel: "C0ENGLAND1",
      channelType: "channel",
      userId: "U0PERSON",
      text: "deploy finished",
      ts: "1758888888.000100",
      threadTs: "",
      teamId: "T0KLYZ",
      botId: "",
      receivedAt: new Date(0).toISOString(),
    });
    expect(normalized?.raw).toMatchObject({ type: "event_callback" });
  });

  it("keeps thread, username and file metadata when present", () => {
    const normalized = send({
      username: "dana",
      text: "one more thing",
      ts: "1758888888.000200",
      thread_ts: "1758888888.000100",
      files: [{ id: "F1", name: "diagram.png" }],
    });
    expect(normalized?.userName).toBe("dana");
    expect(normalized?.threadTs).toBe("1758888888.000100");
    expect(normalized?.files).toHaveLength(1);
  });

  it("refuses anything that must not start a run", () => {
    expect(send({}, { type: "app_rate_limited" })).toBeNull();
    expect(send({ type: "reaction_added" })).toBeNull();
    expect(send({ subtype: "message_changed" })).toBeNull();
    expect(send({ subtype: "bot_message" })).toBeNull();
    expect(send({ bot_id: "B0KLYZ" })).toBeNull();
    expect(send({ channel: undefined })).toBeNull();
    expect(send({ ts: "" })).toBeNull();
    expect(normalizeSlackEvent({})).toBeNull();
    expect(normalizeSlackEvent({ type: "event_callback" })).toBeNull();
  });
});

describe("parseSlackChallenge", () => {
  it("returns the challenge of a url_verification handshake", () => {
    expect(parseSlackChallenge({ type: "url_verification", challenge: "3eZbrw1aBm2rZQhFnU023i46Jp013DQ0jqKdcvL" })).toBe(
      "3eZbrw1aBm2rZQhFnU023i46Jp013DQ0jqKdcvL",
    );
  });

  it("returns null for anything else", () => {
    expect(parseSlackChallenge({ type: "event_callback" })).toBeNull();
    expect(parseSlackChallenge({ type: "url_verification" })).toBeNull();
    expect(parseSlackChallenge({})).toBeNull();
  });
});
