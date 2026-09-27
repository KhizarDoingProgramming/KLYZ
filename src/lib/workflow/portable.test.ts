import { describe, expect, it } from "vitest";

import {
  PORTABLE_FORMAT,
  PORTABLE_LIMITS,
  PORTABLE_VERSION,
  PortableFormatError,
  isBlockingImportIssue,
  portableFromWorkflow,
  portableToWorkflow,
  stableNodeIds,
  type PortableWorkflow,
} from "@/lib/workflow/portable";
import { validateWorkflow } from "@/lib/workflow/validation";
import type { Workflow } from "@/lib/workflow/types";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function baseWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf_original",
    name: "Lead routing",
    description: "New signups to Slack",
    status: "draft",
    tags: ["leads"],
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-02-02T03:04:05.000Z",
    lastExecutedAt: "2026-03-02T03:04:05.000Z",
    executionCount: 42,
    successRate: 0.9,
    avgDurationMs: 120,
    triggerType: "trigger.manual",
    nodeCount: 3,
    nodes: [
      {
        id: "start",
        type: "trigger.manual",
        position: { x: 0, y: 0 },
        data: { ref: "", config: {} },
      },
      {
        id: "call",
        type: "action.http",
        position: { x: 200, y: 0 },
        data: {
          ref: "call",
          config: {
            method: "POST",
            url: "https://example.test/hook",
            credential: "cred_abc123",
          },
        },
      },
      {
        id: "note",
        type: "action.log",
        position: { x: 400, y: 0 },
        data: { ref: "", config: { message: "{{call.body.id}}", level: "info" } },
      },
    ],
    edges: [
      { id: "e1", source: "start", target: "call" },
      { id: "e2", source: "call", target: "note" },
    ],
    ...overrides,
  };
}

function expectFormatError(fn: () => unknown, code: string): PortableFormatError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "expected the call to throw").toBeInstanceOf(PortableFormatError);
  const error = thrown as PortableFormatError;
  expect(error.code).toBe(code);
  expect(error.status).toBeGreaterThanOrEqual(400);
  return error;
}

function issueIds(error: PortableFormatError): string[] {
  return error.issues.map((entry) => entry.id);
}

