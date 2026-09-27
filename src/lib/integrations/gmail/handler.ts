import type { NodeHandler, NodeRunContext } from "@/lib/engine/types";
import { GMAIL_ERRORS, REMEDIATION, integrationError } from "../errors";
import { loadConnection } from "../provider/connection";
import type { ProviderConnection } from "../provider/types";
import {
  gmailRequest,
  listMessageIds,
} from "./api";
import { parseEmail, parseLabel, parseRecipients, requiredText } from "./config";
import {
  buildRawMessage,
  encodeRaw,
  normalizeMessage,
  type GmailMessage,
} from "./normalize";
import { ensureWatch, getWatch, readCursor, watchNeedsRenewal, writeCursor } from "./watch";

/**
 * Gmail node handlers.
 *
 * The trigger reads the mailbox through the API using the stored
 * cursor, so every run starts from a real message. Actions compose a
 * real RFC 2822 message and hand it to Gmail — threading, headers and
 * all. Failures are raised as {@link ProviderError} → `EngineError` so
 * the debugger shows one contract and only retryable categories
 * (rate limits, timeouts) are retried by the attempt loop.
 */

type Config = Record<string, unknown>;

function text(config: Config, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

function required(config: Config, key: string, label: string): string {
  const value = text(config, key);
  if (!value) {
    throw integrationError(GMAIL_ERRORS.configInvalid, `This Gmail step is missing ${label}.`, {
      hint: `Fill in "${label}" on the node.`,
      remediation: REMEDIATION.inspect,
    });
  }
  return value;
}

async function connect(context: NodeRunContext, config: Config): Promise<ProviderConnection> {
  return loadConnection(context.workspaceId, required(config, "credential", "a connection"), "gmail");
}

/* ------------------------------------------------------------------ */
/* Trigger                                                             */
/* ------------------------------------------------------------------ */

export const gmailTriggerHandler: NodeHandler = async (context) => {
  const config = context.config;
  const connection = await connect(context, config);

  const label = text(config, "label");
  const query = text(config, "query");
  const since = text(config, "since") || "cursor";
  const cursor = since === "any" ? null : readCursor(context.workspaceId, connection.credentialId);

  const parts = [query, cursor ? `after:${Math.floor(cursor / 1000)}` : ""].filter(Boolean);

  const listed = await listMessageIds(connection, {
    q: parts.join(" "),
    labelIds: label || undefined,
    maxResults: 1,
  });

  const first = listed.messages?.[0];
  if (!first?.id) {
    throw integrationError(
      GMAIL_ERRORS.messageNotFound,
      "No email matched this trigger's label and search query.",
      {
        detail: [
          label ? `label=${label}` : null,
          query ? `query=${query}` : null,
          cursor ? `after=${new Date(cursor).toISOString()}` : "no cursor yet",
        ]
          .filter(Boolean)
          .join(" · "),
        hint: "Loosen the label or query, or set “Only new messages” to “Newest match” while testing.",
        remediation: REMEDIATION.inspect,
      },
    );
  }

  const message = await fetchMessage(connection, first.id, "full");
  const normalized = normalizeMessage(message);

  if (text(config, "markRead") === "true" || config.markRead === true) {
    await gmailRequest(connection, "messages.modify", `/messages/${normalized.messageId}/modify`, {
      method: "POST",
      body: { removeLabelIds: ["UNREAD"] },
    });
  }

  const at = Date.parse(normalized.receivedAt);
  if (Number.isFinite(at) && (cursor === null || at > cursor)) {
    writeCursor(context.workspaceId, connection.credentialId, at);
  }

  /* Renewing here keeps the subscription alive without a cron: the
     worker is already authenticated, and a failed renewal is recorded
     on the watch row instead of failing the run. */
  if (watchNeedsRenewal(getWatch(context.workspaceId, connection.credentialId))) {
    void ensureWatch(connection);
  }

  return { output: outputsFrom(normalized) };
};

async function fetchMessage(
  connection: ProviderConnection,
  id: string,
  format: "full" | "metadata",
): Promise<GmailMessage> {
  return gmailRequest<GmailMessage>(connection, "messages.get", `/messages/${encodeURIComponent(id)}`, {
    query: { format },
  });
}

function outputsFrom(message: ReturnType<typeof normalizeMessage>): Record<string, unknown> {
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    subject: message.subject,
    from: message.from,
    fromName: message.fromName,
    fromEmail: message.fromEmail,
    to: message.to,
    cc: message.cc,
    snippet: message.snippet,
    body: message.body,
    bodyHtml: message.bodyHtml,
    labels: message.labels,
    attachments: message.attachments,
    url: message.url,
    receivedAt: message.receivedAt,
    historyId: message.historyId,
    raw: message.raw,
  };
}

/* ------------------------------------------------------------------ */
/* Send                                                                */
/* ------------------------------------------------------------------ */

export const gmailSendHandler: NodeHandler = async (context) => {
  const config = context.config;
  const connection = await connect(context, config);

  const to = [parseEmail(config.to, "To")];
  const cc = parseRecipients(config.cc, "Cc");
  const bcc = parseRecipients(config.bcc, "Bcc");
  const subject = requiredText(config, "subject", "a subject");
  const body = requiredText(config, "body", "a message");
  const html = text(config, "format") === "html";

  const raw = encodeRaw(
    buildRawMessage({
      to,
      cc,
      bcc,
      subject,
      ...(html ? { html: body } : { text: body }),
    }),
  );

  const sent = await gmailRequest<{ id?: string; threadId?: string }>(
    connection,
    "messages.send",
    "/messages/send",
    { method: "POST", body: { raw } },
  );

  return {
    output: { id: sent.id ?? "", threadId: sent.threadId ?? "", status: "sent" },
  };
};

