"use client";

import * as React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Copy, Trash2 } from "lucide-react";
import { Glyph } from "@/components/icons";
import type { KlyzFlowNode } from "@/stores/editor";
import { getDefinition } from "@/lib/workflow/registry";
import { CATEGORY_LABEL, CATEGORY_STYLE } from "@/lib/workflow/category";
import { summarizeNode } from "@/lib/workflow/summary";
import { useExecutionStore } from "@/stores/execution";
import { useEditorStore } from "@/stores/editor";
import { formatDuration, cn } from "@/lib/utils";
import type { NodeStatus } from "@/lib/workflow/types";

/* Shared with the execution debugger so a node looks the same while it
   is being edited and while it is being inspected after the fact. */
export const STATUS_RING: Record<NodeStatus, string> = {
  idle: "border-line",
  pending: "border-line",
  running: "border-signal/65 shadow-[0_0_0_3px_var(--kz-signal-soft)]",
  completed: "border-ok/45",
  failed: "border-danger/60 shadow-[0_0_0_3px_var(--kz-danger-soft)]",
  skipped: "border-dashed border-strong",
  waiting: "border-info/55 shadow-[0_0_0_3px_var(--kz-info-soft)]",
};

export const STATUS_GLYPH: Partial<Record<NodeStatus, string>> = {
  completed: "circleCheck",
  failed: "alert",
  skipped: "circleMinus",
  waiting: "clock",
};

export const STATUS_CHIP: Record<NodeStatus, string> = {
  idle: "bg-raised text-muted",
  pending: "bg-raised text-muted",
  running: "bg-signal-soft text-signal-text",
  completed: "bg-ok-soft text-ok",
  failed: "bg-danger-soft text-danger",
  skipped: "bg-raised text-idle",
  waiting: "bg-info-soft text-info",
};

function StepElapsed({ since }: { since: number | null }) {
  /* Rides the execution store's ticker instead of opening its own timer. */
  const elapsedMs = useExecutionStore((state) => state.elapsedMs);
  const runStartedAt = useExecutionStore((state) => state.startedAt);

  if (!since || runStartedAt === null) return null;
  return (
    <span className="kz-num text-[10px] leading-none text-signal-text">
      {formatDuration(runStartedAt + elapsedMs - since)}
    </span>
  );
}

