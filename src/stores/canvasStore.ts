import { create } from 'zustand';
import {
  Connection,
  EdgeChange,
  NodeChange,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
} from '@xyflow/react';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_NODE_WIDTH,
  type ActiveToolDialog,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  type NodeToolType,
  type StoryboardExportOptions,
  type StoryboardFrameItem,
  isStoryboardSplitNode,
} from '@/features/canvas/domain/canvasNodes';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';

export type {
  ActiveToolDialog,
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  NodeToolType,
  StoryboardFrameItem,
};

export interface CanvasHistorySnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface CanvasHistoryState {
  past: CanvasHistorySnapshot[];
  future: CanvasHistorySnapshot[];
}

const MAX_HISTORY_STEPS = 50;

interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeId: string | null;
  activeToolDialog: ActiveToolDialog | null;
  history: CanvasHistoryState;
  dragHistorySnapshot: CanvasHistorySnapshot | null;

  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<CanvasEdge>[]) => void;
  onConnect: (connection: Connection) => void;

  setCanvasData: (nodes: CanvasNode[], edges: CanvasEdge[], history?: CanvasHistoryState) => void;
  addNode: (
    type: CanvasNodeType,
    position: { x: number; y: number },
    data?: Partial<CanvasNodeData>
  ) => string;
  addEdge: (source: string, target: string) => string | null;
  findNodePosition: (sourceNodeId: string, newNodeWidth: number, newNodeHeight: number) => { x: number; y: number };
  addDerivedUploadNode: (
    sourceNodeId: string,
    imageUrl: string,
    aspectRatio: string,
    previewImageUrl?: string
  ) => string | null;
  addDerivedExportNode: (
    sourceNodeId: string,
    imageUrl: string,
    aspectRatio: string,
    previewImageUrl?: string
  ) => string | null;
  addStoryboardSplitNode: (
    sourceNodeId: string,
    rows: number,
    cols: number,
    frames: StoryboardFrameItem[],
    frameAspectRatio?: string
  ) => string | null;

  updateNodeData: (nodeId: string, data: Partial<CanvasNodeData>) => void;
  updateNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  updateStoryboardFrame: (
    nodeId: string,
    frameId: string,
    data: Partial<StoryboardFrameItem>
  ) => void;
  reorderStoryboardFrame: (
    nodeId: string,
    draggedFrameId: string,
    targetFrameId: string
  ) => void;

  deleteNode: (nodeId: string) => void;
  deleteEdge: (edgeId: string) => void;
  setSelectedNode: (nodeId: string | null) => void;

  openToolDialog: (dialog: ActiveToolDialog) => void;
  closeToolDialog: () => void;

  undo: () => boolean;
  redo: () => boolean;

  clearCanvas: () => void;
}

function nodeHasSourceHandle(type: CanvasNodeType): boolean {
  return (
    type === CANVAS_NODE_TYPES.upload ||
    type === CANVAS_NODE_TYPES.exportImage ||
    type === CANVAS_NODE_TYPES.imageEdit ||
    type === CANVAS_NODE_TYPES.storyboardSplit ||
    type === CANVAS_NODE_TYPES.storyboardGen
  );
}

function nodeHasTargetHandle(type: CanvasNodeType): boolean {
  return (
    type === CANVAS_NODE_TYPES.exportImage ||
    type === CANVAS_NODE_TYPES.imageEdit ||
    type === CANVAS_NODE_TYPES.storyboardSplit ||
    type === CANVAS_NODE_TYPES.storyboardGen
  );
}

function normalizeHandleId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') {
    return undefined;
  }
  return trimmed;
}

function normalizeEdgesWithNodes(rawEdges: CanvasEdge[], nodes: CanvasNode[]): CanvasEdge[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));

  return rawEdges
    .filter((edge) => {
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) {
        return false;
      }
      return nodeHasSourceHandle(sourceNode.type) && nodeHasTargetHandle(targetNode.type);
    })
    .map((edge) => ({
      ...edge,
      type: edge.type ?? 'disconnectableEdge',
      sourceHandle: normalizeHandleId((edge as CanvasEdge & { sourceHandle?: unknown }).sourceHandle),
      targetHandle: normalizeHandleId((edge as CanvasEdge & { targetHandle?: unknown }).targetHandle),
    }));
}

