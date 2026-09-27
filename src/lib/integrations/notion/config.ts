import { NOTION_ERRORS, REMEDIATION, integrationError } from "../errors";

/**
 * Notion input validation.
 *
 * Notion hands out ids in several shapes — a bare 32-character hex, the
 * dashed UUID form, or a URL copied straight from the browser with a
 * slug in front of it. They are all reduced to one canonical form here,
 * so the paths a node builds are always identical and nothing else can
 * be interpolated into them.
 */

const HEX_ID_RE = /^[0-9a-f]{32}$/i;
const DASHED_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_IN_TEXT_RE = /[0-9a-f]{32}/i;
const DASHED_IN_TEXT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function idError(raw: string): never {
  throw integrationError(
    NOTION_ERRORS.pageIdInvalid,
    `"${raw || "…"}" is not a Notion page or database id.`,
    {
      hint: "Paste the 32-character id, or the whole Notion URL — the browser bar is fine.",
      remediation: REMEDIATION.inspect,
    },
  );
}

/** Canonical id: 32 lowercase hex characters, no dashes. */
export function parseNotionId(raw: string): string {
  const value = String(raw ?? "").trim();
  if (HEX_ID_RE.test(value)) return value.toLowerCase();
  if (DASHED_ID_RE.test(value)) return value.replace(/-/g, "").toLowerCase();
  if (/^https?:\/\//i.test(value) || value.includes("notion.so")) {
    /* Query strings can carry a view id (`?v=`) that names a different
       resource than the one that was copied — search the path only. */
    const path = value.split(/[?#]/)[0] ?? "";
    const hex = path.match(HEX_IN_TEXT_RE);
    if (hex) return hex[0].toLowerCase();
    const dashed = path.match(DASHED_IN_TEXT_RE);
    if (dashed) return dashed[0].replace(/-/g, "").toLowerCase();
  }
  return idError(value);
}

/** Canonical id → the dashed UUID form Notion shows in its URLs. */
export function dashed(id: string): string {
  const canonical = parseNotionId(id);
  return `${canonical.slice(0, 8)}-${canonical.slice(8, 12)}-${canonical.slice(12, 16)}-${canonical.slice(16, 20)}-${canonical.slice(20)}`;
}

/** Where a new page is created: inside a database or under a page. */
export function parseParentType(raw: unknown): "database" | "page" {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "" || value === "database") return "database";
  if (value === "page") return "page";
  throw integrationError(
    NOTION_ERRORS.parentInvalid,
    `"${String(raw ?? "")}" is not a Notion parent type.`,
    {
      hint: 'Choose "In a database" or "Inside a page" on the node.',
      remediation: REMEDIATION.inspect,
    },
  );
}

/** Trimmed text from any config value; empty string when absent. */
export function plainText(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return typeof raw === "string" ? raw.trim() : String(raw).trim();
}
