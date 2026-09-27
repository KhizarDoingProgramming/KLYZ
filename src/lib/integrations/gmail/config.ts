import { GMAIL_ERRORS, REMEDIATION, integrationError } from "../errors";

/**
 * Gmail input validation.
 *
 * Recipients and label names are the only free-text values a node hands
 * to Google. Both are validated before they are put on the wire so a
 * malformed address produces an understandable step failure rather than
 * a 400 from an endpoint that also reports the address back.
 */

/**
 * Deliberately permissive: local part + domain with at least one
 * dot-separated label after it. Multi-label domains
 * (`dana@ops.northwind.co.uk`) must pass — the first version of this
 * pattern only allowed a single dot and rejected them.
 */
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>".]+(?:\.[^\s@,;<>".]+)+$/;

function configError(message: string, hint: string): never {
  throw integrationError(GMAIL_ERRORS.configInvalid, message, {
    hint,
    remediation: REMEDIATION.inspect,
  });
}

/** Validates one address, returning it unchanged. */
export function parseEmail(raw: unknown, label: string): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    throw integrationError(
      GMAIL_ERRORS.recipientInvalid,
      `This Gmail step has no ${label} address.`,
      { hint: `Fill in "${label}" on the node.`, remediation: REMEDIATION.inspect },
    );
  }
  if (!EMAIL_RE.test(value)) {
    throw integrationError(
      GMAIL_ERRORS.recipientInvalid,
      `"${value}" is not a valid email address for ${label}.`,
      {
        hint: "Use an address like dana@northwind.io — no display name in this field.",
        remediation: REMEDIATION.inspect,
      },
    );
  }
  return value;
}

/** Validates a comma-separated recipient list; empty input is allowed. */
export function parseRecipients(raw: unknown, label: string): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  return text
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseEmail(entry, label));
}

/** Gmail label ids/names: no whitespace, reasonable length. */
export function parseLabel(raw: unknown, label: string): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    throw integrationError(
      GMAIL_ERRORS.configInvalid,
      `This Gmail step has no ${label}.`,
      { hint: `Fill in "${label}" on the node.`, remediation: REMEDIATION.inspect },
    );
  }
  if (value.length > 225 || /[\r\n]/.test(value)) {
    return configError(
      `"${value.slice(0, 40)}" is not a valid Gmail label.`,
      "Label names are single-line and at most 225 characters.",
    );
  }
  return value;
}

/** Required non-empty text. */
export function requiredText(config: Record<string, unknown>, key: string, label: string): string {
  const value = typeof config[key] === "string" ? (config[key] as string).trim() : "";
  if (!value) {
    configError(
      `This Gmail step is missing ${label}.`,
      `Fill in "${label}" on the node.`,
    );
  }
  return value;
}

/** RFC 2822-ish address line for the raw message we compose. */
export function addressHeader(addresses: string[]): string {
  return addresses.join(", ");
}
