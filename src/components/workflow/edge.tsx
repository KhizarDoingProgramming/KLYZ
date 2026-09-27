"use client";

import * as React from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { cn, formatDuration } from "@/lib/utils";
import { EDGE_STROKE, type EdgeVisualState } from "@/lib/status";
import type { KlyzFlowEdge } from "@/stores/editor";
import { useExecutionStore } from "@/stores/execution";

const FLOW_CLASS: Record<EdgeVisualState, string | null> = {
  idle: null,
  active: "kz-edge-flow",
  completed: null,
  failed: "kz-edge-flow",
  skipped: "kz-edge-skipped",
  waiting: "kz-edge-wait",
};

const STROKE_WIDTH: Record<EdgeVisualState, number> = {
  idle: 1.4,
  active: 1.7,
  completed: 1.6,
  failed: 1.7,
  skipped: 1.3,
  waiting: 1.6,
};

export function KlyzEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<KlyzFlowEdge>) {
  const status = useExecutionStore((state) =>
    state.plan ? (state.edgeStates[id] ?? "idle") : "idle",
  );
  const revealed = useExecutionStore((state) => state.revealed);
  const plan = useExecutionStore((state) => state.plan);
  const branch = data?.branch;

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.32,
  });

  const stroke =
    selected && status === "idle" ? "var(--kz-signal)" : EDGE_STROKE[status];
  const flowClass = FLOW_CLASS[status];
  const currentEdge = plan?.edges[revealed - 1];
  const isHandoff =
    plan !== null && currentEdge !== undefined && currentEdge.id === id;
  const handoffMs = plan?.steps[revealed]?.durationMs;

  return (
    <>
      {status === "active" && (
        <path
          d={path}
          fill="none"
          stroke="var(--kz-signal)"
          strokeWidth={7}
          strokeOpacity={0.16}
          className="kz-breathe"
          style={{ pointerEvents: "none" }}
        />
      )}

      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#klyz-arrow-${status})`}
        style={{
          stroke,
          strokeWidth: STROKE_WIDTH[status],
          opacity: status === "skipped" ? 0.7 : 1,
        }}
        className={flowClass ?? undefined}
      />

      {/* the packet that travels down the wire while work is handed off */}
      {status === "active" && flowClass && (
        <path
          d={path}
          fill="none"
          stroke="var(--kz-signal)"
          strokeWidth={3}
          strokeLinecap="round"
          className="kz-edge-packet"
        />
      )}

      {branch && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className="absolute nodrag nopan flex items-center gap-1.5"
          >
            <span
              className={cn(
                "rounded-sm border bg-panel px-1.5 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.1em] transition-colors",
                status === "failed"
                  ? "border-danger/50 text-danger"
                  : status === "active"
                    ? "border-signal/50 text-signal-text"
                    : status === "skipped"
                      ? "border-edge text-subtle"
                      : "border-edge text-muted",
              )}
            >
              {branch}
            </span>
            {isHandoff && handoffMs !== undefined && (
              <span className="kz-num rounded-sm bg-panel px-1.5 py-[2px] text-[9.5px] text-subtle">
                {formatDuration(handoffMs)}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
