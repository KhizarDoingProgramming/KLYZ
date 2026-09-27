"use client";

import { create } from "zustand";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { getDefinition } from "@/lib/workflow/registry";
import type {
  KlyzEdgeData,
  KlyzNodeData,
  Workflow,
  WorkflowSummary,
  WorkflowStatus,
} from "@/lib/workflow/types";

export type KlyzFlowNode = Node<KlyzNodeData, string>;
export type KlyzFlowEdge = Edge<KlyzEdgeData>;

interface Snapshot {
  nodes: KlyzFlowNode[];
  edges: KlyzFlowEdge[];
}

interface EditorState {
  workflowId: string | null;
  /** Untouched summary metadata (tags, counters, timestamps) owned by storage. */
  meta: WorkflowSummary | null;
  name: string;
  description: string;
  status: WorkflowStatus;
  nodes: KlyzFlowNode[];
  edges: KlyzFlowEdge[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  past: Snapshot[];
  future: Snapshot[];
  dirty: boolean;
  paletteOpen: boolean;
  paletteQuery: string;
  inspectorOpen: boolean;
  fitRequest: number;
  focusRequest: { nodeId: string; nonce: number } | null;

  load: (workflow: Workflow) => void;
  reset: () => void;

  onNodesChange: (changes: NodeChange<KlyzFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<KlyzFlowEdge>[]) => void;
  onConnect: (connection: Connection) => void;

  select: (nodeId: string | null, edgeId?: string | null) => void;
  addNode: (type: string, position?: { x: number; y: number }) => void;
  duplicateSelection: () => void;
  removeSelection: () => void;
  updateConfig: (nodeId: string, key: string, value: unknown) => void;
  updateRef: (nodeId: string, ref: string) => void;
  updateLabel: (nodeId: string, label: string) => void;
  rename: (name: string) => void;
  markSaved: () => void;
  setStatus: (status: WorkflowStatus) => void;

  undo: () => void;
  redo: () => void;

  setPaletteOpen: (open: boolean) => void;
  setPaletteQuery: (query: string) => void;
  setInspectorOpen: (open: boolean) => void;
  requestFit: () => void;
  focusNode: (nodeId: string) => void;
}

let historyLock = "none";
let idSeed = 0;

function nextId(prefix: string): string {
  idSeed += 1;
  return `${prefix}_${Date.now().toString(36)}${idSeed.toString(36)}`;
}

function uniqueRef(base: string, existing: Set<string>): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "step";
  if (!existing.has(slug)) return slug;
  let index = 2;
  while (existing.has(`${slug}_${index}`)) index += 1;
  return `${slug}_${index}`;
}

