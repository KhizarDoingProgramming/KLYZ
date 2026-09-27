import { describe, expect, it } from "vitest";
import { EngineError } from "@/lib/engine/types";
import { SLACK_ERRORS } from "../errors";
import {
  buildMessageText,
  looksLikeChannelId,
  normaliseChannelRef,
  parseLimit,
  parseThreadTs,
} from "./config";

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

describe("normaliseChannelRef", () => {
  it("trims and drops a single leading #", () => {
    expect(normaliseChannelRef("#engineering")).toBe("engineering");
    expect(normaliseChannelRef("  #engineering  ")).toBe("engineering");
    expect(normaliseChannelRef("engineering")).toBe("engineering");
    expect(normaliseChannelRef("C0ABC12345")).toBe("C0ABC12345");
    expect(normaliseChannelRef("")).toBe("");
  });
});

describe("looksLikeChannelId", () => {
  it("accepts public, private and direct-message ids", () => {
    expect(looksLikeChannelId("C0ABC12345")).toBe(true);
    expect(looksLikeChannelId("G0ABC12345")).toBe(true);
    expect(looksLikeChannelId("D0ABC12345")).toBe(true);
    expect(looksLikeChannelId("c0abc12345")).toBe(true);
  });

  it("rejects names, users and ids that are too short", () => {
    for (const ref of ["engineering", "#general", "U0ABC12345", "C0ABC", ""]) {
      expect(looksLikeChannelId(ref)).toBe(false);
    }
  });
});

describe("parseThreadTs", () => {
  it("accepts Slack message timestamps", () => {
    expect(parseThreadTs("1758888888.000100")).toBe("1758888888.000100");
    expect(parseThreadTs(" 1758888888.123456789 ")).toBe("1758888888.123456789");
  });

  it("refuses anything that is not a message ts", () => {
    for (const bad of ["", "   ", "abc", "1758888888", "1758888888.", "1758.000100", null, undefined]) {
      expectError(() => parseThreadTs(bad as string), SLACK_ERRORS.threadInvalid);
    }
  });
});

describe("buildMessageText", () => {
  it("returns the body untouched when nobody is notified", () => {
    expect(buildMessageText("Deploy finished", "none")).toBe("Deploy finished");
    expect(buildMessageText("Deploy finished", undefined)).toBe("Deploy finished");
    expect(buildMessageText("Deploy finished", "nonsense")).toBe("Deploy finished");
    expect(buildMessageText("  line one\nline two  ", "none")).toBe("  line one\nline two  ");
  });

  it("prefixes @here and @channel on their own line", () => {
    expect(buildMessageText("Deploy finished", "here")).toBe("<!here>\nDeploy finished");
    expect(buildMessageText("Deploy finished", "channel")).toBe("<!channel>\nDeploy finished");
  });

  it("refuses an empty message, with or without a mention", () => {
    expectError(() => buildMessageText("", "none"), SLACK_ERRORS.messageEmpty);
    expectError(() => buildMessageText("   \n  ", "none"), SLACK_ERRORS.messageEmpty);
    expectError(() => buildMessageText("", "here"), SLACK_ERRORS.messageEmpty);
  });
});

describe("parseLimit", () => {
  it("takes a sane number as-is", () => {
    expect(parseLimit(25, 20, 50)).toBe(25);
    expect(parseLimit("25", 20, 50)).toBe(25);
    expect(parseLimit(" 25 ", 20, 50)).toBe(25);
    expect(parseLimit(7.9, 20, 50)).toBe(7);
  });

  it("falls back for empty or unreadable values", () => {
    expect(parseLimit(undefined, 20, 50)).toBe(20);
    expect(parseLimit("", 20, 50)).toBe(20);
    expect(parseLimit("soon", 20, 50)).toBe(20);
    expect(parseLimit(0, 20, 50)).toBe(20);
    expect(parseLimit(-3, 20, 50)).toBe(20);
    expect(parseLimit(Number.NaN, 20, 50)).toBe(20);
  });

  it("caps at max and never returns less than one", () => {
    expect(parseLimit(500, 20, 50)).toBe(50);
    expect(parseLimit("500", 20, 50)).toBe(50);
    expect(parseLimit(0.4, 20, 50)).toBe(1);
  });
});
