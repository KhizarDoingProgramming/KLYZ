import type { NodeDefinition, OutputField } from "@/lib/workflow/types";

const str = (key: string, label: string) => ({ key, label, type: "string" as const });
const num = (key: string, label: string) => ({ key, label, type: "number" as const });

const CREDENTIAL_HELP =
  "Connect a Notion workspace on the Integrations page. Only pages and databases shared with the integration are reachable.";

const PAGE_CHILDREN: OutputField[] = [
  str("id", "Id"),
  str("title", "Title"),
  str("url", "URL"),
  str("createdAt", "Created at"),
  str("updatedAt", "Updated at"),
  { key: "archived", label: "Archived", type: "boolean" },
  { key: "properties", label: "Properties", type: "object" },
  { key: "parent", label: "Parent", type: "object" },
  { key: "raw", label: "Raw payload", type: "object" },
];

const RESULT_CHILDREN: OutputField[] = [
  str("id", "Id"),
  str("title", "Title"),
  str("url", "URL"),
  str("type", "Kind"),
  str("createdAt", "Created at"),
  str("updatedAt", "Updated at"),
  { key: "archived", label: "Archived", type: "boolean" },
  str("icon", "Icon"),
];

/** Create, update or read a page in a database or under a page. */
export const notionPageDefinition: NodeDefinition = {
  type: "action.notion_page",
  category: "action",
  title: "Notion page",
  description: "Creates, updates or reads a page in Notion.",
  icon: "notion",
  summary: "Creates or updates a page",
  cost: 300,
  credentials: ["notion"],
  tags: ["notion"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    {
      key: "operation",
      label: "Operation",
      kind: "select",
      required: true,
      options: [
        { value: "create", label: "Create page" },
        { value: "update", label: "Update page" },
        { value: "get", label: "Get page" },
      ],
    },
    {
      key: "parentType",
      label: "Parent",
      kind: "select",
      required: true,
      showWhen: { key: "operation", equals: "create" },
      options: [
        { value: "database", label: "In a database" },
        { value: "page", label: "Inside a page" },
      ],
    },
    {
      key: "parentId",
      label: "Parent id",
      kind: "text",
      required: true,
      mono: true,
      bindable: true,
      showWhen: { key: "operation", equals: "create" },
      placeholder: "8f2a91c0…",
      help: "Database or page id — paste the Notion URL if easier.",
    },
    {
      key: "title",
      label: "Title",
      kind: "expression",
      required: true,
      bindable: true,
      showWhen: { key: "operation", equals: "create" },
      placeholder: "{{github.issue.title}}",
      help: "Page title. Inside a database it is written to the title property.",
    },
    {
      key: "content",
      label: "Content",
      kind: "textarea",
      rows: 6,
      bindable: true,
      showWhen: { key: "operation", equals: "create" },
      help: "Plain text — one paragraph per line.",
    },
    {
      key: "pageId",
      label: "Page",
      kind: "text",
      required: true,
      mono: true,
      bindable: true,
      showWhen: { key: "operation", equals: ["update", "get"] },
      placeholder: "{{notion.pageId}}",
    },
    {
      key: "properties",
      label: "Properties",
      kind: "keyvalue",
      bindable: true,
      showWhen: { key: "operation", equals: ["create", "update"] },
      help: "Property name → value. Types are read from the database schema.",
    },
    {
      key: "propertyTypes",
      label: "Property types",
      kind: "keyvalue",
      showWhen: { key: "operation", equals: ["create", "update"] },
      help: "Optional: property name → title | rich_text | number | checkbox | select | multi_select | url | email | date. Use this for page parents or when you know the schema.",
    },
    {
      key: "archived",
      label: "Archive page",
      kind: "toggle",
      showWhen: { key: "operation", equals: "update" },
      help: "Archive the page instead of leaving it in the workspace.",
    },
  ],
  outputs: [
    { key: "page", label: "Page", type: "object", children: PAGE_CHILDREN },
    str("pageId", "Page id"),
    str("url", "URL"),
    str("title", "Title"),
    str("operation", "Operation"),
  ],
};

/** Search the pages and databases the integration has been given. */
export const notionSearchDefinition: NodeDefinition = {
  type: "action.notion_search",
  category: "action",
  title: "Search Notion",
  description: "Searches the pages and databases the integration can see.",
  icon: "search",
  summary: "Searches Notion",
  cost: 220,
  credentials: ["notion"],
  tags: ["notion"],
  fields: [
    {
      key: "credential",
      label: "Connection",
      kind: "credential",
      required: true,
      help: CREDENTIAL_HELP,
    },
    {
      key: "query",
      label: "Query",
      kind: "expression",
      bindable: true,
      placeholder: "{{gmail.subject}}",
      help: "Leave empty to list everything the integration can see.",
    },
    {
      key: "kind",
      label: "Search in",
      kind: "select",
      options: [
        { value: "all", label: "Pages and databases" },
        { value: "page", label: "Pages only" },
        { value: "database", label: "Databases only" },
      ],
    },
    {
      key: "limit",
      label: "Max results",
      kind: "number",
      placeholder: "20",
      help: "1–50, default 20.",
    },
  ],
  outputs: [
    { key: "results", label: "Results", type: "array" },
    { key: "result", label: "First result", type: "object", children: RESULT_CHILDREN },
    num("count", "Count"),
    str("query", "Query"),
  ],
};
