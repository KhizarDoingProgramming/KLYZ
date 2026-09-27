import type { NodeHandler } from "@/lib/engine/types";
import type { NodeDefinition } from "@/lib/workflow/types";

/**
 * Integration modules.
 *
 * An integration is one file-tree that owns everything about a connector:
 * the node definitions it contributes to the palette, the handlers that
 * execute them, and (for credential-backed nodes) which credential kinds
 * it accepts. The engine never hardcodes node behaviour — `getHandler`
 * consults this registry first, so adding an integration means adding a
 * module, not editing the executor.
 */
export interface IntegrationModule {
  /** Stable id — `http`, `postgres`, `webhook`, `transform`. */
  id: string;
  /** Human label used in docs, logs and the final report. */
  label: string;
  /** Node definitions this module contributes to the editor. */
  definitions: NodeDefinition[];
  /** Execution handlers keyed by node type. */
  handlers: Record<string, NodeHandler>;
}

export function defineIntegration(module: IntegrationModule): IntegrationModule {
  return module;
}
