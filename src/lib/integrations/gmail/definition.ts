import type { NodeDefinition, OutputField } from "@/lib/workflow/types";

const str = (key: string, label: string) => ({ key, label, type: "string" as const });

const CREDENTIAL_HELP =
  "Connect a Google account on the Integrations page. The token is encrypted and only sent to Google.";

const MESSAGE_ID_FIELD = {
  key: "message",
  label: "Message",
  kind: "text" as const,
  required: true,
  placeholder: "{{trigger.messageId}}",
  mono: true,
  bindable: true,
  help: "A Gmail message id — the trigger exposes the current one as {{trigger.messageId}}.",
};

const MESSAGE_CHILDREN: OutputField[] = [
  str("messageId", "Message id"),
  str("threadId", "Thread id"),
  str("subject", "Subject"),
  str("from", "From"),
  str("fromEmail", "From address"),
  str("to", "To"),
  str("cc", "Cc"),
  str("snippet", "Snippet"),
  str("body", "Body"),
  str("bodyHtml", "Body (HTML)"),
  { key: "labels", label: "Labels", type: "array" },
  { key: "attachments", label: "Attachments", type: "array" },
  str("url", "URL"),
  str("receivedAt", "Received at"),
];

/**
 * Gmail trigger.
 *
 * The handler reads the mailbox through the Gmail API using the stored
 * cursor, so a run always starts from a real message — never from
 * invented sample data. With Pub/Sub configured, a push notification
 * starts the run and this same read finds the message that arrived.
 */
export const gmailTriggerDefinition: NodeDefinition = {
  type: "trigger.gmail",
  category: "trigger",
  title: "New email received",
  description: "Starts the workflow when a matching email arrives in the connected mailbox.",
  icon: "mail",
  summary: "New email arrives",
  trigger: true,
  cost: 140,
  credentials: ["gmail"],
  tags: ["gmail"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    {
      key: "label",
      label: "Label",
      kind: "select",
      required: true,
      options: [
        { value: "INBOX", label: "Inbox" },
        { value: "STARRED", label: "Starred" },
        { value: "IMPORTANT", label: "Important" },
        { value: "UNREAD", label: "Unread" },
        { value: "", label: "Any label" },
      ],
      help: "Narrow to one Gmail label, or search across all mail.",
    },
    {
      key: "query",
      label: "Search query",
      kind: "text",
      mono: true,
      placeholder: 'is:unread subject:"export"',
      help: "Gmail search syntax — combined with the label above using AND.",
    },
    {
      key: "since",
      label: "Only new messages",
      kind: "select",
      options: [
        { value: "cursor", label: "Since the last run (recommended)" },
        { value: "any", label: "Newest match, even if already seen" },
      ],
      help: "The cursor is stored per connection. Choose “newest match” while testing.",
    },
    {
      key: "markRead",
      label: "Mark as read",
      kind: "toggle",
      help: "Removes the UNREAD label after the message has been picked up.",
    },
  ],
  outputs: [
    str("messageId", "Message id"),
    str("threadId", "Thread id"),
    str("subject", "Subject"),
    str("from", "From"),
    str("fromName", "From name"),
    str("fromEmail", "From address"),
    str("to", "To"),
    str("cc", "Cc"),
    str("snippet", "Snippet"),
    str("body", "Body"),
    str("bodyHtml", "Body (HTML)"),
    { key: "labels", label: "Labels", type: "array" },
    { key: "attachments", label: "Attachments", type: "array" },
    str("url", "URL"),
    str("receivedAt", "Received at"),
    str("historyId", "History id"),
    { key: "raw", label: "Raw payload", type: "object" },
  ],
};

