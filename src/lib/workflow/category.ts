import type { NodeCategory } from "./types";

export const CATEGORY_LABEL: Record<NodeCategory, string> = {
  trigger: "Trigger",
  action: "Action",
  logic: "Logic",
  ai: "AI",
  data: "Data",
  utility: "Utility",
};

/** Utility classes per category — the only place category colour is decided. */
export const CATEGORY_STYLE: Record<
  NodeCategory,
  { text: string; chip: string; border: string; dot: string }
> = {
  trigger: {
    text: "text-cat-trigger",
    chip: "bg-cat-trigger/12",
    border: "border-cat-trigger/35",
    dot: "bg-cat-trigger",
  },
  action: {
    text: "text-cat-action",
    chip: "bg-cat-action/12",
    border: "border-cat-action/35",
    dot: "bg-cat-action",
  },
  logic: {
    text: "text-cat-logic",
    chip: "bg-cat-logic/12",
    border: "border-cat-logic/35",
    dot: "bg-cat-logic",
  },
  ai: {
    text: "text-cat-ai",
    chip: "bg-cat-ai/12",
    border: "border-cat-ai/35",
    dot: "bg-cat-ai",
  },
  data: {
    text: "text-cat-data",
    chip: "bg-cat-data/12",
    border: "border-cat-data/35",
    dot: "bg-cat-data",
  },
  utility: {
    text: "text-cat-utility",
    chip: "bg-cat-utility/12",
    border: "border-cat-utility/35",
    dot: "bg-cat-utility",
  },
};
