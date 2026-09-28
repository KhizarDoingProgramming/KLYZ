import { afterAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

process.env.KLYZ_QUEUE_DRIVER = "memory";

/* One private database for this file: nothing else can see its rows. */
openTestDatabase("klyz_provider_webhooks");

import { HttpError } from "./http";
import { defaultActor } from "./identity";
import { queryAll, queryOne, run as sqlRun } from "./db";
import { endTestDatabase, openTestDatabase } from "./testing";
import { encryptSecret, upsertOAuthCredential } from "./credentials";
import { upsertWorkflowVersion } from "./execution-service";
import type { ExecutionDetail } from "@/lib/execution/types";
import {
  DuplicateDelivery,
  getProviderWebhook,
  publishProviderWebhook,
  receiveProviderDelivery,
} from "./provider-webhooks";
import { signGitHubPayload } from "@/lib/integrations/github/webhook";
import type { Workflow } from "@/lib/workflow/types";

const actor = defaultActor();
const SECRET = "klyz_hook_secret";

afterAll(async () => {
  await endTestDatabase();
});

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

function workflow(id: string, triggerConfig: Record<string, unknown>): Workflow {
  return {
    id,
    name: `Provider ${id}`,
    description: "",
    status: "draft",
    tags: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastExecutedAt: null,
    executionCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    triggerType: "trigger.github",
    nodeCount: 2,
    nodes: [
      {
        id: "trigger",
        type: "trigger.github",
        position: { x: 0, y: 0 },
        data: { ref: "github", config: triggerConfig },
      },
      {
        id: "log",
        type: "action.log",
        position: { x: 240, y: 0 },
        data: { ref: "log", config: { message: "event {{github.event}}", level: "info" } },
      },
    ],
    edges: [{ id: "e1", source: "trigger", target: "log" }],
  };
}

function registerHook(
  key: string,
  workflowId: string,
  events: string,
  target = "klyz/platform",
): void {
  sqlRun(
    `INSERT INTO provider_webhooks
       (id, provider, workspace_id, workflow_id, workflow_version_id, credential_id,
        target, events, url_key, secret_enc, mode, status, created_at, updated_at)
     VALUES (?, 'github', ?, ?, NULL, NULL, ?, ?, ?, ?, 'manual', 'ready', ?, ?)`,
    `pwh_${key}`,
    actor.workspaceId,
    workflowId,
    target,
    events,
    key,
    encryptSecret(SECRET),
    Date.now(),
    Date.now(),
  );
}

function deliveryRequest(
  key: string,
  options: { body: string; event: string; delivery: string; signature?: string },
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": options.event,
    "x-github-delivery": options.delivery,
  };
  if (options.signature !== undefined) headers["x-hub-signature-256"] = options.signature;
  return new Request(`http://localhost/api/providers/github/hooks/${key}`, {
    method: "POST",
    body: options.body,
    headers,
  });
}

async function runFor(workflowId: string): Promise<ExecutionDetail> {
  const row = queryOne<{ id: string }>(
    "SELECT id FROM executions WHERE workflow_id = ? ORDER BY COALESCE(started_at, 0) DESC, created_at DESC, id DESC LIMIT 1",
    workflowId,
  );
  if (!row) throw new Error("no execution found");
  const deadline = Date.now() + 10_000;
  for (;;) {
    const detail = queryOne<{ status: string }>(
      "SELECT status FROM executions WHERE id = ?",
      row.id,
    );
    if (detail && ["completed", "failed", "cancelled"].includes(detail.status)) {
      const { getExecutionDetailFor } = await import("./execution-service");
      return getExecutionDetailFor(actor, row.id);
    }
    if (Date.now() > deadline) throw new Error("execution did not settle");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function executionsFor(workflowId: string): string[] {
  return queryAll<{ id: string }>("SELECT id FROM executions WHERE workflow_id = ?", workflowId).map(
    (row) => row.id,
  );
}

async function expectFailure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the delivery to be rejected");
    },
    (error: unknown) => error,
  );
}

/* ------------------------------------------------------------------ */
/* Receiving                                                           */
/* ------------------------------------------------------------------ */

