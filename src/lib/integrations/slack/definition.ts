import type { NodeDefinition, OutputField } from "@/lib/workflow/types";

const str = (key: string, label: string) => ({ key, label, type: "string" as const });
const num = (key: string, label: string) => ({ key, label, type: "number" as const });
const bool = (key: string, label: string) => ({ key, label, type: "boolean" as const });

const CREDENTIAL_HELP =
  "Connect a Slack workspace on the Integrations page. The app token is encrypted and only sent to slack.com.";

/**
 * Post a message to a channel, or answer inside an existing thread.
 *
 * The trigger above hands `ts` straight into the reply field, so a
 * workflow can open a conversation and follow up in it without ever
 * inventing a second top-level message.
 */
export const slackMessageDefinition: NodeDefinition = {
  type: "action.slack_message",
  category: "action",
  title: "Slack message",
  description: "Posts a message to a channel or replies in a thread.",
  icon: "slack",
  summary: "Posts to a channel",
  cost: 180,
  credentials: ["slack"],
  tags: ["slack"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    {
      key: "operation",
      label: "Operation",
      kind: "select",
      required: true,
      options: [
        { value: "send", label: "Send message" },
        { value: "reply", label: "Reply in thread" },
      ],
    },
    {
      key: "channel",
      label: "Channel",
      kind: "expression",
      required: true,
      bindable: true,
      placeholder: "#engineering",
      help: "Channel name with or without #, or a channel id (C…). The app must be a member.",
    },
    {
      key: "message",
      label: "Message",
      kind: "textarea",
      required: true,
      bindable: true,
      rows: 5,
      placeholder: "New GitHub issue:\n{{github.issue.title}}\n\n{{github.issue.url}}",
    },
    {
      key: "threadTs",
      label: "Thread timestamp",
      kind: "text",
      required: true,
      mono: true,
      bindable: true,
      showWhen: { key: "operation", equals: "reply" },
      placeholder: "{{slack.ts}}",
      help: "Timestamp of the message to reply to (its `ts`). A reply never starts a new top-level message.",
    },
    {
      key: "notify",
      label: "Notify",
      kind: "select",
      showWhen: { key: "operation", equals: "send" },
      options: [
        { value: "none", label: "No notification" },
        { value: "here", label: "@here" },
        { value: "channel", label: "@channel" },
      ],
    },
  ],
  outputs: [
    str("ts", "Message ts"),
    str("threadTs", "Thread ts"),
    str("channel", "Channel id"),
    str("channelName", "Channel name"),
    str("text", "Message"),
    str("operation", "Operation"),
  ],
};

const CHANNEL_CHILDREN: OutputField[] = [
  str("id", "Channel id"),
  str("name", "Name"),
  bool("isPrivate", "Private"),
  bool("isMember", "App is a member"),
  str("topic", "Topic"),
  str("purpose", "Purpose"),
  num("memberCount", "Members"),
  bool("archived", "Archived"),
];

/** Look a channel up by name, or read everything Slack knows about one. */
export const slackChannelDefinition: NodeDefinition = {
  type: "action.slack_channel",
  category: "action",
  title: "Slack channel",
  description: "Finds a channel by name, or reads a channel's details.",
  icon: "share",
  summary: "Looks up a channel",
  cost: 120,
  credentials: ["slack"],
  tags: ["slack"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    {
      key: "operation",
      label: "Operation",
      kind: "select",
      required: true,
      options: [
        { value: "find", label: "Find channel" },
        { value: "info", label: "Channel info" },
      ],
    },
    {
      key: "channel",
      label: "Channel",
      kind: "text",
      required: true,
      bindable: true,
      placeholder: "#engineering",
      showWhen: { key: "operation", equals: "info" },
      help: "Name or id.",
    },
    {
      key: "name",
      label: "Channel name",
      kind: "text",
      required: true,
      bindable: true,
      placeholder: "engineering",
      showWhen: { key: "operation", equals: "find" },
      help: "Name or id — # is optional.",
    },
  ],
  outputs: [
    { key: "channel", label: "Channel", type: "object", children: CHANNEL_CHILDREN },
    bool("found", "Found"),
    str("operation", "Operation"),
  ],
};

/**
 * Slack message trigger.
 *
 * A verified Events API delivery is normalised by the receiver and fed
 * to the handler; a hand-run invents nothing — it reports the
 * configured channel and an empty message so mapping can be written
 * before the first real delivery arrives.
 */
export const slackTriggerDefinition: NodeDefinition = {
  type: "trigger.slack",
  category: "trigger",
  title: "Slack message received",
  description: "Starts the workflow when a message is posted in a channel.",
  icon: "slack",
  summary: "A message arrives",
  trigger: true,
  cost: 140,
  credentials: ["slack"],
  tags: ["slack", "events"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    {
      key: "channel",
      label: "Channel",
      kind: "text",
      mono: true,
      placeholder: "#engineering",
      help: "Leave empty to run on any channel the app can see. Publishing resolves the name to a channel id.",
    },
    {
      key: "includeBots",
      label: "Include bot messages",
      kind: "toggle",
      help: "Off by default — bot messages never re-trigger a workflow.",
    },
  ],
  outputs: [
    str("channel", "Channel id"),
    str("channelName", "Channel name"),
    str("userId", "User id"),
    str("userName", "User name"),
    str("text", "Message"),
    str("ts", "Message ts"),
    str("threadTs", "Thread ts"),
    str("teamId", "Team id"),
    str("botId", "Bot id"),
    str("receivedAt", "Received at"),
    { key: "raw", label: "Raw payload", type: "object" },
  ],
};