function normalizeNodes(rawNodes: CanvasNode[]): CanvasNode[] {
  return rawNodes
    .map((node) => {
      if (!Object.values(CANVAS_NODE_TYPES).includes(node.type as CanvasNodeType)) {
        return null;
      }

      const definition = nodeCatalog.getDefinition(node.type as CanvasNodeType);
      const mergedData = {
        ...definition.createDefaultData(),
        ...(node.data as Partial<CanvasNodeData>),
      } as CanvasNodeData;

      if (node.type === CANVAS_NODE_TYPES.storyboardSplit) {
        const frames = (mergedData as { frames?: StoryboardFrameItem[] }).frames ?? [];
        const firstFrameAspectRatio = frames.find((frame) => typeof frame.aspectRatio === 'string')
          ?.aspectRatio;
        const normalizedFrameAspectRatio =
          (typeof (mergedData as { frameAspectRatio?: unknown }).frameAspectRatio === 'string'
            ? (mergedData as { frameAspectRatio?: string }).frameAspectRatio
            : null) ??
          firstFrameAspectRatio ??
          DEFAULT_ASPECT_RATIO;

        (mergedData as { frameAspectRatio: string }).frameAspectRatio = normalizedFrameAspectRatio;
        (mergedData as { frames: StoryboardFrameItem[] }).frames = frames.map((frame, index) => ({
          id: frame.id,
          imageUrl: frame.imageUrl ?? null,
          previewImageUrl: frame.previewImageUrl ?? null,
          aspectRatio:
            typeof frame.aspectRatio === 'string'
              ? frame.aspectRatio
              : normalizedFrameAspectRatio,
          note: frame.note ?? '',
          order: Number.isFinite(frame.order) ? frame.order : index,
        }));

        const rawExportOptions = (mergedData as { exportOptions?: Partial<StoryboardExportOptions> })
          .exportOptions;
        const rawFontSize = Number.isFinite(rawExportOptions?.fontSize)
          ? Number(rawExportOptions?.fontSize)
          : createDefaultStoryboardExportOptions().fontSize;
        const normalizedFontSize = rawFontSize > 20
          ? Math.round(rawFontSize / 6)
          : rawFontSize;
        (mergedData as { exportOptions: StoryboardExportOptions }).exportOptions = {
          ...createDefaultStoryboardExportOptions(),
          ...(rawExportOptions ?? {}),
          fontSize: Math.max(1, Math.min(20, Math.round(normalizedFontSize))),
        };
      }

      if ('aspectRatio' in mergedData && !mergedData.aspectRatio) {
        mergedData.aspectRatio = DEFAULT_ASPECT_RATIO;
      }

      // Generation tasks do not survive app reload, reset transient generating state.
      if ('isGenerating' in mergedData && mergedData.isGenerating) {
        mergedData.isGenerating = false;
        if ('generationStartedAt' in mergedData) {
          mergedData.generationStartedAt = null;
        }
      }

      return {
        ...node,
        type: node.type as CanvasNodeType,
        data: mergedData,
      };
    })
    .filter((node): node is CanvasNode => Boolean(node));
}

function normalizeHistory(history?: CanvasHistoryState): CanvasHistoryState {
  if (!history) {
    return { past: [], future: [] };
  }

  const normalizeSnapshot = (snapshot: CanvasHistorySnapshot): CanvasHistorySnapshot => {
    const normalizedNodes = normalizeNodes(snapshot.nodes);
    return {
      nodes: normalizedNodes,
      edges: normalizeEdgesWithNodes(snapshot.edges, normalizedNodes),
    };
  };

  return {
    past: history.past.slice(-MAX_HISTORY_STEPS).map(normalizeSnapshot),
    future: history.future.slice(-MAX_HISTORY_STEPS).map(normalizeSnapshot),
  };
}

