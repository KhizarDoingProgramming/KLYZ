import { defineIntegration } from "../types";
import { githubCommentDefinition, githubIssueDefinition, githubTriggerDefinition } from "./definition";
import { githubHandlers } from "./handler";

/**
 * GitHub integration.
 *
 * Owns the trigger, the two write/read nodes, their handlers and the
 * webhook lifecycle helpers. Registered in `../registry.ts`; the pure
 * definition bundle in `../definitions.ts` imports only `./definition`,
 * so the editor never pulls the HTTP client or credential store into
 * the browser.
 */
export const githubIntegration = defineIntegration({
  id: "github",
  label: "GitHub",
  definitions: [githubTriggerDefinition, githubIssueDefinition, githubCommentDefinition],
  handlers: githubHandlers,
});

export { normalizeGitHubEvent, eventOutputs, normalizeIssue } from "./normalize";
export { verifyGitHubSignature, signGitHubPayload, parseGitHubDelivery } from "./webhook";
export { GITHUB_EVENTS, findEvent, hookEventsFor, matchesEvent, parseRepository } from "./config";
