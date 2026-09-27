import { defineIntegration } from "../types";
import {
  slackChannelDefinition,
  slackMessageDefinition,
  slackTriggerDefinition,
} from "./definition";
import { slackHandlers } from "./handler";

/**
 * Slack integration.
 *
 * Owns the message and channel nodes, the Events API trigger, their
 * handlers and the signature helpers the receiver needs. Registered in
 * `../registry.ts`; the pure definition bundle in `../definitions.ts`
 * imports only `./definition`, so the editor never pulls `node:crypto`,
 * the HTTP client or the credential store into the browser.
 */
export const slackIntegration = defineIntegration({
  id: "slack",
  label: "Slack",
  definitions: [slackMessageDefinition, slackChannelDefinition, slackTriggerDefinition],
  handlers: slackHandlers,
});

export {
  normalizeSlackEvent,
  parseSlackChallenge,
  parseSlackDelivery,
  slackMessageKind,
  verifySlackSignature,
} from "./webhook";
export type {
  NormalizedSlackEvent,
  SlackDeliveryHeaders,
  SlackSignatureParams,
  SlackSignatureResult,
} from "./webhook";
export { normaliseChannelRef, parseThreadTs, buildMessageText, looksLikeChannelId } from "./config";
export { findChannel, resolveChannel, clearChannelCache } from "./channels";
export type { SlackChannelRef } from "./channels";
