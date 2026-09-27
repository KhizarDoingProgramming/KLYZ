import { Buffer } from "node:buffer";

/**
 * Gmail payload normalisation.
 *
 * Gmail returns RFC 2822 messages as base64url-encoded MIME trees.
 * Everything a workflow normally references is lifted to a flat,
 * stable shape — the untouched payload stays available under `raw` for
 * advanced mapping and debugging.
 */

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
  internalDate?: string;
  historyId?: string;
  sizeEstimate?: number;
}

export interface NormalizedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface NormalizedMessage {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string;
  fromEmail: string;
  to: string;
  cc: string;
  replyTo: string;
  snippet: string;
  body: string;
  bodyHtml: string;
  labels: string[];
  url: string;
  receivedAt: string;
  hasAttachments: boolean;
  attachments: NormalizedAttachment[];
  historyId: string;
  /** Untouched provider payload for advanced mapping. */
  raw: Record<string, unknown>;
}

/** base64url → UTF-8 text. Gmail uses URL-safe base64 without padding. */
export function decodeBase64Url(data: string): string {
  if (!data) return "";
  try {
    const buffer = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

export function headers(payload: GmailPart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of payload?.headers ?? []) {
    if (!header?.name) continue;
    out[header.name.toLowerCase()] = header.value ?? "";
  }
  return out;
}

/** `Dana <dana@northwind.io>` → `{ name: "Dana", email: "dana@northwind.io" }`. */
export function splitAddress(value: string): { name: string; email: string } {
  const match = value.match(/^\s*(?:"?([^"]*)"?\s*)?<([^>]+)>\s*$/);
  if (match?.[2]) return { name: (match[1] ?? "").trim(), email: match[2].trim() };
  const trimmed = value.trim();
  return { name: trimmed.replace(/<.*>/, "").trim(), email: trimmed };
}

function walkParts(part: GmailPart | undefined, visit: (part: GmailPart) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walkParts(child, visit);
}

/** Depth-first search for the first part with a given MIME type. */
function findPart(root: GmailPart | undefined, mimeType: string): GmailPart | undefined {
  let found: GmailPart | undefined;
  walkParts(root, (part) => {
    if (!found && part.mimeType === mimeType) found = part;
  });
  return found;
}

function bodyText(root: GmailPart | undefined, mimeType: string): string {
  const part = findPart(root, mimeType);
  return decodeBase64Url(part?.body?.data ?? "");
}

function collectAttachments(root: GmailPart | undefined): NormalizedAttachment[] {
  const out: NormalizedAttachment[] = [];
  walkParts(root, (part) => {
    if (!part.filename) return;
    out.push({
      id: part.body?.attachmentId ?? "",
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
    });
  });
  return out;
}

export function normalizeMessage(message: GmailMessage | undefined): NormalizedMessage {
  const source = (message ?? {}) as GmailMessage;
  const payload = source.payload;
  const map = headers(payload);
  const from = splitAddress(map.from ?? "");
  const receivedAt = source.internalDate
    ? new Date(Number(source.internalDate)).toISOString()
    : new Date().toISOString();
  const id = source.id ?? "";

  return {
    messageId: id,
    threadId: source.threadId ?? "",
    subject: map.subject ?? "",
    from: map.from ?? "",
    fromName: from.name,
    fromEmail: from.email,
    to: map.to ?? "",
    cc: map.cc ?? "",
    replyTo: map["reply-to"] ?? "",
    snippet: source.snippet ?? "",
    body: bodyText(payload, "text/plain") || stripHtml(bodyText(payload, "text/html")),
    bodyHtml: bodyText(payload, "text/html"),
    labels: source.labelIds ?? [],
    url: id ? `https://mail.google.com/mail/u/0/#all/${id}` : "",
    receivedAt,
    attachments: collectAttachments(payload),
    hasAttachments: (source.labelIds ?? []).includes("HAS_ATTACHMENT"),
    historyId: source.historyId ?? "",
    raw: source as unknown as Record<string, unknown>,
  };
}

/** Fallback when a message carries only HTML — used for plain-text sends. */
export function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    /* Tags are replaced by spaces, so a `</p>` leaves an indent behind
       on the next line — plain-text replies must not inherit it. */
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Outgoing message                                                    */
/* ------------------------------------------------------------------ */

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  /** Threading — sets `threadId` and the reply headers Gmail needs. */
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

function rfc2822Date(date = new Date()): string {
  return date.toUTCString().replace("GMT", "+0000");
}

/**
 * Builds the RFC 2822 message Gmail expects as `raw`.
 *
 * Gmail composes the From header from the connected account, so it is
 * deliberately omitted — including it would be a guess, and a wrong
 * one would bounce.
 */
export function buildRawMessage(message: OutgoingMessage): string {
  const lines: string[] = [];
  lines.push(`To: ${addressHeader(message.to)}`);
  if (message.cc?.length) lines.push(`Cc: ${addressHeader(message.cc)}`);
  if (message.bcc?.length) lines.push(`Bcc: ${addressHeader(message.bcc)}`);
  lines.push(`Subject: ${encodeSubject(message.subject)}`);
  lines.push(`Date: ${rfc2822Date()}`);
  lines.push(`MIME-Version: 1.0`);
  if (message.inReplyTo) lines.push(`In-Reply-To: ${message.inReplyTo}`);
  if (message.references) lines.push(`References: ${message.references}`);

  if (message.html) {
    const boundary = `klyz_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/plain; charset="UTF-8"`);
    lines.push(`Content-Transfer-Encoding: 8bit`);
    lines.push("");
    lines.push(stripHtml(message.html));
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/html; charset="UTF-8"`);
    lines.push(`Content-Transfer-Encoding: 8bit`);
    lines.push("");
    lines.push(message.html);
    lines.push(`--${boundary}--`);
  } else {
    lines.push(`Content-Type: text/plain; charset="UTF-8"`);
    lines.push(`Content-Transfer-Encoding: 8bit`);
    lines.push("");
    lines.push(message.text ?? "");
  }
  lines.push("");
  return lines.join("\r\n");
}

function addressHeader(addresses: string[]): string {
  return addresses.join(", ");
}

/** Non-ASCII subjects must be RFC 2047 encoded. */
export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/** base64url encoding of the raw message, as the Gmail API requires. */
export function encodeRaw(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}