/** Send a new email from the connected Google account. */
export const gmailSendDefinition: NodeDefinition = {
  type: "action.gmail_send",
  category: "action",
  title: "Send email",
  description: "Sends an email from the connected Google account.",
  icon: "send",
  summary: "Sends an email",
  cost: 240,
  credentials: ["gmail"],
  tags: ["gmail"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    {
      key: "to",
      label: "To",
      kind: "expression",
      required: true,
      bindable: true,
      placeholder: "{{trigger.fromEmail}}",
      help: "One address. Use a Loop step to mail several recipients.",
    },
    { key: "cc", label: "Cc", kind: "expression", bindable: true, placeholder: "team@klyz.dev" },
    { key: "bcc", label: "Bcc", kind: "expression", bindable: true },
    {
      key: "subject",
      label: "Subject",
      kind: "expression",
      required: true,
      bindable: true,
      placeholder: "Re: {{trigger.subject}}",
    },
    {
      key: "body",
      label: "Message",
      kind: "textarea",
      required: true,
      rows: 7,
      bindable: true,
      placeholder: "Hi {{trigger.fromName}}, …",
    },
    {
      key: "format",
      label: "Format",
      kind: "select",
      options: [
        { value: "plain", label: "Plain text" },
        { value: "html", label: "HTML" },
      ],
      help: "HTML messages are sent as multipart/alternative so plain-text readers still work.",
    },
  ],
  outputs: [str("id", "Message id"), str("threadId", "Thread id"), str("status", "Status")],
};

/** Reply inside an existing thread. */
export const gmailReplyDefinition: NodeDefinition = {
  type: "action.gmail_reply",
  category: "action",
  title: "Reply to email",
  description: "Replies to an existing message, keeping the conversation threaded.",
  icon: "arrowRight",
  summary: "Replies in a thread",
  cost: 250,
  credentials: ["gmail"],
  tags: ["gmail"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    MESSAGE_ID_FIELD,
    {
      key: "body",
      label: "Reply",
      kind: "textarea",
      required: true,
      rows: 7,
      bindable: true,
      placeholder: "Thanks for flagging this — looking now.",
    },
    {
      key: "format",
      label: "Format",
      kind: "select",
      options: [
        { value: "plain", label: "Plain text" },
        { value: "html", label: "HTML" },
      ],
    },
    {
      key: "quoteOriginal",
      label: "Quote the original",
      kind: "toggle",
      help: "Appends the previous message below your reply, as mail clients do.",
    },
  ],
  outputs: [
    str("id", "Message id"),
    str("threadId", "Thread id"),
    str("inReplyTo", "In reply to"),
    str("status", "Status"),
  ],
};

/** Add or remove a Gmail label on a message. */
export const gmailLabelDefinition: NodeDefinition = {
  type: "action.gmail_label",
  category: "action",
  title: "Gmail label",
  description: "Adds or removes a label on a message in the connected mailbox.",
  icon: "tags",
  summary: "Labels a message",
  cost: 90,
  credentials: ["gmail"],
  tags: ["gmail"],
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
        { value: "add", label: "Add label" },
        { value: "remove", label: "Remove label" },
      ],
    },
    MESSAGE_ID_FIELD,
    {
      key: "label",
      label: "Label",
      kind: "text",
      required: true,
      bindable: true,
      mono: true,
      placeholder: "Support/Closed",
      help: "A label name such as INBOX, UNREAD, or one of your own labels.",
    },
  ],
  outputs: [
    str("messageId", "Message id"),
    str("label", "Label"),
    str("operation", "Operation"),
    { key: "labels", label: "Labels now", type: "array" },
  ],
};

/** Read one message in full — the trigger only carries the newest match. */
export const gmailGetDefinition: NodeDefinition = {
  type: "action.gmail_get",
  category: "action",
  title: "Get email",
  description: "Reads a message from the connected mailbox in full.",
  icon: "inbox",
  summary: "Reads an email",
  cost: 110,
  credentials: ["gmail"],
  tags: ["gmail"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    MESSAGE_ID_FIELD,
    {
      key: "format",
      label: "Format",
      kind: "select",
      options: [
        { value: "full", label: "Full (headers + body)" },
        { value: "metadata", label: "Headers only" },
        { value: "raw", label: "Raw RFC 2822" },
      ],
    },
  ],
  outputs: [...MESSAGE_CHILDREN],
};
