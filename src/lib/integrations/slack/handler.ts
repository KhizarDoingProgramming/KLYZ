import type { NodeHandler, NodeRunContext } from "@/lib/engine/types";
import { REMEDIATION, SLACK_ERRORS, integrationError } from "../errors";
import { loadConnection } from "../provider/connection";
import type { ProviderConnection } from "../provider/types";
import { postMessage, type SlackPostMessageResult } from "./api";
import { channelInfo, findChannel, resolveChannel, type SlackChannelRef } from "./channels";
import { buildMessageText, looksLikeChannelId, normaliseChannelRef, parseThreadTs } from "./config";
import { normalizeSlackEvent, type NormalizedSlackEvent } from "./webhook";

/**
 * Slack node handlers.
 *
 * Every handler follows the same three steps: read and validate its
 * config (the engine has already interpolated expressions), load a
 * workspace-scoped connection, and translate Slack's response into the
 * flat shape the node declares in `outputs`. Failures are raised as
 * {@link ProviderError} → `EngineError` so the debugger shows one
 * contract and the attempt loop only retries what is retryable.
 */

type Config = Record<string, unknown>;

/** A delivery handed over by the provider receiver. */
interface SlackDeliveryInput {
  provider?: string;
  hookEvent?: string;
  payload?: unknown;
  receivedAt?: string;
}