/* ------------------------------------------------------------------ */
/* Reply                                                               */
/* ------------------------------------------------------------------ */

interface OriginalHeaders {
  messageId: string;
  references: string;
  from: string;
  subject: string;
  date: string;
}

export const gmailReplyHandler: NodeHandler = async (context) => {
  const config = context.config;
  const connection = await connect(context, config);

  const target = required(config, "message", "a message id");
  const body = requiredText(config, "body", "a reply");
  const html = text(config, "format") === "html";

  const original = await fetchMessage(connection, target, "full");
  if (!original.id) {
    throw integrationError(
      GMAIL_ERRORS.messageNotFound,
      "That message could not be found in the connected mailbox.",
      { hint: "Check the message id — the trigger exposes it as {{trigger.messageId}}." },
    );
  }

  const headers = readHeaders(original);
  if (!headers.from) {
    throw integrationError(
      GMAIL_ERRORS.messageNotFound,
      "That message has no From header, so it cannot be replied to.",
      { hint: "Pass the message id of an email you received." },
    );
  }

  const originalBody = normalizeMessage(original).body;
  const quoted = text(config, "quoteOriginal") === "true" || config.quoteOriginal === true;
  const content = quoted
    ? html
      ? `${body}\n\n${quoteHtml(originalBody, headers.from, headers.date)}`
      : `${body}\n\n${quote(originalBody, headers.from, headers.date)}`
    : body;

  const raw = encodeRaw(
    buildRawMessage({
      to: [headers.from],
      subject: replySubject(headers.subject),
      ...(html ? { html: content } : { text: content }),
      threadId: original.threadId,
      inReplyTo: headers.messageId,
      references: headers.references,
    }),
  );

  const sent = await gmailRequest<{ id?: string; threadId?: string }>(
    connection,
    "messages.send",
    "/messages/send",
    {
      method: "POST",
      body: {
        raw,
        threadId: original.threadId || undefined,
      },
    },
  );

  return {
    output: {
      id: sent.id ?? "",
      threadId: sent.threadId ?? original.threadId ?? "",
      inReplyTo: headers.messageId,
      status: "sent",
    },
  };
};

function readHeaders(message: GmailMessage): OriginalHeaders {
  const map: Record<string, string> = {};
  for (const header of message.payload?.headers ?? []) {
    if (header?.name) map[header.name.toLowerCase()] = header.value ?? "";
  }
  const messageId = map["message-id"] ?? "";
  const existingReferences = map.references ?? "";
  return {
    messageId,
    references: [existingReferences, messageId].filter(Boolean).join(" ").trim(),
    from: map.from ?? "",
    subject: map.subject ?? "",
    date: map.date ?? "",
  };
}

function replySubject(subject: string): string {
  if (!subject) return "Re:";
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject}`;
}

function quote(body: string, from: string, date: string): string {
  const attribution = `${date ? `on ${date} ` : ""}${from} wrote:`.trim();
  const lines = body.split("\n").map((line) => `> ${line}`.trimEnd());
  return [attribution, ...lines].join("\n");
}

function quoteHtml(body: string, from: string, date: string): string {
  const attribution = `${date ? `on ${date} ` : ""}${from} wrote:`.trim();
  const quoted = escapeHtml(body)
    .split("\n")
    .map((line) => `<div>&gt; ${line || "&nbsp;"}</div>`)
    .join("");
  return `<div>${escapeHtml(attribution)}</div><blockquote>${quoted}</blockquote>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/* Label                                                               */
/* ------------------------------------------------------------------ */

export const gmailLabelHandler: NodeHandler = async (context) => {
  const config = context.config;
  const connection = await connect(context, config);

  const target = required(config, "message", "a message id");
  const label = parseLabel(config.label, "label");
  const operation = text(config, "operation") === "remove" ? "remove" : "add";

  const updated = await gmailRequest<{ labelIds?: string[] }>(
    connection,
    "messages.modify",
    `/messages/${encodeURIComponent(target)}/modify`,
    {
      method: "POST",
      body:
        operation === "add"
          ? { addLabelIds: [label] }
          : { removeLabelIds: [label] },
    },
  );

  return {
    output: {
      messageId: target,
      label,
      operation,
      labels: updated.labelIds ?? [],
    },
  };
};

/* ------------------------------------------------------------------ */
/* Get                                                                 */
/* ------------------------------------------------------------------ */

export const gmailGetHandler: NodeHandler = async (context) => {
  const config = context.config;
  const connection = await connect(context, config);

  const target = required(config, "message", "a message id");
  const format = text(config, "format") === "metadata" ? "metadata" : "full";
  const message = await fetchMessage(connection, target, format);

  if (!message.id) {
    throw integrationError(
      GMAIL_ERRORS.messageNotFound,
      "That message could not be found in the connected mailbox.",
      { hint: "Check the message id — the trigger exposes it as {{trigger.messageId}}." },
    );
  }

  return { output: outputsFrom(normalizeMessage(message)) };
};

export const gmailHandlers: Record<string, NodeHandler> = {
  "trigger.gmail": gmailTriggerHandler,
  "action.gmail_send": gmailSendHandler,
  "action.gmail_reply": gmailReplyHandler,
  "action.gmail_label": gmailLabelHandler,
  "action.gmail_get": gmailGetHandler,
};
