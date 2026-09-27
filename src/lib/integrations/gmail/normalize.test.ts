import { describe, expect, it } from "vitest";
import {
  buildRawMessage,
  decodeBase64Url,
  encodeRaw,
  encodeSubject,
  headers,
  normalizeMessage,
  splitAddress,
  stripHtml,
  type GmailMessage,
} from "./normalize";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("decodeBase64Url", () => {
  it("decodes Gmail's unpadded URL-safe base64", () => {
    expect(decodeBase64Url(b64url("Hello, inbox"))).toBe("Hello, inbox");
    expect(decodeBase64Url("")).toBe("");
    expect(decodeBase64Url(b64url("a/b+c?d=e"))).toBe("a/b+c?d=e");
    /* padded input is accepted too */
    expect(decodeBase64Url(Buffer.from("padded").toString("base64"))).toBe("padded");
  });
});

describe("headers", () => {
  it("lower-cases header names and ignores unnamed entries", () => {
    expect(
      headers({
        headers: [
          { name: "Subject", value: "Hello" },
          { name: "REPLY-TO", value: "reply@x.io" },
          { value: "no name" },
          { name: "X-Empty" },
        ],
      }),
    ).toEqual({ subject: "Hello", "reply-to": "reply@x.io", "x-empty": "" });
    expect(headers(undefined)).toEqual({});
  });
});

describe("splitAddress", () => {
  it("separates the display name from the address", () => {
    expect(splitAddress("Dana <dana@northwind.io>")).toEqual({
      name: "Dana",
      email: "dana@northwind.io",
    });
    expect(splitAddress('"Dana Reyes" <dana@northwind.io>')).toEqual({
      name: "Dana Reyes",
      email: "dana@northwind.io",
    });
    expect(splitAddress("dana@northwind.io")).toEqual({
      name: "dana@northwind.io",
      email: "dana@northwind.io",
    });
  });
});

describe("stripHtml", () => {
  it("turns markup into readable plain text", () => {
    expect(stripHtml("<p>First</p><p>Second</p>")).toBe("First\nSecond");
    expect(stripHtml("one<br/>two")).toBe("one\ntwo");
    expect(stripHtml("<div>a&nbsp;b</div>")).toBe("a b");
    expect(stripHtml("<b>bold</b> and <i>italic</i>")).toBe("bold and italic");
  });

  it("drops scripts and styles entirely", () => {
    expect(stripHtml("<style>.a{color:red}</style><p>kept</p>")).toBe("kept");
    expect(stripHtml("<script>alert(1)</script><p>kept</p>")).toBe("kept");
  });

  it("unescapes entities and collapses whitespace", () => {
    expect(stripHtml("<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p>")).toBe(
      'a & b <c> "d" \'e\'',
    );
    expect(stripHtml("")).toBe("");
  });
});

describe("normalizeMessage", () => {
  const message: GmailMessage = {
    id: "msg_123",
    threadId: "thread_9",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "A short snippet",
    internalDate: "1700000000000",
    historyId: "88",
    payload: {
      headers: [
        { name: "From", value: "Dana Reyes <dana@northwind.io>" },
        { name: "To", value: "oncall@klyz.io" },
        { name: "Cc", value: "sam@klyz.io" },
        { name: "Subject", value: "Export finished" },
        { name: "Reply-To", value: "dana@northwind.io" },
      ],
      parts: [
        {
          partId: "1",
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("Plain body") } },
            { mimeType: "text/html", body: { data: b64url("<p>Plain body</p>") } },
          ],
        },
        {
          partId: "2",
          mimeType: "application/pdf",
          filename: "export.pdf",
          body: { attachmentId: "att_1", size: 4096 },
        },
      ],
    },
  };

  it("lifts every field a workflow references to the top level", () => {
    const view = normalizeMessage(message);
    expect(view).toMatchObject({
      messageId: "msg_123",
      threadId: "thread_9",
      subject: "Export finished",
      from: "Dana Reyes <dana@northwind.io>",
      fromName: "Dana Reyes",
      fromEmail: "dana@northwind.io",
      to: "oncall@klyz.io",
      cc: "sam@klyz.io",
      replyTo: "dana@northwind.io",
      snippet: "A short snippet",
      body: "Plain body",
      bodyHtml: "<p>Plain body</p>",
      labels: ["INBOX", "UNREAD"],
      historyId: "88",
    });
    expect(view.receivedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(view.url).toContain("msg_123");
    expect(view.attachments).toEqual([
      { id: "att_1", filename: "export.pdf", mimeType: "application/pdf", size: 4096 },
    ]);
    expect(view.hasAttachments).toBe(false);
    expect(view.raw).toMatchObject({ id: "msg_123" });
  });

  it("falls back to stripped HTML when there is no plain-text part", () => {
    const htmlOnly = normalizeMessage({
      id: "msg_html",
      payload: {
        headers: [{ name: "Subject", value: "Html only" }],
        parts: [{ mimeType: "text/html", body: { data: b64url("<p>Hi<br/>there</p>") } }],
      },
    });
    expect(htmlOnly.body).toBe("Hi\nthere");
    expect(htmlOnly.bodyHtml).toBe("<p>Hi<br/>there</p>");
    expect(htmlOnly.subject).toBe("Html only");
    expect(htmlOnly.fromName).toBe("");
  });

  it("survives an empty payload instead of throwing", () => {
    const view = normalizeMessage(undefined);
    expect(view.messageId).toBe("");
    expect(view.subject).toBe("");
    expect(view.body).toBe("");
    expect(view.labels).toEqual([]);
    expect(view.attachments).toEqual([]);
    expect(view.receivedAt).toBeTruthy();
  });
});

