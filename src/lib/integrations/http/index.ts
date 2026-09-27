import { defineIntegration } from "../types";
import { httpDefinition } from "./definition";
import { httpHandler } from "./handler";

export const httpIntegration = defineIntegration({
  id: "http",
  label: "HTTP request",
  definitions: [httpDefinition],
  handlers: {
    "action.http": httpHandler,
  },
});

export { assertTarget, isPrivateAddress, safeLookup, type UrlPolicy } from "./ssrf";
export { performHttpRequest, type PerformRequest, type RequestResult } from "./request";
