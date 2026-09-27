import { describe, expect, it } from "vitest";
import {
  ExplanationParseError,
  parseFailureExplanation,
  parseWorkflowExplanation,
} from "./explain";

/**
 * Explanations are shown to humans, so they get the same strict parse
 * as plans: no invented fields, bounded length, and `supported` flags
 * that only survive when the model actually set them.
 */

describe("parseWorkflowExplanation", () => {
  it("accepts a summary with sections", () => {
    const parsed = parseWorkflowExplanation({
      summary: "Posts a daily digest to Slack.",
      sections: [
        { title: "Trigger", items: ["Runs every weekday at 9am."] },
        { title: "Steps", items: ["Fetch rows", "Format text", "Post message"] },
      ],
    });
    expect(parsed.summary).toContain("Slack");
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[1]?.items).toHaveLength(3);
  });

  it("rejects non-objects and empty summaries, and drops unknown fields", () => {
    expect(() => parseWorkflowExplanation(null)).toThrow(ExplanationParseError);
    expect(() => parseWorkflowExplanation({ summary: "" })).toThrow(ExplanationParseError);
    expect(() => parseWorkflowExplanation({ sections: [] })).toThrow(ExplanationParseError);
    const parsed = parseWorkflowExplanation({
      summary: "ok",
      sections: [{ title: "T", items: ["one"] }],
      confidence: 0.9,
    });
    expect("confidence" in parsed).toBe(false);
  });

  it("bounds sections and items", () => {
    expect(() =>
      parseWorkflowExplanation({
        summary: "ok",
        sections: Array.from({ length: 12 }, (_, index) => ({
          title: `S${index}`,
          items: Array.from({ length: 12 }, (_, item) => `i${item}`),
        })),
      }),
    ).toThrow(ExplanationParseError);
  });
});

describe("parseFailureExplanation", () => {
  it("keeps observed facts, causes and next steps apart", () => {
    const parsed = parseFailureExplanation({
      summary: "The Slack step could not post.",
      observed: ["Step “Slack message” failed after 2 attempts."],
      causes: [
        { text: "The channel does not exist.", supported: true },
        { text: "Slack may be rate limiting.", supported: false },
      ],
      nextSteps: ["Check the channel name."],
    });
    expect(parsed.observed).toHaveLength(1);
    expect(parsed.causes[0]).toEqual({ text: "The channel does not exist.", supported: true });
    expect(parsed.causes[1]?.supported).toBe(false);
    expect(parsed.nextSteps[0]).toContain("channel");
  });

  it("insists on an explicit supported flag — a guess is never implied", () => {
    expect(() =>
      parseFailureExplanation({ summary: "Failed.", causes: [{ text: "Maybe DNS." }] }),
    ).toThrow(/supported must be true or false/);
    expect(() =>
      parseFailureExplanation({
        summary: "Failed.",
        causes: [{ text: "Maybe DNS.", supported: false }],
      }),
    ).toThrow(/observed must list at least one fact/);
  });

  it("rejects unusable shapes", () => {
    expect(() => parseFailureExplanation([])).toThrow(ExplanationParseError);
    expect(() =>
      parseFailureExplanation({ summary: "ok", observed: ["fact"], causes: "many" }),
    ).toThrow(ExplanationParseError);
    expect(() =>
      parseFailureExplanation({ summary: "ok", observed: [1], causes: [] }),
    ).toThrow(ExplanationParseError);
  });
});
