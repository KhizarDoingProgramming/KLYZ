import { EngineError } from "@/lib/engine/types";
import type { ExecutionError } from "@/lib/workflow/types";

/**
 * Integration failure contract.
 *
 * Every integration error carries a stable machine code, a message safe
 * to persist, and — when the failure is transient — `retryable: true`
 * so the engine's attempt loop can re-run the step with backoff. Codes
 * are documented in `docs/integrations.md`.
 */

type Remediation = NonNullable<ExecutionError["remediation"]>;

export const REMEDIATION = {
  inspect: { label: "Inspect configuration", kind: "inspect" } as const,
  retry: { label: "Run again", kind: "retry" } as const,
  reconnect: { label: "Reconnect credential", kind: "reconnect" } as const,
} satisfies Record<string, Remediation>;

export interface IntegrationErrorOptions {
  detail?: string;
  hint?: string;
  remediation?: Remediation;
  httpStatus?: number;
  cause?: unknown;
  /** Transient failures let the engine retry the step with backoff. */
  retryable?: boolean;
}

export function integrationError(
  code: string,
  message: string,
  options: IntegrationErrorOptions = {},
): EngineError {
  return new EngineError(code, message, {
    detail: options.detail,
    hint: options.hint,
    remediation: options.remediation ?? REMEDIATION.inspect,
    httpStatus: options.httpStatus,
    retryable: options.retryable ?? false,
    cause: options.cause,
  });
}

/** Stable error codes raised by integration handlers. */
export const HTTP_ERRORS = {
  urlInvalid: "HTTP_URL_INVALID",
  blockedTarget: "HTTP_BLOCKED_TARGET",
  credentialInvalid: "HTTP_CREDENTIAL_INVALID",
  dnsFailure: "HTTP_DNS_FAILURE",
  connectionFailed: "HTTP_CONNECTION_FAILED",
  timeout: "HTTP_TIMEOUT",
  status: "HTTP_STATUS",
  responseTooLarge: "HTTP_RESPONSE_TOO_LARGE",
} as const;

export const POSTGRES_ERRORS = {
  credentialInvalid: "POSTGRES_CREDENTIAL_INVALID",
  connectionFailed: "POSTGRES_CONNECTION_FAILED",
  timeout: "POSTGRES_TIMEOUT",
  invalidQuery: "POSTGRES_INVALID_QUERY",
  queryFailed: "POSTGRES_QUERY_FAILED",
} as const;

export const WEBHOOK_ERRORS = {
  notFound: "WEBHOOK_NOT_FOUND",
  methodNotAllowed: "WEBHOOK_METHOD_NOT_ALLOWED",
  authFailed: "WEBHOOK_AUTH_FAILED",
  workflowInactive: "WEBHOOK_WORKFLOW_INACTIVE",
} as const;

export const TRANSFORM_ERRORS = {
  invalidConfig: "TRANSFORM_INVALID_CONFIG",
  invalidExpression: "TRANSFORM_INVALID_EXPRESSION",
} as const;

/**
 * Codes raised by the GitHub module (see docs/integrations.md).
 *
 * Connection problems — missing credential, expired token, revoked
 * scope — are not here on purpose: they surface as the shared
 * provider connection codes from `provider/connection.ts`.
 */
export const GITHUB_ERRORS = {
  repositoryInvalid: "GITHUB_REPOSITORY_INVALID",
  issueNumberInvalid: "GITHUB_ISSUE_NUMBER_INVALID",
  configInvalid: "GITHUB_CONFIG_INVALID",
  deliveryRejected: "GITHUB_DELIVERY_REJECTED",
} as const;

/** Codes raised by the Gmail module (see docs/integrations.md). */
export const GMAIL_ERRORS = {
  recipientInvalid: "GMAIL_RECIPIENT_INVALID",
  configInvalid: "GMAIL_CONFIG_INVALID",
  messageNotFound: "GMAIL_MESSAGE_NOT_FOUND",
} as const;

/** Codes raised by the Google Sheets module. */
export const SHEETS_ERRORS = {
  configInvalid: "SHEETS_CONFIG_INVALID",
  spreadsheetInvalid: "SHEETS_SPREADSHEET_INVALID",
  rangeInvalid: "SHEETS_RANGE_INVALID",
  clearUnconfirmed: "SHEETS_CLEAR_UNCONFIRMED",
} as const;

/** Codes raised by the Notion module. */
export const NOTION_ERRORS = {
  configInvalid: "NOTION_CONFIG_INVALID",
  pageIdInvalid: "NOTION_PAGE_ID_INVALID",
  parentInvalid: "NOTION_PARENT_INVALID",
  propertyUnsupported: "NOTION_PROPERTY_UNSUPPORTED",
} as const;

/** Codes raised by the Slack module. */
export const SLACK_ERRORS = {
  configInvalid: "SLACK_CONFIG_INVALID",
  channelInvalid: "SLACK_CHANNEL_INVALID",
  messageEmpty: "SLACK_MESSAGE_EMPTY",
  threadInvalid: "SLACK_THREAD_INVALID",
  signatureRejected: "SLACK_SIGNATURE_REJECTED",
} as const;