export function KlyzNode({ id, type, data, selected }: NodeProps<KlyzFlowNode>) {
  const definition = getDefinition(type);
  const status = useExecutionStore((state) =>
    state.plan ? (state.nodeStates[id] ?? "pending") : "idle",
  );
  const stepStartedAt = useExecutionStore((state) =>
    state.status === "running" ? state.stepStartedAt : null,
  );
  const plan = useExecutionStore((state) => state.plan);
  const removeSelection = useEditorStore((state) => state.removeSelection);
  const duplicateSelection = useEditorStore((state) => state.duplicateSelection);
  const select = useEditorStore((state) => state.select);
  const storeSelected = useEditorStore((state) => state.selectedNodeId === id);

  const duration = plan?.steps.find((step) => step.nodeId === id)?.durationMs;
  const isSelected = selected || storeSelected;

  if (!definition) {
    return (
      <div className="w-[268px] rounded-md border border-danger/60 bg-surface p-3 text-[12px] text-danger">
        Unknown node type <span className="font-mono">{type}</span>
      </div>
    );
  }

  const style = CATEGORY_STYLE[definition.category];
  const lines = summarizeNode(type, data.config);
  const glyph = STATUS_GLYPH[status];
  const showStatus = status !== "idle";

  const branchHandles =
    definition.branches && definition.branches.length > 0
      ? definition.branches
      : null;

  return (
    <div
      className={cn(
        "group/node relative w-[268px] rounded-md border bg-surface transition-[border-color,box-shadow,opacity] duration-standard",
        STATUS_RING[status],
        branchHandles && "pb-6",
        isSelected && "border-signal/70 shadow-[0_0_0_3px_var(--kz-signal-soft)]",
        status === "pending" && !isSelected && "opacity-75",
        status === "skipped" && "opacity-60",
        status === "failed" && "bg-surface",
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        select(id, null);
      }}
    >
      <Handle type="target" position={Position.Top} id="in" />

      {/* header ---------------------------------------------------- */}
      <div className="flex items-start gap-2.5 px-3 pb-2.5 pt-3">
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-edge transition-colors",
            showStatus ? STATUS_CHIP[status] : cn(style.chip, style.text),
          )}
        >
          <Glyph name={definition.icon} className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="kz-display truncate text-[12.5px] font-semibold leading-tight tracking-[-0.005em] text-fg">
              {data.label || definition.title}
            </div>
          </div>
          <p className="mt-1 flex items-center gap-1.5 truncate text-[10.5px] leading-none text-subtle">
            <span className="font-mono uppercase tracking-[0.1em] text-subtle">
              {CATEGORY_LABEL[definition.category]}
            </span>
            <span aria-hidden className="text-disabled">
              ·
            </span>
            <span className="truncate">{definition.summary}</span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {status === "running" && (
            <span className="flex items-center gap-1.5">
              <span className="kz-breathe h-1.5 w-1.5 rounded-full bg-signal" />
              <StepElapsed since={stepStartedAt} />
            </span>
          )}
          {status === "completed" && duration !== undefined && (
            <span className="kz-num text-[10px] leading-none text-ok">
              {formatDuration(duration)}
            </span>
          )}
          {glyph && (
            <span
              aria-hidden
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-sm",
                status === "completed" && "bg-ok-soft text-ok",
                status === "failed" && "bg-danger-soft text-danger",
                status === "skipped" && "bg-raised text-idle",
                status === "waiting" && "bg-info-soft text-info",
              )}
            >
              <Glyph
                name={glyph}
                className={cn(
                  "h-3.5 w-3.5",
                  status === "waiting" && "animate-pulse",
                )}
              />
            </span>
          )}

          <span className="nodrag flex items-center opacity-0 transition-opacity duration-micro group-hover/node:opacity-100 group-focus-within/node:opacity-100">
            <button
              type="button"
              aria-label={`Duplicate ${definition.title}`}
              onClick={(event) => {
                event.stopPropagation();
                select(id, null);
                duplicateSelection();
              }}
              className="flex h-5 w-5 items-center justify-center rounded-sm text-subtle transition-colors hover:bg-raised hover:text-fg"
            >
              <Copy className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label={`Delete ${definition.title}`}
              onClick={(event) => {
                event.stopPropagation();
                select(id, null);
                removeSelection();
              }}
              className="flex h-5 w-5 items-center justify-center rounded-sm text-subtle transition-colors hover:bg-danger-soft hover:text-danger"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </span>
        </div>
      </div>

      {/* configuration summary ------------------------------------- */}
      {lines.length > 0 && (
        <dl className="flex flex-col gap-1 border-t border-hairline px-3 py-2">
          {lines.map((line) => (
            <div key={line.label} className="flex items-baseline gap-3">
              <dt className="w-[74px] shrink-0 truncate text-[10.5px] text-subtle">
                {line.label}
              </dt>
              <dd
                className={cn(
                  "min-w-0 flex-1 truncate text-[11px] text-muted",
                  line.mono && "font-mono text-[10.5px]",
                )}
              >
                {line.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* running indicator along the top edge */}
      {status === "running" && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-[2px] overflow-hidden rounded-t-[2px]"
        >
          <span className="kz-breathe block h-full w-full bg-signal" />
        </span>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        id={branchHandles ? branchHandles[0] : "out"}
        style={
          branchHandles
            ? { left: `${100 / (branchHandles.length * 2)}%` }
            : undefined
        }
      />

      {branchHandles &&
        branchHandles.slice(1).map((branch, index) => (
          <Handle
            key={branch}
            type="source"
            position={Position.Bottom}
            id={branch}
            style={{
              left: `${(100 / (branchHandles.length * 2)) * (index * 2 + 3)}%`,
            }}
          />
        ))}

      {branchHandles && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-1.5 h-4"
        >
          {branchHandles.map((branch, index) => (
            <span
              key={branch}
              style={{
                left: `${(100 / (branchHandles.length * 2)) * (index * 2 + 1)}%`,
              }}
              className="absolute -translate-x-1/2 whitespace-nowrap rounded-sm border border-edge bg-panel px-1 py-[1px] font-mono text-[9px] uppercase tracking-[0.08em] text-subtle"
            >
              {branch}
            </span>
          ))}
        </span>
      )}

      <span className="sr-only">
        {definition.title}. {definition.description}
        {showStatus ? ` Status: ${status}.` : ""}
      </span>
    </div>
  );
}
