import { describe, expect, it } from "vitest";
import { EngineError } from "@/lib/engine/types";
import {
  GITHUB_EVENTS,
  findEvent,
  hookEventsFor,
  matchesEvent,
  parseIssueNumber,
  parseLabels,
  parseLogin,
  parseRepository,
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

describe("parseRepository", () => {
  it("splits a well-formed owner/name", () => {
    expect(parseRepository("klyz/platform")).toEqual({
      owner: "klyz",
      name: "platform",
      fullName: "klyz/platform",
    });
    expect(parseRepository("  klyz/my-service.v2  ")).toEqual({
      owner: "klyz",
      name: "my-service.v2",
      fullName: "klyz/my-service.v2",
    });
    expect(parseRepository("octo-org/Sub")).toEqual({
      owner: "octo-org",
      name: "Sub",
      fullName: "octo-org/Sub",
    });
  });

  it("refuses anything that is not exactly owner/name", () => {
    for (const bad of ["", "platform", "klyz/", "/platform", "a/b/c", "klyz/my repo", "k lyz/p", 42]) {
      expectError(() => parseRepository(bad), "GITHUB_REPOSITORY_INVALID");
    }
  });

  it("refuses owners and names GitHub would reject", () => {
    expectError(() => parseRepository("-leading/platform"), "GITHUB_REPOSITORY_INVALID");
    expectError(() => parseRepository(`klyz/${"x".repeat(101)}`), "GITHUB_REPOSITORY_INVALID");
    expectError(() => parseRepository("../etc/passwd"), "GITHUB_REPOSITORY_INVALID");
  });
});

describe("parseIssueNumber", () => {
  it("accepts numbers and numeric strings", () => {
    expect(parseIssueNumber(1042)).toBe(1042);
    expect(parseIssueNumber("1042")).toBe(1042);
    expect(parseIssueNumber("  7 ")).toBe(7);
    expect(parseIssueNumber(1)).toBe(1);
  });

  it("rejects zero, negatives, fractions and text", () => {
    for (const bad of [0, -1, 1.5, "abc", "", null, undefined, {}, 3_000_000_000]) {
      expectError(() => parseIssueNumber(bad), "GITHUB_ISSUE_NUMBER_INVALID");
    }
  });
});

describe("event matching", () => {
  it("maps a config value onto the hook header and action", () => {
    expect(hookEventsFor("issues.opened")).toEqual(["issues"]);
    expect(hookEventsFor("push")).toEqual(["push"]);
    expect(hookEventsFor("release.published")).toEqual(["release"]);
    expect(hookEventsFor("nonsense")).toEqual([]);
    expect(findEvent("pull_request.opened")?.label).toBe("Pull request opened");
    expect(findEvent("nope")).toBeUndefined();
  });

  it("matches on hook event and, when declared, on action", () => {
    expect(matchesEvent("issues.opened", "issues", "opened")).toBe(true);
    expect(matchesEvent("issues.opened", "issues", "closed")).toBe(false);
    expect(matchesEvent("issues.opened", "push")).toBe(false);
    expect(matchesEvent("push", "push")).toBe(true);
    expect(matchesEvent("push", "push", "anything")).toBe(true);
    expect(matchesEvent("release.published", "release", "published")).toBe(true);
    expect(matchesEvent("release.published", "release", "edited")).toBe(false);
    expect(matchesEvent("unknown.event", "issues", "opened")).toBe(false);
  });

  it("covers every advertised event with a hook name", () => {
    for (const spec of GITHUB_EVENTS) {
      expect(hookEventsFor(spec.value)).toEqual([spec.hookEvent]);
      expect(matchesEvent(spec.value, spec.hookEvent, spec.action)).toBe(true);
    }
  });
});

describe("labels and logins", () => {
  it("splits comma-separated labels and drops invalid ones", () => {
    expect(parseLabels("bug, needs-triage ,")).toEqual(["bug", "needs-triage"]);
    expect(parseLabels(["bug", " docs "])).toEqual(["bug", "docs"]);
    expect(parseLabels("")).toEqual([]);
    expect(parseLabels(undefined)).toEqual([]);
    expect(parseLabels(`${"x".repeat(101)},ok`)).toEqual(["ok"]);
  });

  it("normalises logins and rejects invalid ones", () => {
    expect(parseLogin("@octocat")).toBe("octocat");
    expect(parseLogin("octocat")).toBe("octocat");
    expect(parseLogin(" ")).toBeNull();
    expect(parseLogin("@")).toBeNull();
    expect(parseLogin("not a login")).toBeNull();
    expect(parseLogin("@-leading")).toBeNull();
  });
});
