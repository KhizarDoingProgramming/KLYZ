"use client";

import * as React from "react";
import { Minus, Plus, Pencil } from "lucide-react";
import type { WorkflowDiff } from "@/lib/ai/diff";
import { getDefinition } from "@/lib/workflow/registry";
import { cn } from "@/lib/utils";

/**
 * What a plan does to the workflow it will replace.
 *
 * Rendered as a plain editorial diff — added / removed / reconfigured —
 * so nobody approves a graph they cannot account for.
 */

function NodeEntry({
  entry,
  icon,
  tone,
}: {
  entry: WorkflowDiff["added"][number];
  icon: React.ReactNode;
  tone: string;
}) {
  const definition = getDefinition(entry.type);
  return (
    <li className={cn("flex gap-2 border-l-2 pl-2.5", tone)}>
      <span className={cn("mt-0.5 shrink-0", tone.replace("border-l-", "text-"))}>{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-medium text-fg">{entry.label}</span>
        <span className="kz-eyebrow block text-[9.5px] text-muted">
          {definition?.title ?? entry.type}
        </span>
        {entry.changes.length > 0 && (
          <ul className="mt-1 flex flex-col gap-0.5">
            {entry.changes.map((change) => (
              <li key={change.key} className="font-mono text-[10.5px] leading-relaxed text-subtle">
                <span className="text-muted">{change.key}</span>{" "}
                {change.before && (
                  <>
                    <span className="text-danger line-through">{change.before}</span>{" "}
                    <span className="text-muted">→</span>{" "}
                  </>
                )}
                <span className="text-fg">{change.after || "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </span>
    </li>
  );
}
export function PlanDiff({ diff, baselineName }: { diff: WorkflowDiff; baselineName?: string }) {
  if (diff.empty) return null;

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="kz-eyebrow text-[9.5px] text-muted">
          Changes{baselineName ? ` to ${baselineName}` : ""}
        </h3>
        <span className="kz-eyebrow text-[9.5px] text-muted">
          {diff.unchangedCount} unchanged
        </span>
      </header>

      {diff.added.length === 0 &&
      diff.removed.length === 0 &&
      diff.changed.length === 0 &&
      diff.edgesAdded.length === 0 &&
      diff.edgesRemoved.length === 0 ? (
        <p className="text-[12px] text-subtle">No changes — the plan matches the current graph.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {diff.added.length > 0 && (
            <div>
              <p className="kz-eyebrow mb-1.5 text-[9.5px] text-ok">
                + {diff.added.length} added
              </p>
              <ul className="flex flex-col gap-2">
                {diff.added.map((entry) => (
                  <NodeEntry key={entry.id} entry={entry} tone="border-l-ok" icon={<Plus className="h-3 w-3" />} />
                ))}
              </ul>
            </div>
          )}

          {diff.removed.length > 0 && (
            <div>
              <p className="kz-eyebrow mb-1.5 text-[9.5px] text-danger">
                − {diff.removed.length} removed
              </p>
              <ul className="flex flex-col gap-2">
                {diff.removed.map((entry) => (
                  <NodeEntry key={entry.id} entry={entry} tone="border-l-danger" icon={<Minus className="h-3 w-3" />} />
                ))}
              </ul>
            </div>
          )}

          {diff.changed.length > 0 && (
            <div>
              <p className="kz-eyebrow mb-1.5 text-[9.5px] text-warn">
                ~ {diff.changed.length} reconfigured
              </p>
              <ul className="flex flex-col gap-2">
                {diff.changed.map((entry) => (
                  <NodeEntry key={entry.id} entry={entry} tone="border-l-warn" icon={<Pencil className="h-3 w-3" />} />
                ))}
              </ul>
            </div>
          )}

          {(diff.edgesAdded.length > 0 || diff.edgesRemoved.length > 0) && (
            <p className="font-mono text-[10.5px] text-muted">
              +{diff.edgesAdded.length} / −{diff.edgesRemoved.length} connections
            </p>
          )}
        </div>
      )}
    </section>
  );
}