function isDelivery(input: unknown): input is SlackDeliveryInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as SlackDeliveryInput;
  return record.provider === "slack" && typeof record.hookEvent === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(config: Config, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

function field(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function required(config: Config, key: string, label: string): string {
  const value = text(config, key);
  if (!value) {
    throw integrationError(SLACK_ERRORS.configInvalid, `This Slack step is missing ${label}.`, {
      hint: `Fill in "${label}" on the node.`,
      remediation: REMEDIATION.inspect,
    });
  }
  return value;
}

async function connect(context: NodeRunContext, config: Config): Promise<ProviderConnection> {
  return loadConnection(context.workspaceId, required(config, "credential", "a connection"), "slack");
}

/* ------------------------------------------------------------------ */
/* Trigger                                                             */
/* ------------------------------------------------------------------ */

export const slackTriggerHandler: NodeHandler = async (context) => {
  const config = context.config;
  const input = context.triggerInput;

  if (isDelivery(input)) {
    const payload = isRecord(input.payload) ? input.payload : {};
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    const normalized = normalizeSlackEvent(payload, receivedAt);
    if (normalized) return { output: deliveredOutput(config, normalized) };

    /* The normaliser drops bot messages so a workflow can never
       re-trigger on its own post; `includeBots` opts into that
       deliberately, so the same fields are read from the raw event. */
    if (isOn(config, "includeBots")) {
      const bot = botOutput(config, payload, receivedAt);
      if (bot) return { output: bot };
    }
    return { output: emptyOutput(config, receivedAt) };
  }

  /* Hand-run: no delivery arrived, so there is no message to invent and
     no API to call — the configured channel and an empty body are what
     the editor previews, exactly like a delivery nothing matched. */
  return { output: emptyOutput(config, new Date().toISOString()) };
};

function isOn(config: Config, key: string): boolean {
  return config[key] === true || text(config, key) === "true";
}

function emptyOutput(config: Config, receivedAt: string): Record<string, unknown> {
  const channelRef = text(config, "channel");
  return {
    channel: normaliseChannelRef(channelRef),
    channelName: channelRef,
    userId: "",
    userName: "",
    text: "",
    ts: "",
    threadTs: "",
    teamId: "",
    botId: "",
    receivedAt,
    raw: {},
  };
}

function deliveredOutput(config: Config, event: NormalizedSlackEvent): Record<string, unknown> {
  return {
    ...emptyOutput(config, event.receivedAt),
    channel: event.channel,
    userId: event.userId,
    userName: event.userName ?? "",
    text: event.text,
    ts: event.ts,
    threadTs: event.threadTs,
    teamId: event.teamId,
    botId: event.botId,
    raw: event.raw,
  };
}

function botOutput(
  config: Config,
  payload: Record<string, unknown>,
  receivedAt: string,
): Record<string, unknown> | null {
  const event = payload.event;
  if (!isRecord(event) || event.type !== "message" || event.subtype) return null;
  if (!event.bot_id || !event.channel || !event.ts) return null;
  return {
    ...emptyOutput(config, receivedAt),
    channel: field(event.channel),
    userId: field(event.user),
    userName: field(event.username),
    text: field(event.text),
    ts: field(event.ts),
    threadTs: field(event.thread_ts),
    teamId: field(event.team) || field(payload.team_id),
    botId: field(event.bot_id),
    raw: payload,
  };
}

/* ------------------------------------------------------------------ */
/* Message                                                             */
/* ------------------------------------------------------------------ */

export const slackMessageHandler: NodeHandler = async (context) => {
  const config = context.config;
  const connection = await connect(context, config);
  const operation = text(config, "operation") === "reply" ? "reply" : "send";

  const channel = await resolveChannel(
    connection,
    required(config, "channel", "a channel"),
    context.signal,
  );
  const body = buildMessageText(required(config, "message", "a message"), config.notify);

  let threadTs = "";
  if (operation === "reply") {
    const raw = text(config, "threadTs");
    if (!raw) {
      throw integrationError(
        SLACK_ERRORS.threadInvalid,
        "This Slack step has no thread timestamp to reply to.",
        {
          hint: "Pass the ts of the message you are replying to — e.g. {{slack.ts}}.",
          remediation: REMEDIATION.inspect,
        },
      );
    }
    threadTs = parseThreadTs(raw);
  }

  const posted: SlackPostMessageResult = await postMessage(
    connection,
    { channel: channel.id, text: body, ...(threadTs ? { threadTs } : {}) },
    { signal: context.signal },
  );

  return {
    output: {
      ts: posted.ts ?? "",
      threadTs: operation === "reply" ? threadTs : (posted.thread_ts ?? ""),
      channel: channel.id,
      channelName: channel.name,
      text: body,
      operation,
    },
  };
};

/* ------------------------------------------------------------------ */
/* Channel                                                             */
/* ------------------------------------------------------------------ */

const EMPTY_CHANNEL = {
  id: "",
  name: "",
  isPrivate: false,
  isMember: false,
  topic: "",
  purpose: "",
  memberCount: 0,
  archived: false,
};

export const slackChannelHandler: NodeHandler = async (context) => {
  const config = context.config;
  const connection = await connect(context, config);
  const operation = text(config, "operation") === "info" ? "info" : "find";

  if (operation === "info") {
    const details = await channelInfo(
      connection,
      required(config, "channel", "a channel"),
      context.signal,
    );
    return {
      output: {
        channel: {
          id: details.id,
          name: details.name,
          isPrivate: details.isPrivate,
          isMember: details.isMember,
          topic: details.topic,
          purpose: details.purpose,
          memberCount: details.memberCount,
          archived: details.archived,
        },
        found: true,
        operation,
      },
    };
  }

  const ref = normaliseChannelRef(required(config, "name", "a channel name"));

  /* An id is unambiguous: guessing "not found" would hide a typo, so
     resolve it strictly. A name miss is data a Condition can branch on. */
  if (looksLikeChannelId(ref)) {
    const channel = await resolveChannel(connection, ref, context.signal);
    return { output: { channel: foundChannel(channel), found: true, operation } };
  }

  const match = await findChannel(connection, ref, context.signal);
  if (!match) return { output: { channel: { ...EMPTY_CHANNEL }, found: false, operation } };
  return { output: { channel: foundChannel(match), found: true, operation } };
};

function foundChannel(channel: SlackChannelRef): Record<string, unknown> {
  return {
    id: channel.id,
    name: channel.name,
    isPrivate: channel.isPrivate,
    isMember: channel.isMember,
    topic: "",
    purpose: "",
    memberCount: 0,
    archived: false,
  };
}

export const slackHandlers: Record<string, NodeHandler> = {
  "action.slack_message": slackMessageHandler,
  "action.slack_channel": slackChannelHandler,
  "trigger.slack": slackTriggerHandler,
};