export const useEditorStore = create<EditorState>((set, get) => {
  function pushHistory(): void {
    const { nodes, edges, past } = get();
    const next = past.slice(-49);
    set({ past: [...next, { nodes, edges }], future: [], dirty: true });
  }

  return {
    workflowId: null,
    meta: null,
    name: "",
    description: "",
    status: "draft",
    nodes: [],
    edges: [],
    selectedNodeId: null,
    selectedEdgeId: null,
    past: [],
    future: [],
    dirty: false,
    paletteOpen: false,
    paletteQuery: "",
    // Deterministic on server and client. Narrow viewports close it before
    // first paint in `Inspector` (see the layout effect there) so the canvas
    // is what you land on.
    inspectorOpen: true,
    fitRequest: 0,
    focusRequest: null,

    load: (workflow) => {
      historyLock = "none";
      set({
        workflowId: workflow.id,
        meta: workflow,
        name: workflow.name,
        description: workflow.description,
        status: workflow.status,
        nodes: workflow.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          position: node.position,
          data: node.data,
        })),
        edges: workflow.edges.map((edge) => ({
          id: edge.id,
          type: "klyz",
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? edge.data?.branch ?? "out",
          targetHandle: edge.targetHandle ?? "in",
          data: edge.data,
        })),
        selectedNodeId: null,
        selectedEdgeId: null,
        past: [],
        future: [],
        dirty: false,
        fitRequest: 0,
        focusRequest: null,
      });
    },

    reset: () =>
      set({
        workflowId: null,
        meta: null,
        name: "",
        description: "",
        status: "draft",
        nodes: [],
        edges: [],
        selectedNodeId: null,
        selectedEdgeId: null,
        past: [],
        future: [],
        dirty: false,
        fitRequest: 0,
      }),

    onNodesChange: (changes) => {
      const startsDrag = changes.some(
        (change) => change.type === "position" && change.dragging === true,
      );
      if (startsDrag && historyLock !== "drag") {
        historyLock = "drag";
        pushHistory();
      }
      if (!startsDrag) historyLock = "none";
      set({ nodes: applyNodeChanges(changes, get().nodes) });
    },

    onEdgesChange: (changes) => {
      set({ edges: applyEdgeChanges(changes, get().edges) });
    },

    onConnect: (connection) => {
      const { edges } = get();
      const sourceNode = get().nodes.find((n) => n.id === connection.source);
      const definition = sourceNode ? getDefinition(sourceNode.type) : undefined;

      const alreadyExists = edges.some(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target &&
          edge.sourceHandle === connection.sourceHandle,
      );
      if (alreadyExists) return;

      pushHistory();
      const branch =
        definition?.branches && connection.sourceHandle
          ? connection.sourceHandle
          : undefined;

      set({
        edges: addEdge(
          {
            ...connection,
            id: nextId("e"),
            type: "klyz",
            targetHandle: connection.targetHandle ?? "in",
            data: branch ? ({ branch } as KlyzEdgeData) : undefined,
          },
          edges,
        ) as KlyzFlowEdge[],
        dirty: true,
      });
    },

    select: (nodeId, edgeId = null) =>
      set({ selectedNodeId: nodeId, selectedEdgeId: edgeId }),

    addNode: (type, position) => {
      const definition = getDefinition(type);
      if (!definition) return;
      const existing = new Set(
        get().nodes.map((node) => node.data.ref).filter(Boolean),
      );
      pushHistory();

      const nodes = get().nodes;
      const fallback = position ?? {
        x: 320 + ((nodes.length % 3) * 40),
        y: 160 + nodes.length * 60,
      };

      const node: KlyzFlowNode = {
        id: nextId("n"),
        type,
        position: { x: Math.round(fallback.x), y: Math.round(fallback.y) },
        data: {
          ref: uniqueRef(definition.title, existing),
          config: {},
        },
      };

      set({
        nodes: [...nodes, node],
        selectedNodeId: node.id,
        selectedEdgeId: null,
        paletteOpen: false,
        paletteQuery: "",
        dirty: true,
        inspectorOpen: true,
        focusRequest: { nodeId: node.id, nonce: Date.now() },
      });
    },

    duplicateSelection: () => {
      const { nodes, selectedNodeId } = get();
      if (!selectedNodeId) return;
      const source = nodes.find((node) => node.id === selectedNodeId);
      if (!source) return;

      pushHistory();
      const existing = new Set(nodes.map((node) => node.data.ref));
      const copy: KlyzFlowNode = {
        ...source,
        id: nextId("n"),
        position: {
          x: source.position.x + 48,
          y: source.position.y + 48,
        },
        selected: false,
        data: {
          ...source.data,
          ref: uniqueRef(source.data.ref, existing),
        },
      };
      set({
        nodes: [...nodes, copy],
        selectedNodeId: copy.id,
        dirty: true,
      });
    },

    removeSelection: () => {
      const { nodes, edges, selectedNodeId, selectedEdgeId } = get();
      if (!selectedNodeId && !selectedEdgeId) return;
      pushHistory();
      set({
        nodes: selectedNodeId
          ? nodes.filter((node) => node.id !== selectedNodeId)
          : nodes,
        edges: selectedEdgeId
          ? edges.filter((edge) => edge.id !== selectedEdgeId)
          : edges.filter(
              (edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId,
            ),
        selectedNodeId: null,
        selectedEdgeId: null,
        dirty: true,
      });
    },

    updateConfig: (nodeId, key, value) => {
      set({
        nodes: get().nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  config: { ...node.data.config, [key]: value },
                },
              }
            : node,
        ),
        dirty: true,
      });
    },

    updateRef: (nodeId, ref) => {
      set({
        nodes: get().nodes.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, ref } }
            : node,
        ),
        dirty: true,
      });
    },

    updateLabel: (nodeId, label) => {
      set({
        nodes: get().nodes.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, label: label || undefined } }
            : node,
        ),
        dirty: true,
      });
    },

    rename: (name) => set({ name, dirty: true }),

    markSaved: () => set({ dirty: false }),

    setStatus: (status) => set({ status, dirty: true }),

    undo: () => {
      const { past, future, nodes, edges } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({
        past: past.slice(0, -1),
        future: [...future, { nodes, edges }],
        nodes: previous.nodes,
        edges: previous.edges,
        selectedNodeId: null,
        selectedEdgeId: null,
        dirty: true,
      });
    },

    redo: () => {
      const { past, future, nodes, edges } = get();
      const next = future[future.length - 1];
      if (!next) return;
      set({
        future: future.slice(0, -1),
        past: [...past, { nodes, edges }],
        nodes: next.nodes,
        edges: next.edges,
        selectedNodeId: null,
        selectedEdgeId: null,
        dirty: true,
      });
    },

    setPaletteOpen: (open) => set({ paletteOpen: open, paletteQuery: "" }),
    setPaletteQuery: (query) => set({ paletteQuery: query }),
    setInspectorOpen: (open) => set({ inspectorOpen: open }),
    requestFit: () => set({ fitRequest: get().fitRequest + 1 }),
    focusNode: (nodeId) =>
      set({ focusRequest: { nodeId, nonce: Date.now() } }),
  };
});

/** Serialises the live editor graph back into a storable Workflow. */
export function snapshotWorkflow(state: EditorState): Workflow {
  const trigger = state.nodes.find(
    (node) => getDefinition(node.type)?.trigger,
  );
  const base: WorkflowSummary = state.meta ?? {
    id: state.workflowId ?? "wf_draft",
    name: state.name,
    description: state.description,
    status: state.status,
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastExecutedAt: null,
    executionCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    triggerType: trigger?.type ?? "trigger.manual",
    nodeCount: state.nodes.length,
  };

  return {
    ...base,
    id: state.workflowId ?? base.id,
    name: state.name,
    description: state.description,
    status: state.status,
    nodeCount: state.nodes.length,
    triggerType: trigger?.type ?? base.triggerType,
    updatedAt: new Date().toISOString(),
    nodes: state.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: { x: node.position.x, y: node.position.y },
      data: node.data,
    })),
    edges: state.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? undefined,
      targetHandle: edge.targetHandle ?? undefined,
      data: edge.data ?? undefined,
    })),
  };
}

export type { EditorState };

export const selectCanUndo = (state: EditorState): boolean => state.past.length > 0;
export const selectCanRedo = (state: EditorState): boolean => state.future.length > 0;
