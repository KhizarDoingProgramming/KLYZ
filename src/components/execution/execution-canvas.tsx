"use client";

import * as React from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionLineType,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
  type EdgeTypes,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { Glyph } from "@/components/icons";
import { EdgeMarkers } from "@/components/workflow/canvas";
import { STATUS_CHIP, STATUS_GLYPH, STATUS_RING } from "@/components/workflow/node";
import { NODE_DEFINITIONS, getDefinition } from "@/lib/workflow/registry";
import { CATEGORY_LABEL, CATEGORY_STYLE } from "@/lib/workflow/category";
import { summarizeNode } from "@/lib/workflow/summary";
import { nodeStatusOf, stepVisualState, type StepVisualState } from "@/lib/execution/debugger";
import { EDGE_STROKE, type EdgeVisualState } from "@/lib/status";
import { formatDuration, cn } from "@/lib/utils";
import type { EdgeStatus, NodeStatus, Workflow } from "@/lib/workflow/types";
import type { ExecutionStepView } from "@/lib/execution/types";
import type { KlyzFlowEdge, KlyzFlowNode } from "@/stores/editor";

/**
 * Read-only execution canvas.
 *
 * The same graph, node language and status vocabulary as the editor —
 * but nothing here writes. State arrives as props through a context, so
 * opening a run can never mutate an open workflow (and the two never
 * share a store).
 */

interface DebugCanvasState {
  nodeStates: Record<string, StepVisualState>;
  edgeStates: Record<string, EdgeStatus>;
  stepsByNode: Map<string, ExecutionStepView>;
  selectedNodeId: string | null;
  onSelect: (nodeId: string | null) => void;
}

const DebugContext = React.createContext<DebugCanvasState | null>(null);

function useDebug(): DebugCanvasState {
  const value = React.useContext(DebugContext);
  if (!value) throw new Error("ExecutionCanvas state is missing");
  return value;
}

/* ------------------------------------------------------------------ */
/* Node                                                                */
/* ------------------------------------------------------------------ */

function DebugNode({ id, type, data, selected }: NodeProps<KlyzFlowNode>) {
  const { nodeStates, stepsByNode, selectedNodeId, onSelect } = useDebug();
  const definition = getDefinition(type);
  const state = nodeStates[id] ?? "pending";
  const status: NodeStatus = nodeStatusOf(state);
  const step = stepsByNode.get(id);
  const isSelected = selected || selectedNodeId === id;

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
  const showStatus = state !== "pending" && state !== "idle";
  const branchHandles =
    definition.branches && definition.branches.length > 0 ? definition.branches : null;

  return (
    <div
      className={cn(
        "group relative w-[268px] cursor-pointer rounded-md border bg-surface transition-[border-color,box-shadow,opacity] duration-standard",
        STATUS_RING[status],
        branchHandles && "pb-6",
        isSelected && "border-signal/70 shadow-[0_0_0_3px_var(--kz-signal-soft)]",
        state === "pending" && "opacity-75",
        state === "skipped" && "opacity-60",
      )}
      onClick={() => onSelect(id)}
    >
      <Handle type="target" position={Position.Top} id="in" />

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
          <div className="kz-display truncate text-[12.5px] font-semibold leading-tight tracking-[-0.005em] text-fg">
            {data.label || definition.title}
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

        <div className="flex shrink-0 flex-col items-end gap-1">
          {state === "running" && (
            <span className="flex items-center gap-1.5">
              <span className="kz-breathe h-1.5 w-1.5 rounded-full bg-signal" />
              <span className="kz-num text-[10px] leading-none text-signal-text">
                {step ? formatDuration(step.durationMs) : "…"}
              </span>
            </span>
          )}
          {state === "retrying" && (
            <span className="kz-num rounded-sm bg-warn-soft px-1.5 py-[1px] text-[9.5px] text-warn">
              attempt {(step?.attempt ?? 1) + 1}
            </span>
          )}
          {state === "waiting" && (
            <span className="kz-num rounded-sm bg-info-soft px-1.5 py-[1px] text-[9.5px] text-info">
              waiting
            </span>
          )}
          {state === "completed" && step && (
            <span className="kz-num text-[10px] leading-none text-ok">
              {formatDuration(step.durationMs)}
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
                className={cn("h-3.5 w-3.5", status === "waiting" && "animate-pulse")}
              />
            </span>
          )}
        </div>
      </div>

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

      {state === "running" && (
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
        style={branchHandles ? { left: `${100 / (branchHandles.length * 2)}%` } : undefined}
      />
      {branchHandles &&
        branchHandles.slice(1).map((branch, index) => (
          <Handle
            key={branch}
            type="source"
            position={Position.Bottom}
            id={branch}
            style={{ left: `${(100 / (branchHandles.length * 2)) * (index * 2 + 3)}%` }}
          />
        ))}

      {branchHandles && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-1.5 h-4">
          {branchHandles.map((branch, index) => (
            <span
              key={branch}
              style={{ left: `${(100 / (branchHandles.length * 2)) * (index * 2 + 1)}%` }}
              className="absolute -translate-x-1/2 whitespace-nowrap rounded-sm border border-edge bg-panel px-1 py-[1px] font-mono text-[9px] uppercase tracking-[0.08em] text-subtle"
            >
              {branch}
            </span>
          ))}
        </span>
      )}

      <span className="sr-only">
        {definition.title}. Status: {stepVisualState(step)}.
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Edge                                                                */
/* ------------------------------------------------------------------ */

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

function DebugEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<KlyzFlowEdge>) {
  const { edgeStates } = useDebug();
  const status = (edgeStates[id] ?? "idle") as EdgeVisualState;
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

  const flowClass = FLOW_CLASS[status];

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
          stroke: EDGE_STROKE[status],
          strokeWidth: STROKE_WIDTH[status],
          opacity: status === "skipped" ? 0.7 : 1,
        }}
        className={flowClass ?? undefined}
      />

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
            className="absolute nodrag nopan"
          >
            <span
              className={cn(
                "rounded-sm border bg-panel px-1.5 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.1em]",
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
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Canvas                                                               */
/* ------------------------------------------------------------------ */

const nodeTypes = Object.fromEntries(
  Object.keys(NODE_DEFINITIONS).map((type) => [type, DebugNode]),
) as NodeTypes;

const edgeTypes: EdgeTypes = { klyz: DebugEdge };

const STATUS_CLASS: Record<NodeStatus, string> = {
  idle: "",
  pending: "",
  running: "kz-mm-running",
  completed: "kz-mm-ok",
  failed: "kz-mm-fail",
  skipped: "kz-mm-skip",
  waiting: "kz-mm-wait",
};

function toFlowGraph(definition: {
  nodes: Workflow["nodes"];
  edges: Workflow["edges"];
}): { nodes: KlyzFlowNode[]; edges: KlyzFlowEdge[] } {
  const nodes: KlyzFlowNode[] = definition.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    data: node.data,
  }));
  const edges: KlyzFlowEdge[] = definition.edges.map((edge) => ({
    id: edge.id,
    type: "klyz",
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? edge.data?.branch ?? "out",
    targetHandle: edge.targetHandle ?? "in",
    data: edge.data,
  }));
  return { nodes, edges };
}

function CanvasControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <div className="absolute bottom-4 left-4 z-10 flex items-center gap-px overflow-hidden rounded-sm border border-line bg-panel/85 backdrop-blur">
      <button
        type="button"
        aria-label="Zoom out"
        onClick={() => zoomOut({ duration: 140 })}
        className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-raised hover:text-fg"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        onClick={() => zoomIn({ duration: 140 })}
        className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-raised hover:text-fg"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <span className="mx-1 h-4 w-px bg-edge" />
      <button
        type="button"
        aria-label="Fit run to view"
        onClick={() => fitView({ padding: 0.2, duration: 360 })}
        className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-raised hover:text-fg"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Surface({
  definition,
  state,
  focusNodeId,
}: {
  definition: { nodes: Workflow["nodes"]; edges: Workflow["edges"] };
  state: DebugCanvasState;
  focusNodeId: string | null;
}) {
  const { nodes, edges } = React.useMemo(() => toFlowGraph(definition), [definition]);
  const { fitView, setCenter, getZoom } = useReactFlow();

  React.useEffect(() => {
    fitView({ padding: 0.2, duration: 360 });
  }, [fitView, definition]);

  React.useEffect(() => {
    if (!focusNodeId) return;
    const node = definition.nodes.find((item) => item.id === focusNodeId);
    if (!node) return;
    setCenter(node.position.x + 134, node.position.y + 72, {
      zoom: Math.max(getZoom(), 0.85),
      duration: 360,
    });
  }, [focusNodeId, definition, setCenter, getZoom]);

  return (
    <div className="relative h-full w-full bg-canvas">
      <EdgeMarkers />
      <ReactFlow<KlyzFlowNode, KlyzFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: "klyz" }}
        connectionLineType={ConnectionLineType.Bezier}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
        minZoom={0.18}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        zoomOnDoubleClick={false}
        onNodeClick={(_, node) => state.onSelect(node.id)}
        onPaneClick={() => state.onSelect(null)}
        proOptions={{ hideAttribution: true }}
        aria-label="Execution canvas"
      >
        <Background
          id="kz-canvas-dots"
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          color="var(--kz-line)"
        />
        <Background
          id="kz-canvas-lines"
          variant={BackgroundVariant.Lines}
          gap={96}
          size={1}
          color="var(--kz-grid-line)"
        />
        <CanvasControls />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeBorderRadius={3}
          nodeStrokeWidth={0}
          bgColor="transparent"
          className="klyz-minimap"
          nodeClassName={(node) => {
            const stepState = state.nodeStates[node.id] ?? "pending";
            return STATUS_CLASS[nodeStatusOf(stepState)] || "kz-mm-idle";
          }}
          ariaLabel="Run overview map"
        />
      </ReactFlow>
    </div>
  );
}

export function ExecutionCanvas({
  definition,
  nodeStates,
  edgeStates,
  steps,
  selectedNodeId,
  onSelect,
  focusNodeId,
}: {
  definition: { nodes: Workflow["nodes"]; edges: Workflow["edges"] };
  nodeStates: Record<string, StepVisualState>;
  edgeStates: Record<string, EdgeStatus>;
  steps: ExecutionStepView[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string | null) => void;
  focusNodeId?: string | null;
}) {
  const stepsByNode = React.useMemo(
    () => new Map(steps.map((step) => [step.nodeId, step])),
    [steps],
  );

  const state = React.useMemo<DebugCanvasState>(
    () => ({ nodeStates, edgeStates, stepsByNode, selectedNodeId, onSelect }),
    [nodeStates, edgeStates, stepsByNode, selectedNodeId, onSelect],
  );

  if (definition.nodes.length === 0) return null;

  return (
    <DebugContext.Provider value={state}>
      <ReactFlowProvider>
        <Surface definition={definition} state={state} focusNodeId={focusNodeId ?? null} />
      </ReactFlowProvider>
    </DebugContext.Provider>
  );
}
