import type { NodeHandler } from "@/lib/engine/types";
import { githubIntegration } from "./github";
import { gmailIntegration } from "./gmail";
import { googleSheetsIntegration } from "./google_sheets";
import { httpIntegration } from "./http";
import { notionIntegration } from "./notion";
import { postgresIntegration } from "./postgres";
import { slackIntegration } from "./slack";
import { webhookIntegration } from "./webhook";
import { transformIntegration } from "./transform";
import { integrationDefinitions } from "./definitions";
import type { IntegrationModule } from "./types";

/**
 * Handler registry (server-side).
 *
 * `getHandler` in the engine consults this registry first, so an
 * integration's nodes execute through the code that owns them rather
 * than through anything hardcoded in the executor. Definitions are
 * re-exported from the pure bundle so consumers have one import path.
 */
const MODULES: IntegrationModule[] = [
  githubIntegration,
  gmailIntegration,
  googleSheetsIntegration,
  notionIntegration,
  slackIntegration,
  httpIntegration,
  postgresIntegration,
  webhookIntegration,
  transformIntegration,
];

export function integrationModules(): IntegrationModule[] {
  return MODULES;
}

export function getIntegrationHandler(nodeType: string): NodeHandler | undefined {
  for (const integration of MODULES) {
    const handler = integration.handlers[nodeType];
    if (handler) return handler;
  }
  return undefined;
}

export { integrationDefinitions };
