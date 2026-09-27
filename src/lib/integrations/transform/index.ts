import { defineIntegration } from "../types";
import { operationsDefinition, transformDefinition } from "./definition";
import { operationsHandler, transformMappingHandler } from "./handler";

export const transformIntegration = defineIntegration({
  id: "transform",
  label: "Data transform",
  definitions: [transformDefinition, operationsDefinition],
  handlers: {
    "logic.transform": transformMappingHandler,
    "logic.operations": operationsHandler,
  },
});

export { AGGREGATE_FNS, OPERATIONS, OPERATION_IDS, applyOperation } from "./operations";
