import { defineIntegration } from "../types";
import { notionPageDefinition, notionSearchDefinition } from "./definition";
import { notionHandlers } from "./handler";

/**
 * Notion integration.
 *
 * Owns the page and search nodes, their handlers and the property
 * mapping engine that turns plain workflow values into Notion's typed
 * property payloads. Registered in `../registry.ts`; the pure bundle in
 * `../definitions.ts` imports only `./definition`, so the editor never
 * pulls the HTTP client or credential store into the browser.
 */
export const notionIntegration = defineIntegration({
  id: "notion",
  label: "Notion",
  definitions: [notionPageDefinition, notionSearchDefinition],
  handlers: notionHandlers,
});

export { notionPageDefinition, notionSearchDefinition };
export { parseNotionId, parseParentType, dashed, plainText } from "./config";
export {
  buildProperties,
  normalizeProperties,
  textToBlocks,
  SUPPORTED_PROPERTY_TYPES,
} from "./properties";
export { normalizePage, extractTitle, normalizeSearchResult, pageUrl } from "./normalize";
export type { NotionPage, NotionSearchResult } from "./normalize";
export type { PropertySchema, PropertyType, PropertyValue } from "./properties";
