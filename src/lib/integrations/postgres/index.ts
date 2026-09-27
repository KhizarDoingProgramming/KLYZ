import { defineIntegration } from "../types";
import { postgresActionDefinition, postgresReadDefinition } from "./definition";
import { postgresHandler } from "./handler";

export const postgresIntegration = defineIntegration({
  id: "postgres",
  label: "PostgreSQL",
  definitions: [postgresActionDefinition, postgresReadDefinition],
  handlers: {
    "action.postgres": postgresHandler,
    "data.postgres": postgresHandler,
  },
});

export {
  applyRowLimit,
  assertSafeQuery,
  assertTableName,
  buildInsert,
  buildSelect,
  buildUpdate,
  maxParamIndex,
  paramValues,
} from "./sql";
export { connectionConfig, mapPostgresError } from "./handler";
