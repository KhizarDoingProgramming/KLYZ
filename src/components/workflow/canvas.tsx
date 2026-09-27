"use client";

import * as React from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KlyzNode } from "./node";
import { KlyzEdge } from "./edge";
import { useEditorStore, type KlyzFlowEdge, type KlyzFlowNode } from "@/stores/editor";
import { useExecutionStore } from "@/stores/execution";
import { NODE_DEFINITIONS } from "@/lib/workflow/registry";
import type { NodeStatus } from "@/lib/workflow/types";

/**
 * React Flow resolves components by `node.type`, and in KLYZ `node.type` *is*
 * the registry type (`trigger.github`). One component, one map, no branching.
 */
const nodeTypes = Object.fromEntries(
  Object.keys(NODE_DEFINITIONS).map((type) => [type, KlyzNode]),
) as NodeTypes;

const edgeTypes: EdgeTypes = { klyz: KlyzEdge };

const STATUS_CLASS: Record<NodeStatus, string> = {
  idle: "",
  pending: "",
  running: "kz-mm-running",
  completed: "kz-mm-ok",
  failed: "kz-mm-fail",
  skipped: "kz-mm-skip",
  waiting: "kz-mm-wait",
};

/** Arrowheads shared by the editor canvas and the execution debugger. */
export const EdgeMarkers = React.memo(function EdgeMarkers() {
  return (
    <svg
      aria-hidden
      focusable="false"
      width="0"
      height="0"
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
    >
      <defs>
        <marker
          id="klyz-arrow-idle"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" style={{ fill: "var(--kz-strong)" }} />
        </marker>
        <marker
          id="klyz-arrow-active"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" style={{ fill: "var(--kz-signal)" }} />
        </marker>
        <marker
          id="klyz-arrow-completed"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" style={{ fill: "var(--kz-ok)" }} />
        </marker>
        <marker
          id="klyz-arrow-failed"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" style={{ fill: "var(--kz-danger)" }} />
        </marker>
        <marker
          id="klyz-arrow-waiting"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" style={{ fill: "var(--kz-info)" }} />
        </marker>
        <marker
          id="klyz-arrow-skipped"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" style={{ fill: "var(--kz-idle)" }} />
        </marker>
      </defs>
    </svg>
  );
});

function CanvasControls({ showMini, onToggleMini }: { showMini: boolean; onToggleMini: () => void }) {
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
        aria-label="Fit workflow to view"
        onClick={() => fitView({ padding: 0.2, duration: 360 })}
        className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-raised hover:text-fg"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
      <span className="mx-1 h-4 w-px bg-edge" />
      <button
        type="button"
        aria-pressed={showMini}
        aria-label="Toggle minimap"
        onClick={onToggleMini}
        className={`flex h-8 items-center gap-1.5 px-2.5 text-[10.5px] font-medium transition-colors hover:bg-raised ${
          showMini ? "text-signal-text" : "text-muted hover:text-fg"
        }`}
      >
        Map
      </button>
    </div>
  );
}

export function WorkflowCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasSurface />
    </ReactFlowProvider>
  );
}

function CanvasSurface() {
  const nodes = useEditorStore((state) => state.nodes);
  const edges = useEditorStore((state) => state.edges);
  const onNodesChange = useEditorStore((state) => state.onNodesChange);
  const onEdgesChange = useEditorStore((state) => state.onEdgesChange);
  const onConnect = useEditorStore((state) => state.onConnect);
  const select = useEditorStore((state) => state.select);
  const fitRequest = useEditorStore((state) => state.fitRequest);
  const focusRequest = useEditorStore((state) => state.focusRequest);
  const setPaletteOpen = useEditorStore((state) => state.setPaletteOpen);

  const nodeStates = useExecutionStore((state) => state.nodeStates);
  const runActive = useExecutionStore((state) => state.plan !== null);

  const [showMini, setShowMini] = React.useState(true);
  const { fitView, setCenter, getZoom, screenToFlowPosition } = useReactFlow();

  React.useEffect(() => {
    if (fitRequest > 0) {
      fitView({ padding: 0.2, duration: 360 });
    }
  }, [fitRequest, fitView]);

  React.useEffect(() => {
    if (!focusRequest) return;
    const node = useEditorStore
      .getState()
      .nodes.find((n) => n.id === focusRequest.nodeId);
    if (!node) return;
    setCenter(node.position.x + 134, node.position.y + 72, {
      zoom: Math.max(getZoom(), 0.85),
      duration: 360,
    });
  }, [focusRequest, setCenter, getZoom]);

  const handleDrop = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/klyz-node");
      if (!type) return;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      useEditorStore.getState().addNode(type, position);
    },
    [screenToFlowPosition],
  );

  return (
    <div className="relative h-full w-full bg-canvas">
      <EdgeMarkers />

      <ReactFlow<KlyzFlowNode, KlyzFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        defaultEdgeOptions={{ type: "klyz" }}
        connectionLineType={ConnectionLineType.Bezier}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
        minZoom={0.18}
        maxZoom={1.8}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        onNodeClick={(_, node) => select(node.id, null)}
        onEdgeClick={(_, edge) => select(null, edge.id)}
        onPaneClick={() => select(null, null)}
        onNodeDoubleClick={(_, node) => {
          select(node.id, null);
          useEditorStore.getState().setInspectorOpen(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={handleDrop}
        proOptions={{ hideAttribution: true }}
        aria-label="Workflow canvas"
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

        <CanvasControls showMini={showMini} onToggleMini={() => setShowMini((v) => !v)} />

        {showMini && (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            nodeBorderRadius={3}
            nodeStrokeWidth={0}
            bgColor="transparent"
            className="klyz-minimap"
            nodeClassName={(node) => {
              if (!runActive) return "kz-mm-idle";
              return STATUS_CLASS[nodeStates[node.id] ?? "idle"] || "kz-mm-idle";
            }}
            ariaLabel="Workflow overview map"
          />
        )}

        {nodes.length === 0 && <EmptyCanvas onAdd={() => setPaletteOpen(true)} />}
      </ReactFlow>
    </div>
  );
}

function EmptyCanvas({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="pointer-events-auto max-w-[340px] rounded-lg border border-dashed border-line bg-app/70 px-7 py-7 text-center backdrop-blur-sm">
        <span className="mx-auto mb-4 flex h-9 w-9 items-center justify-center rounded-sm border border-edge bg-raised">
          <span className="h-2.5 w-2.5 rounded-full bg-signal" />
        </span>
        <h2 className="kz-display text-[14px] font-semibold text-fg">An empty canvas</h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-subtle">
          Drop a node from the palette, or press{" "}
          <kbd className="kz-eyebrow rounded-sm border border-edge bg-raised px-1.5 py-0.5 text-[9.5px] text-muted">
            Tab
          </kbd>{" "}
          to search every building block.
        </p>
        <Button
          variant="primary"
          onClick={onAdd}
          className="mt-4"
        >
          Add your first node
        </Button>
      </div>
    </div>
  );
}
