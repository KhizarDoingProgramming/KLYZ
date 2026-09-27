import { describe, expect, it } from "vitest";
import { EngineError } from "@/lib/engine/types";
import { GMAIL_ERRORS } from "../errors";
import { parseEmail, parseLabel, parseRecipients, requiredText } from "./config";

function expectError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

describe("parseEmail", () => {
  it("accepts ordinary addresses and trims whitespace", () => {
    expect(parseEmail(" dana@northwind.io ", "To")).toBe("dana@northwind.io");
    expect(parseEmail("ops+alerts@klyz.io", "To")).toBe("ops+alerts@klyz.io");
    expect(parseEmail("first.last@example.co.uk", "To")).toBe("first.last@example.co.uk");
  });

  it("rejects empty, malformed and hostile input", () => {
    for (const bad of ["", "   ", null, undefined, "dana@", "@northwind.io", "dana northwind.io"]) {
      expectError(() => parseEmail(bad, "To"), GMAIL_ERRORS.recipientInvalid);
    }
    for (const bad of ["a,b@x.io", "a;b@x.io", "<a@x.io>", '"a@x.io"@x.io']) {
      expectError(() => parseEmail(bad, "To"), GMAIL_ERRORS.recipientInvalid);
    }
  });
});

describe("parseRecipients", () => {
  it("splits on commas and semicolons", () => {
    expect(parseRecipients("dana@x.io, sam@x.io", "Cc")).toEqual(["dana@x.io", "sam@x.io"]);
    expect(parseRecipients("dana@x.io;sam@x.io", "Cc")).toEqual(["dana@x.io", "sam@x.io"]);
    expect(parseRecipients(" dana@x.io ,, ", "Cc")).toEqual(["dana@x.io"]);
  });

  it("treats an empty value as no recipients", () => {
    expect(parseRecipients("", "Bcc")).toEqual([]);
    expect(parseRecipients("   ", "Bcc")).toEqual([]);
    expect(parseRecipients(null, "Bcc")).toEqual([]);
    expect(parseRecipients(undefined, "Bcc")).toEqual([]);
  });

  it("still validates every address it finds", () => {
    expectError(() => parseRecipients("dana@x.io, nope", "Cc"), GMAIL_ERRORS.recipientInvalid);
    expectError(() => parseRecipients("nope", "Cc"), GMAIL_ERRORS.recipientInvalid);
  });
});

describe("parseLabel", () => {
  it("returns a single-line label unchanged", () => {
    expect(parseLabel("INBOX", "Label")).toBe("INBOX");
    expect(parseLabel("  Support/Closed  ", "Label")).toBe("Support/Closed");
  });

  it("rejects a missing label and malformed ones", () => {
    expectError(() => parseLabel("", "Label"), GMAIL_ERRORS.configInvalid);
    expectError(() => parseLabel("   ", "Label"), GMAIL_ERRORS.configInvalid);
    expectError(() => parseLabel(null, "Label"), GMAIL_ERRORS.configInvalid);
    expectError(() => parseLabel("line\nbreak", "Label"), GMAIL_ERRORS.configInvalid);
    expectError(() => parseLabel("x".repeat(226), "Label"), GMAIL_ERRORS.configInvalid);
  });
});

describe("requiredText", () => {
  it("returns the trimmed value", () => {
    expect(requiredText({ body: "  hello  " }, "body", "message")).toBe("hello");
  });

  it("fails with an actionable code when the field is empty", () => {
    expectError(() => requiredText({}, "body", "message"), GMAIL_ERRORS.configInvalid);
    expectError(() => requiredText({ body: "  " }, "body", "message"), GMAIL_ERRORS.configInvalid);
    expectError(() => requiredText({ body: 12 }, "body", "message"), GMAIL_ERRORS.configInvalid);
  });
});
