import { describe, expect, it } from "vitest";
import type { NodeRunContext } from "@/lib/engine/types";
import type { Workflow } from "@/lib/workflow/types";
import { operationsHandler, transformMappingHandler } from "./handler";

function makeContext(
  config: Record<string, unknown>,
  scope: Record<string, unknown>,
  rawConfig?: Record<string, unknown>,
): NodeRunContext {
  return {
    executionId: "ex_transform_test",
    workspaceId: "ws_test",
    workflow: { id: "wf_transform_test", name: "Transform test" } as unknown as Workflow,
    nodeId: "n_transform",
    nodeType: "logic.transform",
    config,
    rawConfig: rawConfig ?? config,
    scope: scope as NodeRunContext["scope"],
    triggerInput: null,
    attempt: 1,
    signal: new AbortController().signal,
    publishStatus: () => undefined,
  };
}

describe("logic.transform mapping", () => {
  it("parses the authored mapping and resolves bare expressions typed", () => {
    const raw =
      '{\n  "email": {{webhook.body.email}},\n  "n": {{webhook.body.n}},\n  "ok": {{webhook.body.ok}}\n}';
    /* The outer pass has already flattened the mapping to text — the
       handler must still work from the authored form. */
    const flattened = raw
      .replace("{{webhook.body.email}}", "ada@example.com")
      .replace("{{webhook.body.n}}", "7")
      .replace("{{webhook.body.ok}}", "true");

    const { output } = transformMappingHandler(
      makeContext(
        { mapping: flattened },
        { webhook: { body: { email: "ada@example.com", n: 7, ok: true } } },
        { mapping: raw },
      ),
    ) as { output: Record<string, unknown> };

    expect(output.value).toEqual({ email: "ada@example.com", n: 7, ok: true });
  });

  it("keeps object references as objects", () => {
    const { output } = transformMappingHandler(
      makeContext(
        { mapping: '{"who": {{webhook.body.user}}}' },
        { webhook: { body: { user: { name: "Ada", id: 9 } } } },
        { mapping: '{"who": {{webhook.body.user}}}' },
      ),
    ) as { output: Record<string, unknown> };
    expect(output.value).toEqual({ who: { name: "Ada", id: 9 } });
  });

  it("rejects a mapping that is not JSON", () => {
    expect(() =>
      transformMappingHandler(
        makeContext({ mapping: "not json at all" }, {}, { mapping: "not json at all" }),
      ),
    ).toThrowError(/not valid JSON/);
  });
});

describe("logic.operations", () => {
  it("requires an operation", () => {
    expect(() => operationsHandler(makeContext({}, {}))).toThrowError(/operation/i);
  });
});
