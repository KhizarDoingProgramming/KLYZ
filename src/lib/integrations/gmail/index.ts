import { defineIntegration } from "../types";
import {
  gmailGetDefinition,
  gmailLabelDefinition,
  gmailReplyDefinition,
  gmailSendDefinition,
  gmailTriggerDefinition,
} from "./definition";
import { gmailHandlers } from "./handler";

/**
 * Gmail integration.
 *
 * Owns the trigger, the four message nodes, their handlers and the
 * watch/cursor state that makes push notifications real. Registered in
 * `../registry.ts`; the pure bundle in `../definitions.ts` imports only
 * `./definition`.
 */
export const gmailIntegration = defineIntegration({
  id: "gmail",
  label: "Gmail",
  definitions: [
    gmailTriggerDefinition,
    gmailSendDefinition,
    gmailReplyDefinition,
    gmailLabelDefinition,
    gmailGetDefinition,
  ],
  handlers: gmailHandlers,
});

export { normalizeMessage, buildRawMessage, encodeRaw } from "./normalize";
export { ensureWatch, stopWatch, getWatch, readCursor, writeCursor, watchNeedsRenewal } from "./watch";
