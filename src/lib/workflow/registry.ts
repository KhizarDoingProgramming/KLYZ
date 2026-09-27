import { integrationDefinitions } from "@/lib/integrations/definitions";
import { NODE_CATEGORIES, type NodeDefinition } from "./types";

/**
 * Node registry.
 *
 * Every node type KLYZ can execute is declared here as data: its category,
 * icon, configuration schema, credentials and output shape. The editor,
 * the config panel, the data picker, validation and (in future) the AI
 * workflow generator all read from this single source — nothing about a
 * node is hardcoded into the UI.
 *
 * Adding an integration = adding one entry.
 */

const stringOut = (key: string, label: string) => ({ key, label, type: "string" as const });
const numberOut = (key: string, label: string) => ({ key, label, type: "number" as const });

export const NODE_DEFINITIONS: Record<string, NodeDefinition> = {
  /* ----------------------------- TRIGGERS ----------------------------- */

  "trigger.schedule": {
    type: "trigger.schedule",
    category: "trigger",
    title: "Schedule",
    description: "Runs the workflow on a fixed interval or cron expression.",
    icon: "clock",
    summary: "Runs on an interval",
    trigger: true,
    cost: 12,
    fields: [
      {
        key: "every",
        label: "Interval",
        kind: "select",
        options: [
          { value: "5m", label: "Every 5 minutes" },
          { value: "15m", label: "Every 15 minutes" },
          { value: "1h", label: "Every hour" },
          { value: "1d", label: "Every day" },
          { value: "cron", label: "Cron expression" },
        ],
        required: true,
      },
      {
        key: "cron",
        label: "Cron",
        kind: "text",
        placeholder: "0 9 * * 1-5",
        mono: true,
        showWhen: { key: "every", equals: "cron" },
      },
      { key: "timezone", label: "Timezone", kind: "text", placeholder: "UTC", mono: true },
    ],
    outputs: [
      stringOut("scheduledFor", "Scheduled for"),
      stringOut("runKey", "Run key"),
      { key: "previous", label: "Previous run", type: "object" },
    ],
  },

  "trigger.manual": {
    type: "trigger.manual",
    category: "trigger",
    title: "Manual run",
    description: "Starts the workflow by hand, from the editor or the command palette.",
    icon: "play",
    summary: "Started by a person",
    trigger: true,
    cost: 5,
    fields: [
      {
        key: "sample",
        label: "Sample payload",
        kind: "code",
        placeholder: '{ "ticket": "KLYZ-104" }',
        help: "Used to fill inputs while you test the workflow.",
      },
    ],
    outputs: [{ key: "payload", label: "Payload", type: "object" }],
  },

  /* ------------------------------ ACTIONS ----------------------------- */

  "action.log": {
    type: "action.log",
    category: "utility",
    title: "Log",
    description: "Writes a message to this execution's run log.",
    icon: "terminal",
    summary: "Writes a run log entry",
    cost: 3,
    fields: [
      {
        key: "message",
        label: "Message",
        kind: "expression",
        required: true,
        bindable: true,
        rows: 3,
        placeholder: "Processed {{crm.rowCount}} rows",
      },
      {
        key: "level",
        label: "Level",
        kind: "select",
        options: [
          { value: "info", label: "Info" },
          { value: "warn", label: "Warning" },
          { value: "error", label: "Error" },
        ],
      },
    ],
    outputs: [
      stringOut("message", "Message"),
      stringOut("level", "Level"),
      stringOut("loggedAt", "Logged at"),
    ],
  },

  /* ------------------------------- LOGIC ------------------------------ */

  "logic.condition": {
    type: "logic.condition",
    category: "logic",
    title: "Condition",
    description: "Splits the workflow into branches based on a rule.",
    icon: "git-branch",
    summary: "Branches on a rule",
    cost: 12,
    branches: ["true", "false"],
    fields: [
      { key: "left", label: "Value", kind: "expression", required: true, bindable: true, placeholder: "{{ai.priority}}" },
      {
        key: "operator",
        label: "Operator",
        kind: "select",
        required: true,
        options: [
          { value: "eq", label: "equals" },
          { value: "neq", label: "does not equal" },
          { value: "contains", label: "contains" },
          { value: "notContains", label: "does not contain" },
          { value: "startsWith", label: "starts with" },
          { value: "endsWith", label: "ends with" },
          { value: "gt", label: "is greater than" },
          { value: "gte", label: "is greater than or equal" },
          { value: "lt", label: "is less than" },
          { value: "lte", label: "is less than or equal" },
          { value: "exists", label: "exists" },
          { value: "notExists", label: "does not exist" },
          { value: "matches", label: "matches regex" },
        ],
      },
      { key: "right", label: "Against", kind: "expression", bindable: true, placeholder: "high" },
      {
        key: "caseSensitive",
        label: "Case sensitive",
        kind: "toggle",
      },
    ],
    outputs: [
      { key: "result", label: "Result", type: "boolean" },
      { key: "matchedBranch", label: "Branch", type: "string" },
    ],
  },

  "logic.switch": {
    type: "logic.switch",
    category: "logic",
    title: "Switch",
    description: "Routes data to one of several named paths.",
    icon: "split",
    summary: "Routes to a path",
    cost: 14,
    branches: ["case a", "case b", "fallback"],
    fields: [
      { key: "value", label: "Switch on", kind: "expression", required: true, bindable: true, placeholder: "{{github.issue.labels[0]}}" },
      { key: "cases", label: "Cases", kind: "keyvalue", help: "Label → value pairs. Unmatched values take the fallback branch." },
    ],
    outputs: [{ key: "matchedCase", label: "Matched case", type: "string" }],
  },

  "logic.delay": {
    type: "logic.delay",
    category: "logic",
    title: "Delay",
    description: "Pauses this branch for a fixed or computed duration.",
    icon: "timer",
    summary: "Waits before continuing",
    cost: 5,
    fields: [
      {
        key: "duration",
        label: "Wait",
        kind: "select",
        options: [
          { value: "30s", label: "30 seconds" },
          { value: "5m", label: "5 minutes" },
          { value: "1h", label: "1 hour" },
          { value: "24h", label: "24 hours" },
          { value: "custom", label: "Custom" },
        ],
        required: true,
      },
      { key: "custom", label: "Duration (ms)", kind: "number", showWhen: { key: "duration", equals: "custom" }, placeholder: "600000" },
    ],
    outputs: [stringOut("resumedAt", "Resumed at")],
  },

  "logic.filter": {
    type: "logic.filter",
    category: "logic",
    title: "Filter",
    description: "Stops the branch silently when the expression is not truthy.",
    icon: "filter",
    summary: "Drops non-matching data",
    cost: 8,
    fields: [
      {
        key: "expression",
        label: "Keep when",
        kind: "expression",
        required: true,
        bindable: true,
        rows: 3,
        placeholder: "{{payload.email}} != null",
      },
      { key: "onSkip", label: "When filtered", kind: "select", options: [
        { value: "skip", label: "Mark step as skipped" },
        { value: "stop", label: "Stop the workflow" },
      ]},
    ],
    outputs: [{ key: "passed", label: "Passed", type: "boolean" }],
  },

  "logic.loop": {
    type: "logic.loop",
    category: "logic",
    title: "Loop",
    description: "Runs the connected steps once per item in a list.",
    icon: "repeat",
    summary: "Iterates over a list",
    cost: 20,
    fields: [
      { key: "over", label: "Iterate over", kind: "expression", required: true, bindable: true, placeholder: "{{http.body.items}}" },
      {
        key: "mode",
        label: "Mode",
        kind: "select",
        options: [
          { value: "each", label: "Each item" },
          { value: "batched", label: "Batched" },
        ],
      },
      { key: "batchSize", label: "Batch size", kind: "number", showWhen: { key: "mode", equals: "batched" }, placeholder: "25" },
      { key: "maxItems", label: "Max items", kind: "number", placeholder: "100", help: "The run stops here instead of looping forever." },
    ],
    outputs: [
      { key: "results", label: "Results", type: "array" },
      numberOut("count", "Iterations"),
    ],
  },

  /* -------------------------------- AI -------------------------------- */

  "ai.extract": {
    type: "ai.extract",
    category: "ai",
    title: "Extract",
    description: "Pulls structured fields out of unstructured text.",
    icon: "scan",
    summary: "Pulls fields from text",
    cost: 1810,
    fields: [
      { key: "input", label: "From", kind: "expression", required: true, bindable: true, placeholder: "{{gmail.body}}" },
      { key: "schema", label: "Fields to extract", kind: "keyvalue", required: true, help: "Name → expected type. The model returns one value per field." },
      { key: "instructions", label: "Instructions", kind: "textarea", rows: 4, placeholder: "Extract only what is stated. Return null when unknown." },
    ],
    outputs: [{ key: "fields", label: "Fields", type: "object" }],
  },

  "ai.summarize": {
    type: "ai.summarize",
    category: "ai",
    title: "Summarize",
    description: "Condenses long content into a short, usable summary.",
    icon: "sparkle",
    summary: "Condenses content",
    cost: 1650,
    fields: [
      { key: "input", label: "Content", kind: "expression", required: true, bindable: true, placeholder: "{{github.issue.body}}" },
      { key: "length", label: "Length", kind: "select", options: [
        { value: "one_liner", label: "One line" },
        { value: "short", label: "Short paragraph" },
        { value: "detailed", label: "Detailed" },
      ]},
      { key: "tone", label: "Audience", kind: "text", placeholder: "Support engineers" },
    ],
    outputs: [stringOut("summary", "Summary"), numberOut("tokens", "Tokens used")],
  },

  "ai.classify": {
    type: "ai.classify",
    category: "ai",
    title: "Classify",
    description: "Assigns a label from a list you provide.",
    icon: "tags",
    summary: "Assigns a label",
    cost: 1200,
    fields: [
      { key: "input", label: "Content", kind: "expression", required: true, bindable: true, placeholder: "{{github.issue.title}}" },
      { key: "labels", label: "Labels", kind: "expression", required: true, bindable: true, placeholder: "bug, feature, question" },
      { key: "multi", label: "Allow multiple labels", kind: "toggle" },
    ],
    outputs: [
      stringOut("label", "Label"),
      { key: "scores", label: "Confidence", type: "object" },
    ],
  },

  "ai.generate": {
    type: "ai.generate",
    category: "ai",
    title: "Generate",
    description: "Writes text from a prompt, using upstream data as context.",
    icon: "wand",
    summary: "Writes a response",
    cost: 2400,
    fields: [
      { key: "prompt", label: "Prompt", kind: "textarea", required: true, bindable: true, rows: 6, placeholder: "Write a triage note for {{github.issue.title}}" },
      { key: "context", label: "Context", kind: "expression", bindable: true, placeholder: "{{github.issue.body}}" },
      { key: "temperature", label: "Temperature", kind: "number", placeholder: "0.3" },
    ],
    outputs: [stringOut("text", "Text"), numberOut("tokens", "Tokens used")],
  },

  /* -------------------------------- DATA ------------------------------ */

  "data.variables": {
    type: "data.variables",
    category: "data",
    title: "Variables",
    description: "Stores values that later steps can reference.",
    icon: "variable",
    summary: "Sets values",
    cost: 4,
    fields: [{ key: "values", label: "Values", kind: "keyvalue", bindable: true, required: true }],
    outputs: [{ key: "vars", label: "Values", type: "object" }],
  },

  "data.json": {
    type: "data.json",
    category: "data",
    title: "JSON",
    description: "Parses or serialises JSON text.",
    icon: "braces",
    summary: "Parses JSON",
    cost: 5,
    fields: [
      { key: "mode", label: "Mode", kind: "select", options: [
        { value: "parse", label: "Parse text → object" },
        { value: "stringify", label: "Serialise object → text" },
      ], required: true },
      { key: "source", label: "Input", kind: "expression", required: true, bindable: true, rows: 4, placeholder: "{{webhook.body}}" },
    ],
    outputs: [{ key: "value", label: "Value", type: "object" }],
  },
  "data.transform": {
    type: "data.transform",
    category: "data",
    title: "Transform",
    description: "Transforms arrays or objects declaratively.",
    icon: "layers",
    summary: "Transforms data",
    cost: 5,
    fields: [
      { key: "source", label: "Input", kind: "expression", required: true, bindable: true, placeholder: "{{http.body.items}}" },
      { key: "operations", label: "Operations", kind: "keyvalue", help: "Label → expression to map, filter, or rename." },
    ],
    outputs: [{ key: "result", label: "Result", type: "object" }],
  },
};

/* Integration modules own their node definitions — merged in, not
   duplicated here, so palette/config/validation see one catalogue. */
for (const definition of integrationDefinitions()) {
  NODE_DEFINITIONS[definition.type] = definition;
}

export function getDefinition(type: string): NodeDefinition | undefined {
  return NODE_DEFINITIONS[type];
}

export const DEFINITIONS_BY_CATEGORY = NODE_CATEGORIES.map((category) => ({
  category,
  definitions: Object.values(NODE_DEFINITIONS).filter(
    (d) => d.category === category,
  ),
}));
