import type { NodeDefinition } from "@/lib/workflow/types";
import { githubCommentDefinition, githubIssueDefinition, githubTriggerDefinition } from "./github/definition";
import {
  gmailGetDefinition,
  gmailLabelDefinition,
  gmailReplyDefinition,
  gmailSendDefinition,
  gmailTriggerDefinition,
} from "./gmail/definition";
import { httpDefinition } from "./http/definition";
import { sheetsAppendDefinition, sheetsReadDefinition, sheetsWriteDefinition } from "./google_sheets/definition";
import { notionPageDefinition, notionSearchDefinition } from "./notion/definition";
import { postgresActionDefinition, postgresReadDefinition } from "./postgres/definition";
import { slackChannelDefinition, slackMessageDefinition, slackTriggerDefinition } from "./slack/definition";
import { webhookDefinition } from "./webhook/definition";
import { operationsDefinition, transformDefinition } from "./transform/definition";

/**
 * Pure definition bundle.
 *
 * Only definition modules are imported here — no handlers, no server
 * code — so the editor (a client component) can merge the full node
 * catalogue without pulling `node:sqlite`, Redis or `node:http` into the
 * browser bundle. Handler lookup lives in `./registry.ts`.
 */
const DEFINITIONS: NodeDefinition[] = [
  githubTriggerDefinition,
  githubIssueDefinition,
  githubCommentDefinition,
  gmailTriggerDefinition,
  gmailSendDefinition,
  gmailReplyDefinition,
  gmailLabelDefinition,
  gmailGetDefinition,
  sheetsAppendDefinition,
  sheetsReadDefinition,
  sheetsWriteDefinition,
  notionPageDefinition,
  notionSearchDefinition,
  slackTriggerDefinition,
  slackMessageDefinition,
  slackChannelDefinition,
  httpDefinition,
  postgresActionDefinition,
  postgresReadDefinition,
  webhookDefinition,
  transformDefinition,
  operationsDefinition,
];

export function integrationDefinitions(): NodeDefinition[] {
  return DEFINITIONS;
}
