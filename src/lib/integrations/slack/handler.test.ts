import { beforeEach, describe, expect, it, vi } from "vitest";
import { EngineError, type NodeHandler, type NodeRunContext } from "@/lib/engine/types";
import { loadConnection } from "@/lib/integrations/provider/connection";
import { ProviderError } from "@/lib/integrations/provider/errors";
import { conversationsInfo, findChannelByName, postMessage } from "./api";
import { clearChannelCache } from "./channels";
import { slackHandlers } from "./handler";

vi.mock("@/lib/integrations/provider/connection", () => ({
  loadConnection: vi.fn(),
}));

vi.mock("./api", () => ({
  SLACK_API: "https://slack.com/api",
  slackRequest: vi.fn(),
  postMessage: vi.fn(),
  conversationsList: vi.fn(),
  conversationsInfo: vi.fn(),
  findChannelByName: vi.fn(),
  authTest: vi.fn(),
}));

const CONNECTION = {
  credentialId: "cred_slack_1",
  provider: "slack" as const,
  workspaceId: "ws_1",
  name: "KLYZ Slack",
  status: "connected" as const,
  account: "klyz",
  scopes: ["chat:write", "channels:read"],
  accessToken: "xoxb-test-token",
  expiresAt: null,
  extra: {},
};

const ENGINEERING = {
  id: "C0ABC12345",
  name: "engineering",
  is_private: false,
  is_member: true,
};

function context(
  config: Record<string, unknown>,
  extra: Partial<NodeRunContext> = {},
): NodeRunContext {
  return {
    executionId: "exec_1",
    workspaceId: "ws_1",
    workflow: {} as NodeRunContext["workflow"],
    nodeId: "node_1",
    nodeType: "action.slack_message",
    config,
    rawConfig: config,
    scope: {} as NodeRunContext["scope"],
    triggerInput: undefined,
    attempt: 1,
    signal: new AbortController().signal,
    publishStatus: () => {},
    ...extra,
  };
}

async function run(
  type: string,
  config: Record<string, unknown>,
  extra: Partial<NodeRunContext> = {},
): Promise<Record<string, unknown>> {
  const handler: NodeHandler | undefined = slackHandlers[type];
  expect(handler).toBeDefined();
  return (await handler!(context(config, extra))).output;
}