function createSnapshot(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasHistorySnapshot {
  return { nodes, edges };
}

function pushSnapshot(
  snapshots: CanvasHistorySnapshot[],
  snapshot: CanvasHistorySnapshot
): CanvasHistorySnapshot[] {
  const last = snapshots[snapshots.length - 1];
  if (last && last.nodes === snapshot.nodes && last.edges === snapshot.edges) {
    return snapshots;
  }

  const next = [...snapshots, snapshot];
  if (next.length > MAX_HISTORY_STEPS) {
    next.shift();
  }
  return next;
}

function getDerivedNodePosition(nodes: CanvasNode[], sourceNodeId: string): { x: number; y: number } {
  const sourceNode = nodes.find((node) => node.id === sourceNodeId);
  if (!sourceNode) {
    return { x: 100, y: 100 };
  }

  return {
    x: sourceNode.position.x + DEFAULT_NODE_WIDTH + 100,
    y: sourceNode.position.y,
  };
}

function resolveSelectedNodeId(selectedNodeId: string | null, nodes: CanvasNode[]): string | null {
  if (!selectedNodeId) {
    return null;
  }
  return nodes.some((node) => node.id === selectedNodeId) ? selectedNodeId : null;
}

function resolveActiveToolDialog(
  activeToolDialog: ActiveToolDialog | null,
  nodes: CanvasNode[]
): ActiveToolDialog | null {
  if (!activeToolDialog) {
    return null;
  }
  return nodes.some((node) => node.id === activeToolDialog.nodeId) ? activeToolDialog : null;
}

function createDefaultStoryboardExportOptions(): StoryboardExportOptions {
  return {
    showFrameIndex: false,
    showFrameNote: false,
    notePlacement: 'overlay',
    imageFit: 'cover',
    frameIndexPrefix: 'S',
    cellGap: 8,
    outerPadding: 0,
    fontSize: 4,
    backgroundColor: '#0f1115',
    textColor: '#f8fafc',
  };
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  activeToolDialog: null,
  history: { past: [], future: [] },
  dragHistorySnapshot: null,

  onNodesChange: (changes) => {
    set((state) => {
      const nextNodes = applyNodeChanges<CanvasNode>(changes, state.nodes);
      const hasMeaningfulChange = changes.some((change) => change.type !== 'select');
      const hasDragMove = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          Boolean(change.dragging)
      );
      const hasDragEnd = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          change.dragging === false
      );

      let nextHistory = state.history;
      let nextDragHistorySnapshot = state.dragHistorySnapshot;

      if (hasDragMove && !nextDragHistorySnapshot) {
        nextDragHistorySnapshot = createSnapshot(state.nodes, state.edges);
      }

      if (hasDragEnd) {
        const snapshot = nextDragHistorySnapshot ?? createSnapshot(state.nodes, state.edges);
        nextHistory = {
          past: pushSnapshot(state.history.past, snapshot),
          future: [],
        };
        nextDragHistorySnapshot = null;
      } else if (hasMeaningfulChange && !hasDragMove) {
        nextHistory = {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        };
        nextDragHistorySnapshot = null;
      }

      return {
        nodes: nextNodes,
        selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, nextNodes),
        activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, nextNodes),
        history: nextHistory,
        dragHistorySnapshot: nextDragHistorySnapshot,
      };
    });
  },

  onEdgesChange: (changes) => {
    set((state) => {
      const nextEdges = applyEdgeChanges<CanvasEdge>(changes, state.edges);
      const hasMeaningfulChange = changes.some((change) => change.type !== 'select');

      if (!hasMeaningfulChange) {
        return { edges: nextEdges };
      }

      return {
        edges: nextEdges,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  onConnect: (connection) => {
    set((state) => ({
      edges: addEdge<CanvasEdge>({ ...connection, type: 'disconnectableEdge' }, state.edges),
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    }));
  },

  setCanvasData: (nodes, edges, history) => {
    const normalizedNodes = normalizeNodes(nodes);
    const normalizedEdges = normalizeEdgesWithNodes(edges, normalizedNodes);

    set({
      nodes: normalizedNodes,
      edges: normalizedEdges,
      selectedNodeId: null,
      activeToolDialog: null,
      history: normalizeHistory(history),
      dragHistorySnapshot: null,
    });
  },

  addNode: (type, position, data = {}) => {
    const state = get();
    const newNode = canvasNodeFactory.createNode(type, position, data);
    set({
      nodes: [...state.nodes, newNode],
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });
    return newNode.id;
  },

  addEdge: (source, target) => {
    const state = get();
    // Check if both nodes exist
    const sourceNode = state.nodes.find((n) => n.id === source);
    const targetNode = state.nodes.find((n) => n.id === target);
    if (!sourceNode || !targetNode) {
      return null;
    }
    if (!nodeHasSourceHandle(sourceNode.type) || !nodeHasTargetHandle(targetNode.type)) {
      return null;
    }

    const edgeId = `e-${source}-${target}`;
    // Check if edge already exists
    if (state.edges.some((e) => e.id === edgeId)) {
      return edgeId;
    }

    const newEdge: CanvasEdge = {
      id: edgeId,
      source,
      target,
      type: 'disconnectableEdge',
    };

    set({
      edges: [...state.edges, newEdge],
    });

    return edgeId;
  },

  findNodePosition: (sourceNodeId, newNodeWidth, newNodeHeight) => {
    const state = get();
    const sourceNode = state.nodes.find((n) => n.id === sourceNodeId);
    if (!sourceNode) {
      return { x: 100, y: 100 };
    }

    // Helper to check if a position collides with existing nodes.
    const collides = (x: number, y: number, width: number, height: number) => {
      return state.nodes.some((node) => {
        const nodeWidth = node.measured?.width ?? DEFAULT_NODE_WIDTH;
        const nodeHeight = node.measured?.height ?? 200;
        const margin = 20;
        return (
          x < node.position.x + nodeWidth + margin &&
          x + width + margin > node.position.x &&
          y < node.position.y + nodeHeight + margin &&
          y + height + margin > node.position.y
        );
      });
    };

    const sourceWidth = sourceNode.measured?.width ?? DEFAULT_NODE_WIDTH;
    const anchorX = sourceNode.position.x + sourceWidth + 56;
    const anchorY = sourceNode.position.y;

    const stepX = Math.max(newNodeWidth + 22, 180);
    const stepY = Math.max(Math.round(newNodeHeight * 0.62), 112);
    const maxColumns = 7;
    const maxBands = 4;

    // Keep new nodes close first: center, then +-1, +-2...
    for (let col = 0; col < maxColumns; col += 1) {
      const candidateX = anchorX + col * stepX;
      for (let band = 0; band <= maxBands; band += 1) {
        const offsets = band === 0 ? [0] : [-band, band];
        for (const offset of offsets) {
          const candidateY = anchorY + offset * stepY;
          if (!collides(candidateX, candidateY, newNodeWidth, newNodeHeight)) {
            return { x: candidateX, y: candidateY };
          }
        }
      }
    }

    // Fallback: place farther right of the scanned area.
    return {
      x: anchorX + maxColumns * stepX,
      y: anchorY,
    };
  },

  addDerivedUploadNode: (sourceNodeId, imageUrl, aspectRatio, previewImageUrl) => {
    const state = get();
    const position = getDerivedNodePosition(state.nodes, sourceNodeId);
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, position, {
      imageUrl,
      previewImageUrl: previewImageUrl ?? null,
      aspectRatio,
    });

    set({
      nodes: [...state.nodes, node],
      selectedNodeId: node.id,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return node.id;
  },

  addDerivedExportNode: (sourceNodeId, imageUrl, aspectRatio, previewImageUrl) => {
    const state = get();
    const position = state.findNodePosition(sourceNodeId, 220, 180);
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.exportImage, position, {
      imageUrl,
      previewImageUrl: previewImageUrl ?? null,
      aspectRatio,
    });

    set({
      nodes: [...state.nodes, node],
      selectedNodeId: node.id,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return node.id;
  },

  addStoryboardSplitNode: (sourceNodeId, rows, cols, frames, frameAspectRatio) => {
    const state = get();
    const position = getDerivedNodePosition(state.nodes, sourceNodeId);
    const resolvedFrameAspectRatio =
      frameAspectRatio ??
      frames.find((frame) => typeof frame.aspectRatio === 'string')?.aspectRatio ??
      DEFAULT_ASPECT_RATIO;

    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.storyboardSplit, position, {
      gridRows: rows,
      gridCols: cols,
      frames,
      aspectRatio: resolvedFrameAspectRatio,
      frameAspectRatio: resolvedFrameAspectRatio,
      exportOptions: createDefaultStoryboardExportOptions(),
    });

    set({
      nodes: [...state.nodes, node],
      selectedNodeId: node.id,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return node.id;
  },

  updateNodeData: (nodeId, data) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        changed = true;
        return {
          ...node,
          data: {
            ...node.data,
            ...data,
          } as CanvasNodeData,
        };
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  updateNodePosition: (nodeId, position) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        if (node.position.x === position.x && node.position.y === position.y) {
          return node;
        }

        changed = true;
        return {
          ...node,
          position,
        };
      });

      if (!changed) {
        return {};
      }

      return { nodes: nextNodes };
    });
  },

  updateStoryboardFrame: (nodeId, frameId, data) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId || !isStoryboardSplitNode(node)) {
          return node;
        }

        const nextFrames = node.data.frames.map((frame) => {
          if (frame.id !== frameId) {
            return frame;
          }

          changed = true;
          return {
            ...frame,
            ...data,
          };
        });

        return {
          ...node,
          data: {
            ...node.data,
            frames: nextFrames,
          },
        };
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  reorderStoryboardFrame: (nodeId, draggedFrameId, targetFrameId) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId || !isStoryboardSplitNode(node)) {
          return node;
        }

        const frames = [...node.data.frames].sort((a, b) => a.order - b.order);
        const fromIndex = frames.findIndex((frame) => frame.id === draggedFrameId);
        const toIndex = frames.findIndex((frame) => frame.id === targetFrameId);

        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
          return node;
        }

        changed = true;
        const [movedFrame] = frames.splice(fromIndex, 1);
        frames.splice(toIndex, 0, movedFrame);

        return {
          ...node,
          data: {
            ...node.data,
            frames: frames.map((frame, index) => ({
              ...frame,
              order: index,
            })),
          },
        };
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  deleteNode: (nodeId) => {
    set((state) => {
      const hasNode = state.nodes.some((node) => node.id === nodeId);
      if (!hasNode) {
        return {};
      }

      const nextNodes = state.nodes.filter((node) => node.id !== nodeId);
      const nextEdges = state.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);

      return {
        nodes: nextNodes,
        edges: nextEdges,
        selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
        activeToolDialog: state.activeToolDialog?.nodeId === nodeId ? null : state.activeToolDialog,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  deleteEdge: (edgeId) => {
    set((state) => {
      const hasEdge = state.edges.some((edge) => edge.id === edgeId);
      if (!hasEdge) {
        return {};
      }

      return {
        edges: state.edges.filter((edge) => edge.id !== edgeId),
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  setSelectedNode: (nodeId) => {
    set({ selectedNodeId: nodeId });
  },

  openToolDialog: (dialog) => {
    set({ activeToolDialog: dialog });
  },

  closeToolDialog: () => {
    set({ activeToolDialog: null });
  },

  undo: () => {
    const state = get();
    const target = state.history.past[state.history.past.length - 1];
    if (!target) {
      return false;
    }

    const currentSnapshot = createSnapshot(state.nodes, state.edges);
    const nextPast = state.history.past.slice(0, -1);

    set({
      nodes: target.nodes,
      edges: target.edges,
      selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, target.nodes),
      activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, target.nodes),
      history: {
        past: nextPast,
        future: pushSnapshot(state.history.future, currentSnapshot),
      },
      dragHistorySnapshot: null,
    });
    return true;
  },

  redo: () => {
    const state = get();
    const target = state.history.future[state.history.future.length - 1];
    if (!target) {
      return false;
    }

    const currentSnapshot = createSnapshot(state.nodes, state.edges);
    const nextFuture = state.history.future.slice(0, -1);

    set({
      nodes: target.nodes,
      edges: target.edges,
      selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, target.nodes),
      activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, target.nodes),
      history: {
        past: pushSnapshot(state.history.past, currentSnapshot),
        future: nextFuture,
      },
      dragHistorySnapshot: null,
    });
    return true;
  },

  clearCanvas: () => {
    set((state) => {
      if (state.nodes.length === 0 && state.edges.length === 0) {
        return {};
      }

      return {
        nodes: [],
        edges: [],
        selectedNodeId: null,
        activeToolDialog: null,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },
}));
