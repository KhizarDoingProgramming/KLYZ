"use client";

import * as React from "react";
import { ExecutionCanvas } from "@/components/execution/execution-canvas";
import type { StepVisualState } from "@/lib/execution/debugger";
import type { EdgeStatus, Workflow } from "@/lib/workflow/types";

/**
 * Read-only graph preview for a plan under review.
 *
 * Reuses the debugger canvas — same node language, same summaries — but
 * with every node in its idle state and no steps behind it: this graph
 * has never run, and the review UI must not imply that it has.
 */

const IDLE_NODE_STATES: Record<string, StepVisualState> = {};
const IDLE_EDGE_STATES: Record<string, EdgeStatus> = {};
const NO_STEPS: never[] = [];

export function PlanCanvas({
  workflow,
  selectedNodeId,
  onSelect,
  focusNodeId,
}: {
  workflow: Workflow;
  selectedNodeId: string | null;
  onSelect: (nodeId: string | null) => void;
  focusNodeId?: string | null;
}) {
  const definition = React.useMemo(
    () => ({ nodes: workflow.nodes, edges: workflow.edges }),
    [workflow],
  );

  return (
    <ExecutionCanvas
      definition={definition}
      nodeStates={IDLE_NODE_STATES}
      edgeStates={IDLE_EDGE_STATES}
      steps={NO_STEPS}
      selectedNodeId={selectedNodeId}
      onSelect={onSelect}
      {...(focusNodeId === undefined ? {} : { focusNodeId })}
    />
  );
}
