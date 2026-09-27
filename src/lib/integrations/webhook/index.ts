import { defineIntegration } from "../types";
import { webhookDefinition } from "./definition";
import { webhookTriggerHandler } from "./handler";

export const webhookIntegration = defineIntegration({
  id: "webhook",
  label: "Webhook",
  definitions: [webhookDefinition],
  handlers: {
    "trigger.webhook": webhookTriggerHandler,
  },
});