function resolveSlack(credentialId: string) {
  return credentialId === "cred_abc123" ? { provider: "slack", name: "Acme" } : null;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

describe("portable export", () => {
  it("names the format and version", () => {
    const { portable } = portableFromWorkflow(baseWorkflow());
    expect(portable.format).toBe(PORTABLE_FORMAT);
    expect(portable.version).toBe(PORTABLE_VERSION);
  });

  it("projects only the definition — no workspace, run or version data", () => {
    const { portable } = portableFromWorkflow(baseWorkflow(), {
      resolveCredential: resolveSlack,
    });
    const json = JSON.stringify(portable);

    for (const forbidden of [
      "wf_original",
      "createdAt",
      "updatedAt",
      "lastExecutedAt",
      "executionCount",
      "successRate",
      "avgDurationMs",
      "status",
      "published",
      "cred_abc123",
      "ws_",
      "usr_",
    ]) {
      expect(json, `portable document must not contain "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
    expect(Object.keys(portable).sort()).toEqual([
      "description",
      "edges",
      "format",
      "metadata",
      "name",
      "nodes",
      "trigger",
      "version",
    ]);
  });

  it("produces byte-identical bytes for the same definition", () => {
    const first = portableFromWorkflow(baseWorkflow(), {
      resolveCredential: resolveSlack,
    });
    const second = portableFromWorkflow(baseWorkflow(), {
      resolveCredential: resolveSlack,
    });
    expect(JSON.stringify(first.portable)).toBe(JSON.stringify(second.portable));
  });

  it("turns credential ids into provider/name references", () => {
    const { portable, warnings } = portableFromWorkflow(baseWorkflow(), {
      resolveCredential: resolveSlack,
    });
    const http = portable.nodes.find((node) => node.type === "action.http");
    expect(http?.config.credential).toBeUndefined();
    expect(http?.credentials).toEqual({ credential: { provider: "slack", name: "Acme" } });
    expect(warnings.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("drops an unreadable credential and says so rather than inventing one", () => {
    const { portable, warnings } = portableFromWorkflow(baseWorkflow(), {
      resolveCredential: () => null,
    });
    const http = portable.nodes.find((node) => node.type === "action.http");
    expect(http?.config.credential).toBeUndefined();
    expect(http?.credentials).toBeUndefined();
    expect(warnings.map((entry) => entry.id)).toContain("warning_credential_unresolved");
  });

  it("never writes a webhook secret or a secret-shaped value", () => {
    const workflow = baseWorkflow({
      nodes: [
        {
          id: "hook",
          type: "trigger.webhook",
          position: { x: 0, y: 0 },
          data: {
            ref: "",
            config: {
              path: "/hooks/a",
              method: "POST",
              auth: "header",
              secret: "whsec_supersecretvalue",
            },
          },
        },
        {
          id: "log",
          type: "action.log",
          position: { x: 200, y: 0 },
          data: { ref: "", config: { message: "hi", level: "info", apiKey: "sk-abc12345" } },
        },
      ],
      edges: [{ id: "e1", source: "hook", target: "log" }],
      triggerType: "trigger.webhook",
      nodeCount: 2,
    });

    const { portable, warnings } = portableFromWorkflow(workflow);
    const json = JSON.stringify(portable);
    expect(json).not.toContain("whsec_supersecretvalue");
    expect(json).not.toContain("sk-abc12345");
    expect(warnings.map((entry) => entry.id)).toContain("warning_secret_removed");
  });

  it("removes runtime state the editor adds to a live workflow", () => {
    const { portable } = portableFromWorkflow(baseWorkflow());
    expect(portable.nodes.map((node) => node.id)).toEqual(["manual_1", "http_1", "log_1"]);
    expect(portable.edges.map((edge) => edge.id)).toEqual(["edge_1", "edge_2"]);
  });
});

/* ------------------------------------------------------------------ */
/* Parsing an untrusted document                                       */
/* ------------------------------------------------------------------ */

describe("portable parsing", () => {
  const good = () => portableFromWorkflow(baseWorkflow()).portable;

  it("refuses anything that is not a klyz.workflow document", () => {
    expectFormatError(() => portableToWorkflow({ format: "other" }, { id: "wf_x" }), "IMPORT_UNSUPPORTED_FORMAT");
    expectFormatError(() => portableToWorkflow([], { id: "wf_x" }), "IMPORT_INVALID");
    expectFormatError(() => portableToWorkflow("not json {", { id: "wf_x" }), "IMPORT_MALFORMED_JSON");
  });

  it("refuses a version from a newer KLYZ", () => {
    expectFormatError(
      () => portableToWorkflow({ ...good(), version: PORTABLE_VERSION + 1 }, { id: "wf_x" }),
      "IMPORT_UNSUPPORTED_VERSION",
    );
  });

  it("refuses a document with no steps", () => {
    expectFormatError(
      () => portableToWorkflow({ ...good(), nodes: [] }, { id: "wf_x" }),
      "IMPORT_EMPTY",
    );
  });

  it("refuses more steps or connections than the limits allow", () => {
    const nodes = Array.from({ length: PORTABLE_LIMITS.maxNodes + 1 }, (_, index) => ({
      id: `n${index}`,
      type: "action.log",
      position: { x: 0, y: 0 },
      config: {},
    }));
    expectFormatError(
      () => portableToWorkflow({ ...good(), nodes }, { id: "wf_x" }),
      "IMPORT_TOO_MANY_STEPS",
    );
  });

  it("refuses two steps that share an id", () => {
    const doc = good();
    doc.nodes[1]!.id = doc.nodes[0]!.id;
    expectFormatError(() => portableToWorkflow(doc, { id: "wf_x" }), "IMPORT_DUPLICATE_ID");
  });

  it("refuses a connection that points outside the document", () => {
    const doc = good();
    doc.edges[0]!.target = "ghost";
    const error = expectFormatError(() => portableToWorkflow(doc, { id: "wf_x" }), "IMPORT_UNSUPPORTED");
    expect(issueIds(error)).toContain("edge_missing_dangling");
  });

  it("refuses a configuration value this build cannot read", () => {
    const doc = good();
    doc.nodes[1]!.config = {
      url: "x".repeat(PORTABLE_LIMITS.maxStringChars + 1),
    };
    const error = expectFormatError(() => portableToWorkflow(doc, { id: "wf_x" }), "IMPORT_INVALID");
    expect(issueIds(error)).toContain("import_value_too_long");
  });

  it("refuses a step type this build does not have", () => {
    const doc = good();
    doc.nodes[1]!.type = "capability.something_new";
    const error = expectFormatError(() => portableToWorkflow(doc, { id: "wf_x" }), "IMPORT_UNSUPPORTED");
    expect(issueIds(error)).toContain("capability_unknown_node");
  });
});

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

describe("portable import", () => {
  const good = () => portableFromWorkflow(baseWorkflow()).portable;

  it("accepts its own export without blocking issues", () => {
    const { definition, warnings } = portableToWorkflow(good(), { id: "wf_new" });
    expect(validateWorkflow(definition).filter((i) => i.severity === "error")).toEqual([]);
    expect(warnings.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(definition.id).toBe("wf_new");
    expect(definition.status).toBe("draft");
    expect(definition.executionCount).toBe(0);
  });

  it("is byte-stable across export → import → export", () => {
    const first = portableFromWorkflow(baseWorkflow()).portable;
    const { definition } = portableToWorkflow(JSON.parse(JSON.stringify(first)), {
      id: "wf_new",
    });
    const second = portableFromWorkflow(definition).portable;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("gives steps ids this build recognises, and rewrites connections to match", () => {
    const doc = good();
    doc.nodes = [
      { id: "weird one", type: "trigger.manual", position: { x: 0, y: 0 }, config: {} },
      { id: "other/two", type: "action.log", position: { x: 1, y: 1 }, config: { message: "x", level: "info" } },
    ];
    doc.edges = [{ id: "e1", source: "weird one", target: "other/two" }];

    const { definition } = portableToWorkflow(doc, { id: "wf_new" });
    expect(definition.nodes.map((node) => node.id)).toEqual(["manual_1", "log_1"]);
    expect(definition.edges).toHaveLength(1);
    expect(definition.edges[0]!.source).toBe("manual_1");
    expect(definition.edges[0]!.target).toBe("log_1");
    expect(validateWorkflow(definition).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("refuses a graph that runs in a circle", () => {
    const doc = good();
    doc.nodes = [
      { id: "a", type: "trigger.manual", position: { x: 0, y: 0 }, config: {} },
      { id: "b", type: "action.log", position: { x: 1, y: 0 }, config: { message: "x", level: "info" } },
    ];
    doc.edges = [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "a" },
    ];
    const error = expectFormatError(() => portableToWorkflow(doc, { id: "wf_new" }), "IMPORT_UNSUPPORTED");
    expect(issueIds(error)).toContain("graph_cycle");
  });

  it("refuses a step the expression parser cannot read", () => {
    const doc = good();
    doc.nodes[2]!.config = { message: "{{ 1 + }}", level: "info" };
    const error = expectFormatError(() => portableToWorkflow(doc, { id: "wf_new" }), "IMPORT_UNSUPPORTED");
    expect(issueIds(error)).toContain("expression_malformed");
  });

  it("refuses a secret pasted into a step instead of a credential", () => {
    const doc = good();
    doc.nodes[1]!.config = { method: "POST", url: "https://x.test", apiKey: "sk-live_abcdef123" };
    const error = expectFormatError(() => portableToWorkflow(doc, { id: "wf_new" }), "IMPORT_UNSUPPORTED");
    expect(issueIds(error).some((id) => id.startsWith("credential_value_"))).toBe(true);
  });

  /** A two-step document whose only credential field is a Slack connection. */
  function slackDoc(): PortableWorkflow {
    const doc = portableFromWorkflow(baseWorkflow()).portable;
    doc.nodes = [
      { id: "start", type: "trigger.manual", position: { x: 0, y: 0 }, config: {} },
      {
        id: "post",
        type: "action.slack_message",
        position: { x: 200, y: 0 },
        label: "Announce",
        config: { operation: "send", channel: "#leads", message: "New lead" },
        credentials: { credential: { provider: "slack", name: "Acme" } },
      },
    ];
    doc.edges = [{ id: "e1", source: "start", target: "post" }];
    return doc;
  }

  it("reports an unfilled credential as a requirement, not a failure", () => {
    const { requirements, definition } = portableToWorkflow(slackDoc(), { id: "wf_new" });
    expect(requirements).toHaveLength(1);
    const requirement = requirements[0]!;
    expect(requirement.resolved).toBe(false);
    expect(requirement.key).toBe("slack_message_1.credential");
    expect(requirement.providers).toEqual(["slack"]);
    expect(requirement.name).toBe("Acme");
    expect(requirement.fieldLabel).toBeTruthy();
    /* The value never reaches the config: an unresolved requirement is
       an empty field the editor asks the user to fill. */
    expect(definition.nodes[1]?.data.config.credential).toBeUndefined();
  });

  it("accepts an explicit credential choice and writes only its id", () => {
    const { requirements, definition } = portableToWorkflow(slackDoc(), {
      id: "wf_new",
      credentialIds: { "slack_message_1.credential": "cred_picked" },
    });
    expect(requirements[0]?.resolved).toBe(true);
    expect(definition.nodes[1]?.data.config.credential).toBe("cred_picked");
  });

  it("maps a credential automatically only when the name and kind match exactly once", () => {
    const seen: string[] = [];
    portableToWorkflow(slackDoc(), {
      id: "wf_new",
      findCredential: (requirement) => {
        seen.push(`${requirement.providers.join("+")}:${requirement.name}`);
        return requirement.name === "Acme" && requirement.providers.includes("slack")
          ? "cred_auto"
          : null;
      },
    });
    expect(seen).toEqual(["slack:Acme"]);

    /* No candidate at all leaves the requirement open rather than
       guessing a credential of the right-ish kind. */
    const { requirements } = portableToWorkflow(slackDoc(), {
      id: "wf_new",
      findCredential: () => null,
    });
    expect(requirements[0]?.resolved).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Helpers used across the module                                      */
/* ------------------------------------------------------------------ */

describe("helpers", () => {
  it("assigns one id per step type in graph order", () => {
    const mapping = stableNodeIds([
      { id: "a", type: "action.http" },
      { id: "b", type: "action.http" },
      { id: "c", type: "action.log" },
    ]);
    expect([...mapping.values()]).toEqual(["http_1", "http_2", "log_1"]);
  });

  it("classifies which editor issues must stop an import", () => {
    const blocking = isBlockingImportIssue([
      { id: "graph_cycle", severity: "error", message: "cycle" },
      { id: "unknown_n1", severity: "error", message: "unknown" },
      { id: "ref_n1_url_host", severity: "error", message: "dangling ref" },
      { id: "no_trigger", severity: "error", message: "trigger" },
      { id: "missing_n1_credential", severity: "error", message: "needs a connection" },
      { id: "multiple_triggers", severity: "warning", message: "two triggers" },
    ]);
    /* A workflow that still needs a connection is imported and left
       for the editor to finish — that is a requirement, not a
       refusal. Everything structural stops the import. */
    expect(blocking.map((entry) => entry.id)).toEqual([
      "graph_cycle",
      "unknown_n1",
      "ref_n1_url_host",
      "no_trigger",
    ]);
  });

  it("keeps the portable document within the byte ceiling", () => {
    const { portable } = portableFromWorkflow(baseWorkflow());
    expect(Buffer.byteLength(JSON.stringify(portable), "utf8")).toBeLessThanOrEqual(
      PORTABLE_LIMITS.maxBytes,
    );
  });

  it("strips state that would make two exports of one graph disagree", () => {
    const { portable }: { portable: PortableWorkflow } = portableFromWorkflow(baseWorkflow());
    expect(portable.metadata?.nodeCount).toBe(3);
    expect(portable.metadata?.tags).toEqual(["leads"]);
    expect(portable.trigger.type).toBe("trigger.manual");
  });
});