describe("provider endpoint lookup", () => {
  it("404s an unknown key", async () => {
    const error = await expectFailure(
      receiveProviderDelivery(
        new Request("http://localhost/api/providers/github/hooks/nope", {
          method: "POST",
          body: "{}",
        }),
        "github",
        "nope",
      ),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect((error as HttpError).code).toBe("PROVIDER_HOOK_NOT_FOUND");
  });

  it("does not resolve a key that belongs to another provider", async () => {
    const key = "shared_key";
    registerHook(key, "wf_shared", "issues");
    const error = await expectFailure(
      receiveProviderDelivery(
        new Request("http://localhost/api/providers/gmail/hooks/shared_key", {
          method: "POST",
          body: "{}",
        }),
        "gmail",
        key,
      ),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe("PROVIDER_HOOK_NOT_FOUND");
  });
});

describe("GitHub deliveries", () => {
  it("rejects a delivery whose signature does not match the secret", async () => {
    const id = "wf_signature";
    upsertWorkflowVersion(actor, workflow(id, { credential: "cred_x", event: "issues.opened", repository: "klyz/platform" }));
    const key = "sig_key";
    registerHook(key, id, "issues");

    const body = JSON.stringify({ action: "opened" });
    const error = await expectFailure(
      receiveProviderDelivery(
        deliveryRequest(key, {
          body,
          event: "issues",
          delivery: "delivery-bad",
          signature: signGitHubPayload(body, "some_other_secret"),
        }),
        "github",
        key,
      ),
    );
    expect((error as HttpError).status).toBe(401);
    expect((error as HttpError).code).toBe("GITHUB_DELIVERY_REJECTED");

    const error2 = await expectFailure(
      receiveProviderDelivery(
        deliveryRequest(key, { body, event: "issues", delivery: "delivery-unsigned" }),
        "github",
        key,
      ),
    );
    expect((error2 as HttpError).code).toBe("GITHUB_DELIVERY_REJECTED");

    const view = getProviderWebhook(actor, id);
    expect(view?.lastDeliveryStatus).toBe("rejected");
    expect(view?.deliveryCount).toBe(2);
    expect(executionsFor(id)).toHaveLength(0);
  });

  it("acknowledges a ping without starting a run", async () => {
    const id = "wf_ping";
    upsertWorkflowVersion(actor, workflow(id, { credential: "cred_x", event: "issues.opened", repository: "klyz/platform" }));
    const key = "ping_key";
    registerHook(key, id, "issues");

    const body = JSON.stringify({ zen: "Design for failure." });
    const result = await receiveProviderDelivery(
      deliveryRequest(key, {
        body,
        event: "ping",
        delivery: "delivery-ping",
        signature: signGitHubPayload(body, SECRET),
      }),
      "github",
      key,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, event: "ping" });
    expect(executionsFor(id)).toHaveLength(0);
    expect(getProviderWebhook(actor, id)?.lastDeliveryStatus).toBe("accepted");
  });

  it("ignores an event the workflow did not subscribe to", async () => {
    const id = "wf_filter";
    upsertWorkflowVersion(actor, workflow(id, { credential: "cred_x", event: "issues.opened", repository: "klyz/platform" }));
    const key = "filter_key";
    registerHook(key, id, "issues");

    const body = JSON.stringify({ action: "closed", issue: { number: 1 } });
    const result = await receiveProviderDelivery(
      deliveryRequest(key, {
        body,
        event: "pull_request",
        delivery: "delivery-other-event",
        signature: signGitHubPayload(body, SECRET),
      }),
      "github",
      key,
    );
    expect(result.status).toBe(200);
    expect(result.body.ignored).toBe(true);
    expect(executionsFor(id)).toHaveLength(0);
    expect(getProviderWebhook(actor, id)?.lastDeliveryStatus).toBe("ignored");
  });

  it("starts one run for a matching delivery and none for its redelivery", async () => {
    const id = "wf_issues";
    upsertWorkflowVersion(
      actor,
      workflow(id, { credential: "cred_x", event: "issues.opened", repository: "klyz/platform" }),
    );
    const key = "issues_key";
    registerHook(key, id, "issues");

    const body = JSON.stringify({
      action: "opened",
      repository: { name: "platform", owner: { login: "klyz" } },
      issue: { number: 42, title: "Export fails" },
    });
    const signed = signGitHubPayload(body, SECRET);

    const first = await receiveProviderDelivery(
      deliveryRequest(key, { body, event: "issues", delivery: "delivery-once", signature: signed }),
      "github",
      key,
    );
    expect(first.status).toBe(202);
    expect(String(first.body.executionId)).toMatch(/^ex_/);

    const duplicate = await expectFailure(
      receiveProviderDelivery(
        deliveryRequest(key, {
          body,
          event: "issues",
          delivery: "delivery-once",
          signature: signed,
        }),
        "github",
        key,
      ),
    );
    expect(duplicate).toBeInstanceOf(DuplicateDelivery);
    expect((duplicate as DuplicateDelivery).executionId).toBe(first.body.executionId);

    expect(executionsFor(id)).toHaveLength(1);

    const execution = await runFor(id);
    expect(execution.status).toBe("completed");
    expect(execution.source).toBe("webhook");
    const trigger = execution.steps.find((step) => step.nodeId === "trigger");
    expect(trigger?.output).toMatchObject({
      event: "issues",
      action: "opened",
      repository: "klyz/platform",
      issueNumber: 42,
      title: "Export fails",
    });
  });

  it("applies the branch filter declared on the node", async () => {
    const id = "wf_push";
    upsertWorkflowVersion(
      actor,
      workflow(id, {
        credential: "cred_x",
        event: "push",
        branch: "main",
        repository: "klyz/platform",
      }),
    );
    const key = "push_key";
    registerHook(key, id, "push");

    const offBranch = JSON.stringify({ ref: "refs/heads/feature", commits: [] });
    const ignored = await receiveProviderDelivery(
      deliveryRequest(key, {
        body: offBranch,
        event: "push",
        delivery: "delivery-branch-no",
        signature: signGitHubPayload(offBranch, SECRET),
      }),
      "github",
      key,
    );
    expect(ignored.status).toBe(200);
    expect(ignored.body.ignored).toBe(true);
    expect(executionsFor(id)).toHaveLength(0);

    const onBranch = JSON.stringify({ ref: "refs/heads/main", commits: [] });
    const accepted = await receiveProviderDelivery(
      deliveryRequest(key, {
        body: onBranch,
        event: "push",
        delivery: "delivery-branch-yes",
        signature: signGitHubPayload(onBranch, SECRET),
      }),
      "github",
      key,
    );
    expect(accepted.status).toBe(202);
    expect(executionsFor(id)).toHaveLength(1);
    await runFor(id);
  });

  it("counts deliveries and keeps the last status on the endpoint", async () => {
    const id = "wf_bookkeeping";
    upsertWorkflowVersion(
      actor,
      workflow(id, { credential: "cred_x", event: "issues.opened", repository: "klyz/platform" }),
    );
    const key = "bookkeeping_key";
    registerHook(key, id, "issues");

    const body = JSON.stringify({ action: "opened", issue: { number: 7 } });
    await receiveProviderDelivery(
      deliveryRequest(key, {
        body,
        event: "issues",
        delivery: "delivery-count-1",
        signature: signGitHubPayload(body, SECRET),
      }),
      "github",
      key,
    );
    await receiveProviderDelivery(
      deliveryRequest(key, {
        body,
        event: "issues",
        delivery: "delivery-count-2",
        signature: signGitHubPayload(body, SECRET),
      }),
      "github",
      key,
    );

    const view = getProviderWebhook(actor, id);
    expect(view?.deliveryCount).toBe(2);
    expect(view?.lastDeliveryStatus).toBe("accepted");
    expect(view?.lastDeliveryAt).toBeTruthy();
    expect(executionsFor(id)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Slack deliveries                                                    */
/* ------------------------------------------------------------------ */

const SLACK_SECRET = "8f7c1e2a signing secret";

/** One connection every Slack workflow below references — a trigger
 *  cannot publish (or run) without one. */
const slackConnection = upsertOAuthCredential({
  workspaceId: actor.workspaceId,
  kind: "slack",
  name: "KLYZ",
  fields: { accessToken: "xoxb-1", teamId: "T07KLYZ" },
  account: "klyz",
  scopes: ["chat:write"],
  expiresAt: null,
});

function slackWorkflow(id: string, triggerConfig: Record<string, unknown>): Workflow {
  return {
    ...workflow(id, triggerConfig),
    triggerType: "trigger.slack",
    nodes: [
      {
        id: "trigger",
        type: "trigger.slack",
        position: { x: 0, y: 0 },
        data: { ref: "slack", config: triggerConfig },
      },
      {
        id: "log",
        type: "action.log",
        position: { x: 240, y: 0 },
        data: { ref: "log", config: { message: "from {{slack.userName}}", level: "info" } },
      },
    ],
  };
}

function registerSlackHook(
  key: string,
  workflowId: string,
  options: { target?: string; credentialId?: string | null } = {},
): void {
  sqlRun(
    `INSERT INTO provider_webhooks
       (id, provider, workspace_id, workflow_id, workflow_version_id, credential_id,
        target, events, url_key, secret_enc, mode, status, created_at, updated_at)
     VALUES (?, 'slack', ?, ?, NULL, ?, ?, 'message', ?, ?, 'manual', 'ready', ?, ?)`,
    `pwh_${key}`,
    actor.workspaceId,
    workflowId,
    options.credentialId ?? null,
    options.target ?? "",
    key,
    encryptSecret(SLACK_SECRET),
    Date.now(),
    Date.now(),
  );
}

/** Slack's own signing scheme: `v0=<hmac of "v0:<ts>:<body>">`. */
function slackSignature(body: string, timestamp: string, secret = SLACK_SECRET): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

function slackRequest(
  key: string,
  body: string,
  options: { signature?: string | null; timestamp?: string } = {},
): Request {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
  };
  if (options.signature !== undefined && options.signature !== null) {
    headers["x-slack-signature"] = options.signature;
  } else if (options.signature === undefined) {
    headers["x-slack-signature"] = slackSignature(body, timestamp);
  }
  return new Request(`http://localhost/api/providers/slack/hooks/${key}`, {
    method: "POST",
    body,
    headers,
  });
}

/** A signed-by-Slack `event_callback`; `event` and `envelope` are patchable. */
function messagePayload(
  event: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: "T07KLYZ",
    event_id: "Ev_default",
    event: {
      type: "message",
      channel: "C07SUPPORT1",
      user: "U07NADIA",
      username: "nadia-k",
      text: "Deploy 4.12 is failing health checks",
      ts: "1758800000.004200",
      team: "T07KLYZ",
      ...event,
    },
    ...envelope,
  };
}

describe("Slack deliveries", () => {
  it("rejects an unsigned or mis-signed delivery", async () => {
    const id = "wf_slack_signature";
    upsertWorkflowVersion(actor, slackWorkflow(id, { credential: slackConnection.id }));
    const key = "slack_sig_key";
    registerSlackHook(key, id);

    const body = JSON.stringify(messagePayload());
    const error = await expectFailure(
      receiveProviderDelivery(slackRequest(key, body, { signature: "v0=deadbeef" }), "slack", key),
    );
    expect((error as HttpError).status).toBe(401);
    expect((error as HttpError).code).toBe("SLACK_SIGNATURE_REJECTED");

    const unsigned = await expectFailure(
      receiveProviderDelivery(
        slackRequest(key, body, { signature: null }),
        "slack",
        key,
      ),
    );
    expect((unsigned as HttpError).code).toBe("SLACK_SIGNATURE_REJECTED");

    const view = getProviderWebhook(actor, id);
    expect(view?.lastDeliveryStatus).toBe("rejected");
    expect(executionsFor(id)).toHaveLength(0);
  });

  it("answers the url_verification handshake", async () => {
    const id = "wf_slack_challenge";
    upsertWorkflowVersion(actor, slackWorkflow(id, { credential: slackConnection.id }));
    const key = "slack_challenge_key";
    registerSlackHook(key, id);

    const body = JSON.stringify({ type: "url_verification", challenge: "meow_challenge" });
    const result = await receiveProviderDelivery(slackRequest(key, body), "slack", key);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ challenge: "meow_challenge" });
    expect(executionsFor(id)).toHaveLength(0);
  });

  it("starts one run for a message and none for its redelivery", async () => {
    const id = "wf_slack_message";
    upsertWorkflowVersion(actor, slackWorkflow(id, { credential: slackConnection.id }));
    const key = "slack_message_key";
    registerSlackHook(key, id);

    const payload = messagePayload({}, { event_id: "Ev_once" });
    const body = JSON.stringify(payload);

    const first = await receiveProviderDelivery(slackRequest(key, body), "slack", key);
    expect(first.status).toBe(202);
    expect(String(first.body.executionId)).toMatch(/^ex_/);

    const duplicate = await expectFailure(
      receiveProviderDelivery(slackRequest(key, body), "slack", key),
    );
    expect(duplicate).toBeInstanceOf(DuplicateDelivery);
    expect(executionsFor(id)).toHaveLength(1);

    const execution = await runFor(id);
    expect(execution.status).toBe("completed");
    expect(execution.source).toBe("webhook");
    const trigger = execution.steps.find((step) => step.nodeId === "trigger");
    expect(trigger?.output).toMatchObject({
      channel: "C07SUPPORT1",
      userId: "U07NADIA",
      userName: "nadia-k",
      text: "Deploy 4.12 is failing health checks",
      ts: "1758800000.004200",
      teamId: "T07KLYZ",
    });
  });

  it("ignores anything that is not a plain message", async () => {
    const id = "wf_slack_other_events";
    upsertWorkflowVersion(actor, slackWorkflow(id, { credential: slackConnection.id }));
    const key = "slack_other_key";
    registerSlackHook(key, id);

    const notAMessage = JSON.stringify({
      type: "event_callback",
      event_id: "Ev_other",
      event: { type: "app_home_opened", user: "U07NADIA" },
    });
    const ignored = await receiveProviderDelivery(slackRequest(key, notAMessage), "slack", key);
    expect(ignored.status).toBe(200);
    expect(ignored.body.ignored).toBe(true);

    /* An edit carries a subtype — a workflow must never re-run on one. */
    const edited = JSON.stringify(
      messagePayload({ subtype: "message_changed" }, { event_id: "Ev_edit" }),
    );
    const editResult = await receiveProviderDelivery(slackRequest(key, edited), "slack", key);
    expect(editResult.body.ignored).toBe(true);

    expect(executionsFor(id)).toHaveLength(0);
    expect(getProviderWebhook(actor, id)?.lastDeliveryStatus).toBe("ignored");
  });

  it("keeps bot messages out unless the node allows them", async () => {
    const id = "wf_slack_bots";
    upsertWorkflowVersion(actor, slackWorkflow(id, { credential: slackConnection.id }));
    const key = "slack_bots_key";
    registerSlackHook(key, id);

    const bot = JSON.stringify(
      messagePayload({ bot_id: "B07KLYZ", user: undefined }, { event_id: "Ev_bot" }),
    );
    const dropped = await receiveProviderDelivery(slackRequest(key, bot), "slack", key);
    expect(dropped.body.ignored).toBe(true);
    expect(executionsFor(id)).toHaveLength(0);

    upsertWorkflowVersion(
      actor,
      slackWorkflow(id, { credential: slackConnection.id, includeBots: true }),
    );
    const accepted = await receiveProviderDelivery(slackRequest(key, bot), "slack", key);
    expect(accepted.status).toBe(202);
    await runFor(id);
  });

  it("applies the channel the node subscribed to", async () => {
    const id = "wf_slack_channel_filter";
    upsertWorkflowVersion(actor, slackWorkflow(id, { credential: slackConnection.id, channel: "C07SUPPORT1" }));
    const key = "slack_channel_key";
    registerSlackHook(key, id);

    const elsewhere = JSON.stringify(
      messagePayload({ channel: "C07RANDOM" }, { event_id: "Ev_elsewhere" }),
    );
    const ignored = await receiveProviderDelivery(slackRequest(key, elsewhere), "slack", key);
    expect(ignored.status).toBe(200);
    expect(ignored.body.ignored).toBe(true);
    expect(executionsFor(id)).toHaveLength(0);

    const mine = JSON.stringify(messagePayload({}, { event_id: "Ev_mine" }));
    const accepted = await receiveProviderDelivery(slackRequest(key, mine), "slack", key);
    expect(accepted.status).toBe(202);
    expect(executionsFor(id)).toHaveLength(1);
    await runFor(id);
  });

  it("refuses a delivery from a workspace the connection does not belong to", async () => {
    const id = "wf_slack_tenant";
    upsertWorkflowVersion(actor, slackWorkflow(id, { credential: slackConnection.id }));
    const key = "slack_tenant_key";
    registerSlackHook(key, id, { credentialId: slackConnection.id });

    const foreign = JSON.stringify(
      messagePayload({ team: "T_OTHER" }, { event_id: "Ev_foreign", team_id: "T_OTHER" }),
    );
    const error = await expectFailure(
      receiveProviderDelivery(slackRequest(key, foreign), "slack", key),
    );
    expect((error as HttpError).status).toBe(403);
    expect((error as HttpError).code).toBe("SLACK_TENANT_MISMATCH");
    expect(executionsFor(id)).toHaveLength(0);

    const own = JSON.stringify(messagePayload({}, { event_id: "Ev_own" }));
    const accepted = await receiveProviderDelivery(slackRequest(key, own), "slack", key);
    expect(accepted.status).toBe(202);
    expect(executionsFor(id)).toHaveLength(1);
    await runFor(id);
  });
});

/* ------------------------------------------------------------------ */
/* Publishing a Slack endpoint                                         */
/* ------------------------------------------------------------------ */

function hookKeyFrom(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

describe("publishing a Slack endpoint", () => {
  it("publishes with a warning while the signing secret is unset", async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const id = "wf_slack_publish_unsigned";
    const result = await publishProviderWebhook(
      actor,
      slackWorkflow(id, { credential: slackConnection.id }),
    );

    expect(result.warning?.code).toBe("SLACK_SIGNING_SECRET_MISSING");
    expect(result.webhook.provider).toBe("slack");
    expect(result.webhook.mode).toBe("manual");
    expect(result.webhook.status).toBe("error");
    expect(result.webhook.url).toContain("/api/providers/slack/hooks/");
    expect(result.webhook.events).toEqual(["message"]);
  });

  it("stores the signing secret and accepts a delivery signed with it", async () => {
    const signingSecret = "s3cr3t_signing_secret";
    process.env.SLACK_SIGNING_SECRET = signingSecret;
    try {
      const id = "wf_slack_publish_signed";
      const result = await publishProviderWebhook(
        actor,
        slackWorkflow(id, { credential: slackConnection.id }),
      );
      expect(result.warning).toBeUndefined();
      expect(result.webhook.status).toBe("ready");

      const key = hookKeyFrom(result.webhook.url);
      const body = JSON.stringify(messagePayload({}, { event_id: "Ev_published" }));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac("sha256", signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`;

      /* A delivery signed with the module's other secret must not pass:
         the endpoint verifies against exactly what it stored. */
      const foreign = await expectFailure(
        receiveProviderDelivery(slackRequest(key, body), "slack", key),
      );
      expect((foreign as HttpError).code).toBe("SLACK_SIGNATURE_REJECTED");

      const accepted = await receiveProviderDelivery(
        slackRequest(key, body, { signature, timestamp }),
        "slack",
        key,
      );
      expect(accepted.status).toBe(202);
      expect(executionsFor(id)).toHaveLength(1);
      await runFor(id);
    } finally {
      delete process.env.SLACK_SIGNING_SECRET;
    }
  });
});