describe("encodeSubject", () => {
  it("leaves printable ASCII alone", () => {
    expect(encodeSubject("Weekly report")).toBe("Weekly report");
    expect(encodeSubject("Re: [KLYZ] #42 (ok)")).toBe("Re: [KLYZ] #42 (ok)");
    expect(encodeSubject("")).toBe("");
  });

  it("RFC 2047 encodes anything outside printable ASCII", () => {
    const encoded = encodeSubject("Ürgent — klar?");
    expect(encoded.startsWith("=?UTF-8?B?")).toBe(true);
    expect(encoded.endsWith("?=")).toBe(true);
    const body = encoded.slice("=?UTF-8?B?".length, -"?=".length);
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Ürgent — klar?");
  });
});

describe("encodeRaw", () => {
  it("round-trips through base64url", () => {
    const raw = buildRawMessage({ to: ["dana@x.io"], subject: "Hi", text: "Body" });
    const encoded = encodeRaw(raw);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(raw);
  });
});

describe("buildRawMessage", () => {
  it("composes a plain-text message without guessing a From header", () => {
    const raw = buildRawMessage({
      to: ["dana@x.io"],
      cc: ["sam@x.io"],
      bcc: ["ops@x.io"],
      subject: "Weekly report",
      text: "All good.",
    });
    expect(raw).toContain("To: dana@x.io");
    expect(raw).toContain("Cc: sam@x.io");
    expect(raw).toContain("Bcc: ops@x.io");
    expect(raw).toContain("Subject: Weekly report");
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw.trimEnd().endsWith("All good.")).toBe(true);
    expect(raw).not.toMatch(/^From:/m);
    expect(raw).toContain("MIME-Version: 1.0");
    expect(raw).toMatch(/^Date: /m);
  });

  it("uses multipart/alternative for HTML so plain-text readers still work", () => {
    const raw = buildRawMessage({
      to: ["dana@x.io"],
      subject: "Hi",
      html: "<p>Hello <b>there</b></p>",
    });
    expect(raw).toContain("Content-Type: multipart/alternative");
    expect(raw).toContain('<p>Hello <b>there</b></p>');
    expect(raw).toContain("Hello there");
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(raw).toMatch(/--klyz_[A-Za-z0-9]+--/);
  });

  it("carries the threading headers a reply needs", () => {
    const raw = buildRawMessage({
      to: ["dana@x.io"],
      subject: "Re: Export finished",
      text: "Thanks!",
      threadId: "thread_9",
      inReplyTo: "<original@northwind.io>",
      references: "<original@northwind.io>",
    });
    expect(raw).toContain("In-Reply-To: <original@northwind.io>");
    expect(raw).toContain("References: <original@northwind.io>");
  });

  it("encodes a non-ASCII subject", () => {
    const raw = buildRawMessage({ to: ["dana@x.io"], subject: "Ürgent", text: "body" });
    expect(raw).toContain("Subject: =?UTF-8?B?");
  });
});