async function expectCode(
  type: string,
  config: Record<string, unknown>,
  code: string,
  extra: Partial<NodeRunContext> = {},
): Promise<void> {
  try {
    await run(type, config, extra);
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

beforeEach(() => {
  vi.resetAllMocks();
  clearChannelCache();
  vi.mocked(loadConnection).mockResolvedValue(CONNECTION);
});

describe("action.slack_message", () => {
  const BASE = { credential: "cred_slack_1", channel: "#engineering", message: "Deploy finished" };

  it("posts to the channel the lookup resolved", async () => {
    vi.mocked(findChannelByName).mockResolvedValue(ENGINEERING);
    vi.mocked(postMessage).mockResolvedValue({ ts: "1758888888.000100", channel: "C0ABC12345" });

    const output = await run("action.slack_message", { ...BASE, operation: "send" });

    expect(findChannelByName).toHaveBeenCalledWith(CONNECTION, "engineering", {
      signal: expect.any(AbortSignal),
    });
    expect(postMessage).toHaveBeenCalledWith(
      CONNECTION,
      { channel: "C0ABC12345", text: "Deploy finished" },
      { signal: expect.any(AbortSignal) },
    );
    expect(output).toEqual({
      ts: "1758888888.000100",
      threadTs: "",
      channel: "C0ABC12345",
      channelName: "engineering",
      text: "Deploy finished",
      operation: "send",
    });
  });

  it("prefixes @here when asked to notify", async () => {
    vi.mocked(findChannelByName).mockResolvedValue(ENGINEERING);
    vi.mocked(postMessage).mockResolvedValue({ ts: "1758888888.000100", channel: "C0ABC12345" });

    const output = await run("action.slack_message", {
      ...BASE,
      operation: "send",
      notify: "here",
    });

    expect(postMessage).toHaveBeenCalledWith(
      CONNECTION,
      { channel: "C0ABC12345", text: "<!here>\nDeploy finished" },
      { signal: expect.any(AbortSignal) },
    );
    expect(output.text).toBe("<!here>\nDeploy finished");
  });

  it("replies in a thread with the configured ts", async () => {
    vi.mocked(findChannelByName).mockResolvedValue(ENGINEERING);
    vi.mocked(postMessage).mockResolvedValue({
      ts: "1758888888.000200",
      channel: "C0ABC12345",
      thread_ts: "1758888888.000100",
    });

    const output = await run("action.slack_message", {
      ...BASE,
      operation: "reply",
      threadTs: "1758888888.000100",
    });

    expect(postMessage).toHaveBeenCalledWith(
      CONNECTION,
      {
        channel: "C0ABC12345",
        text: "Deploy finished",
        threadTs: "1758888888.000100",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(output).toMatchObject({
      ts: "1758888888.000200",
      threadTs: "1758888888.000100",
      operation: "reply",
    });
  });

  it("refuses a reply without a usable thread ts", async () => {
    vi.mocked(findChannelByName).mockResolvedValue(ENGINEERING);

    await expectCode(
      "action.slack_message",
      { ...BASE, operation: "reply" },
      "SLACK_THREAD_INVALID",
    );
    await expectCode(
      "action.slack_message",
      { ...BASE, operation: "reply", threadTs: "not-a-ts" },
      "SLACK_THREAD_INVALID",
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("refuses to send without a channel", async () => {
    await expectCode(
      "action.slack_message",
      { credential: "cred_slack_1", operation: "send", message: "Deploy finished" },
      "SLACK_CONFIG_INVALID",
    );
    expect(postMessage).not.toHaveBeenCalled();
    expect(findChannelByName).not.toHaveBeenCalled();
  });
});

describe("action.slack_channel", () => {
  it("returns the channel a name resolves to", async () => {
    vi.mocked(findChannelByName).mockResolvedValue(ENGINEERING);

    const output = await run("action.slack_channel", {
      credential: "cred_slack_1",
      operation: "find",
      name: "engineering",
    });

    expect(output).toEqual({
      channel: {
        id: "C0ABC12345",
        name: "engineering",
        isPrivate: false,
        isMember: true,
        topic: "",
        purpose: "",
        memberCount: 0,
        archived: false,
      },
      found: true,
      operation: "find",
    });
  });

  it("treats a name miss as data, not a failure", async () => {
    vi.mocked(findChannelByName).mockResolvedValue(null);

    const output = await run("action.slack_channel", {
      credential: "cred_slack_1",
      operation: "find",
      name: "does-not-exist",
    });

    expect(output).toEqual({
      channel: {
        id: "",
        name: "",
        isPrivate: false,
        isMember: false,
        topic: "",
        purpose: "",
        memberCount: 0,
        archived: false,
      },
      found: false,
      operation: "find",
    });
  });

  it("throws when the input was clearly an id Slack does not know", async () => {
    vi.mocked(conversationsInfo).mockRejectedValue(
      new ProviderError("slack", "Slack refused conversations.info: channel_not_found", {
        operation: "conversations.info",
        category: "not_found",
        providerMessage: "channel_not_found",
      }),
    );

    await expectCode(
      "action.slack_channel",
      { credential: "cred_slack_1", operation: "find", name: "C0MISSING1" },
      "SLACK_CHANNEL_INVALID",
    );
  });

  it("reads full details for the info operation", async () => {
    vi.mocked(findChannelByName).mockResolvedValue(ENGINEERING);
    vi.mocked(conversationsInfo).mockResolvedValue({
      ...ENGINEERING,
      is_private: true,
      is_archived: false,
      num_members: 42,
      created: 1_700_000_000,
      topic: { value: "Deployments" },
      purpose: { value: "Ship it" },
    });

    const output = await run("action.slack_channel", {
      credential: "cred_slack_1",
      operation: "info",
      channel: "#engineering",
    });

    expect(output).toEqual({
      channel: {
        id: "C0ABC12345",
        name: "engineering",
        isPrivate: true,
        isMember: true,
        topic: "Deployments",
        purpose: "Ship it",
        memberCount: 42,
        archived: false,
      },
      found: true,
      operation: "info",
    });
  });
});

describe("trigger.slack", () => {
  const DELIVERY = {
    type: "event_callback",
    team_id: "T0KLYZ",
    event: {
      type: "message",
      channel: "C0ABC12345",
      channel_type: "channel",
      user: "U0PERSON",
      text: "deploy finished",
      ts: "1758888888.000100",
    },
  };

  it("maps a verified delivery onto the trigger outputs", async () => {
    const output = await run(
      "trigger.slack",
      { credential: "cred_slack_1", channel: "#engineering" },
      {
        triggerInput: {
          provider: "slack",
          hookEvent: "message",
          payload: DELIVERY,
          receivedAt: "2026-09-26T09:15:00.000Z",
        },
      },
    );

    expect(output).toEqual({
      channel: "C0ABC12345",
      channelName: "#engineering",
      userId: "U0PERSON",
      userName: "",
      text: "deploy finished",
      ts: "1758888888.000100",
      threadTs: "",
      teamId: "T0KLYZ",
      botId: "",
      receivedAt: "2026-09-26T09:15:00.000Z",
      raw: DELIVERY,
    });
    expect(loadConnection).not.toHaveBeenCalled();
  });

  it("answers with an empty, well-shaped payload when the delivery is ignored", async () => {
    const output = await run(
      "trigger.slack",
      { credential: "cred_slack_1", channel: "#engineering" },
      {
        triggerInput: {
          provider: "slack",
          hookEvent: "message",
          payload: { ...DELIVERY, event: { ...DELIVERY.event, bot_id: "B0KLYZ" } },
          receivedAt: "2026-09-26T09:15:00.000Z",
        },
      },
    );

    expect(output).toEqual({
      channel: "engineering",
      channelName: "#engineering",
      userId: "",
      userName: "",
      text: "",
      ts: "",
      threadTs: "",
      teamId: "",
      botId: "",
      receivedAt: "2026-09-26T09:15:00.000Z",
      raw: {},
    });
  });

  it("hands bot messages over only when the node opts in", async () => {
    const botDelivery = {
      provider: "slack",
      hookEvent: "message",
      payload: { ...DELIVERY, event: { ...DELIVERY.event, bot_id: "B0KLYZ", username: "klyz-bot" } },
      receivedAt: "2026-09-26T09:15:00.000Z",
    };

    const ignored = await run("trigger.slack", { credential: "cred_slack_1" }, {
      triggerInput: botDelivery,
    });
    expect(ignored.text).toBe("");

    const included = await run(
      "trigger.slack",
      { credential: "cred_slack_1", includeBots: true },
      { triggerInput: botDelivery },
    );
    expect(included).toMatchObject({
      channel: "C0ABC12345",
      text: "deploy finished",
      botId: "B0KLYZ",
      userName: "klyz-bot",
    });
  });

  it("reports the configured channel and no message on a hand-run", async () => {
    const output = await run("trigger.slack", {
      credential: "cred_slack_1",
      channel: "#engineering",
    });

    expect(output).toMatchObject({
      channel: "engineering",
      channelName: "#engineering",
      text: "",
      raw: {},
    });
    expect(Number.isFinite(Date.parse(String(output.receivedAt)))).toBe(true);
    expect(loadConnection).not.toHaveBeenCalled();
  });
});
