"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Clock, Layers, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { Segmented } from "@/components/ui/field";
import { Glyph } from "@/components/icons";
import { openImportDialog } from "@/components/workflow/import-dialog";
import {
  createWorkflowFromTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
  type TemplateSummary,
} from "@/lib/templates/api";
import { WorkflowApiError } from "@/lib/workflows/api";
import { getDefinition } from "@/lib/workflow/registry";

const CATEGORIES = [
  { value: "all", label: "All" },
  { value: "general", label: "General" },
  { value: "notifications", label: "Notifications" },
  { value: "data", label: "Data" },
  { value: "ai", label: "AI" },
  { value: "integrations", label: "Integrations" },
];

/**
 * The workspace's template library.
 *
 * A template is a portable workflow with a name and a category — the
 * same document an export produces — so using one is exactly the
 * import path: the draft is created unpublished, credentials are mapped
 * where a matching connection exists, and anything left over is handed
 * to the editor as a requirement.
 */
export default function TemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = React.useState<TemplateSummary[]>([]);
  const [ready, setReady] = React.useState(false);
  const [category, setCategory] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    listTemplates()
      .then((next) => setTemplates(next))
      .catch((cause: unknown) =>
        setMessage(cause instanceof Error ? cause.message : "Could not load templates."),
      )
      .finally(() => setReady(true));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return templates.filter((template) => {
      if (category !== "all" && template.category !== category) return false;
      if (!needle) return true;
      return (
        template.name.toLowerCase().includes(needle) ||
        template.description.toLowerCase().includes(needle) ||
        template.integrations.some((id) => id.includes(needle))
      );
    });
  }, [templates, category, query]);

  const use = React.useCallback(
    async (template: TemplateSummary) => {
      setBusyId(template.id);
      setMessage(null);
      try {
        const created = await createWorkflowFromTemplate(template.id);
        if (created.workflow) router.push(`/workflows/${created.workflow.id}`);
      } catch (cause) {
        setMessage(
          cause instanceof WorkflowApiError
            ? cause.message
            : "That template could not be used.",
        );
      } finally {
        setBusyId(null);
      }
    },
    [router],
  );

  const rename = React.useCallback(async (template: TemplateSummary) => {
    const name = window.prompt("Template name", template.name);
    if (!name || name.trim() === template.name) return;
    try {
      const updated = await updateTemplate(template.id, { name: name.trim() });
      setTemplates((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not rename that template.");
    }
  }, []);

  const remove = React.useCallback(async (template: TemplateSummary) => {
    if (!window.confirm(`Delete “${template.name}”? Workflows made from it are unaffected.`)) {
      return;
    }
    try {
      await deleteTemplate(template.id);
      setTemplates((current) => current.filter((entry) => entry.id !== template.id));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not delete that template.");
    }
  }, []);

  const filtersActive = query.trim().length > 0 || category !== "all";

  return (
    <div className="h-full overflow-y-auto">
      <div className="kz-frame py-8 lg:py-12">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="kz-eyebrow mb-2.5">Library</p>
            <h1 className="text-page text-fg">Templates</h1>
            <p className="mt-1.5 text-sm text-muted">
              {templates.length} blueprints ·{" "}
              {templates.filter((entry) => entry.system).length} built in
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={openImportDialog}>
              <Upload className="h-4 w-4" />
              Import
            </Button>
            <Button variant="primary" onClick={() => router.push("/workflows")}>
              <Plus className="h-4 w-4" />
              New workflow
            </Button>
          </div>
        </header>

        {message ? (
          <p
            role="status"
            className="mt-5 rounded-md border border-line bg-raised px-3 py-2 text-[12.5px] leading-relaxed text-danger"
          >
            {message}
          </p>
        ) : null}

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1 sm:max-w-[320px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search templates…"
              aria-label="Search templates"
              className="h-8 w-full rounded-md border border-line bg-surface pl-8 pr-8 text-[13px] text-fg outline-none transition-colors placeholder:text-subtle focus:border-signal/60 focus:ring-2 focus:ring-signal/20"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle hover:text-fg"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>

          <Segmented
            ariaLabel="Filter by category"
            stretch={false}
            value={category}
            onChange={setCategory}
            options={CATEGORIES}
          />
        </div>

        <div className="mt-6 border-t border-line">
          {!ready ? (
            <div className="grid gap-4 py-6 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="rounded-lg border border-line p-4">
                  <div className="h-3.5 w-32 animate-pulse rounded bg-raised" />
                  <div className="mt-3 h-2.5 w-full animate-pulse rounded bg-raised" />
                  <div className="mt-2 h-2.5 w-2/3 animate-pulse rounded bg-raised" />
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            filtersActive ? (
              <EmptyState
                title="No templates match"
                description="Try another category or clear the search to see the whole library."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQuery("");
                      setCategory("all");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No templates yet"
                description="Open a workflow and choose Save as template — it will appear here for the whole workspace."
                action={
                  <Button variant="primary" onClick={() => router.push("/workflows")}>
                    <Plus className="h-4 w-4" />
                    New workflow
                  </Button>
                }
              />
            )
          ) : (
            <ul className="grid gap-4 py-6 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  busy={busyId === template.id}
                  onUse={() => void use(template)}
                  onRename={() => void rename(template)}
                  onRemove={() => void remove(template)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  busy,
  onUse,
  onRename,
  onRemove,
}: {
  template: TemplateSummary;
  busy: boolean;
  onUse: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const trigger = getDefinition(template.triggerType);
  const items: MenuItem[] = [];
  if (!template.system) {
    items.push({ id: "rename", label: "Rename", onSelect: onRename });
    items.push({
      id: "delete",
      label: "Delete template",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      danger: true,
      onSelect: onRemove,
    });
  }

  return (
    <li className="flex flex-col rounded-lg border border-line bg-surface/60 p-4 transition-colors hover:border-strong">
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-raised">
          <Glyph
            name={template.system ? "layers" : (trigger?.icon ?? "layers")}
            className="h-4 w-4 text-muted"
          />
        </span>
        <span className="flex items-center gap-1.5">
          <span className="kz-eyebrow rounded-full border border-line bg-raised px-2 py-0.5">
            {template.system ? "Built in" : template.category}
          </span>
          {items.length > 0 ? (
            <Menu
              label={`Actions for ${template.name}`}
              items={items}
              trigger={(props) => (
                <button
                  {...props}
                  type="button"
                  aria-label={`Actions for ${template.name}`}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-subtle transition-colors hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
                >
                  <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
                    <circle cx="8" cy="3.5" r="1.35" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.35" fill="currentColor" />
                    <circle cx="8" cy="12.5" r="1.35" fill="currentColor" />
                  </svg>
                </button>
              )}
            />
          ) : null}
        </span>
      </div>

      <h2 className="kz-display mt-3 text-[14.5px] font-semibold tracking-[-0.01em] text-fg">
        {template.name}
      </h2>
      <p className="mt-1 min-h-[2.4em] text-[12.5px] leading-snug text-subtle">
        {template.description || "No description yet."}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-subtle">
        <span className="inline-flex items-center gap-1">
          <Layers className="h-3.5 w-3.5" />
          {template.nodeCount} steps
        </span>
        {template.requiredCredentials.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-warn">
            <Clock className="h-3.5 w-3.5" />
            needs a connection
          </span>
        ) : null}
      </div>

      {template.integrations.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {template.integrations.slice(0, 4).map((id) => (
            <span
              key={id}
              className="rounded-full border border-line bg-raised px-2 py-0.5 text-[10.5px] text-muted"
            >
              {id}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-hairline pt-3">
        <span className="kz-eyebrow">
          {template.requiredCredentials.length > 0
            ? `${template.requiredCredentials.length} to connect`
            : "Ready to use"}
        </span>
        <Button variant="secondary" size="sm" onClick={onUse} disabled={busy}>
          {busy ? "Creating…" : "Use"}
        </Button>
      </div>
    </li>
  );
}
