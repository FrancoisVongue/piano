'use client';

import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useArrangementHotkeys } from '../hooks/useArrangementHotkeys';
import { useCanvasSync } from '../hooks/useCanvasSync';
import { useRunningNodeUpdates } from '../hooks/useRunningNodePolling';
import { useCanvasReactiveSync } from '../store-valtio';
import { usePersistMachineLayouts } from './MachineWindow/usePersistMachineLayouts';
import { dropOnCanvas, canvasAcceptsDrop, toastForFileResult } from '../drag/drop-on-canvas';
import { match } from 'venum';
import { useCanvasStore } from '../store';
import { useAuthStore } from '@/domain/auth/store';
import { useActionsStore } from '@/domain/action/store';
import { ActionsProvider } from '@/domain/action/ActionsContext';
import { useArrangement } from '@/domain/arrangement/hooks/useArrangements';
import {
  Note,
  Edge as EdgeModel,
  Arrangement,
  MachineTemplate,
  clearOrphanedNodes,
  topologicalSort,
} from '@piano/shared';
import {
  Controls,
  ReactFlow,
  Connection,
  ReactFlowInstance,
  type Node as ReactFlowNode,
  useOnViewportChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useState, useCallback, useEffect, memo, useMemo, useRef } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { RefreshCw, Layers, Square, Type, Server, X, CornerDownRight, Settings, Frame, Pencil, Slash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { NoteCard } from './NoteCard';
import { TextNode } from './TextNode';
import { MachineNode } from './MachineNode';
import { TerminalNode } from './TerminalNode';
import { ZoneNode } from './ZoneNode';
import { DrawingNode } from './DrawingNode';
import { DrawingLayer } from './DrawingLayer';
import { CustomEdge } from './CustomEdge';
import { ConnectionLine } from './ConnectionLine';
import { ModelSelector } from './ModelSelector';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import { createCycleValidator } from '@/lib/flow-validation';
import { CanvasNode, MachineLabel } from '../types';
import { CanvasInspector } from './CanvasInspector/CanvasInspector';
import { ProjectSettingsOverlay } from './ProjectSettingsOverlay';

// Module-scope: one validator for the lifetime of the module. Its pure
// `isValidConnection` reads nodes/edges from arguments — no internal state,
// no need to recreate it per render.
const cycleValidator = createCycleValidator();
import { OperationsButton } from './OperationsButton';
import { WorkspacesButton } from './WorkspacesButton';
import { readSavedViewport, writeSavedViewport } from '../lib/viewport-persistence';
import { Z } from '../lib/z-layers';
import {
  CanvasWindowLayer,
  type CanvasWindowLayerHandle,
  type CanvasWindowLayerStats,
} from './CanvasWindowLayer';
import { NodeDialogsHost } from './NodeDialogsHost';
import { Minimap } from './Minimap';
import { useMachineCenterStore } from '@/domain/machine-center/store';
import { useDaemonPicker } from '@/domain/daemon/components/DaemonSelect';
import { cn } from '@/lib/utils';

// GROUP → NodeEditPanel; standalone text nodes also use the main panel.
// GroupNodeEditPanel has been deleted as groups were removed in favor of text nodes.

// Memoize node types to prevent React Flow re-initialization
const nodeTypes = {
  note: NoteCard,
  text: TextNode,
  machine: MachineNode,
  terminal: TerminalNode,
  zone: ZoneNode,
  drawing: DrawingNode,
};

// Memoize edge types to prevent React Flow re-initialization
const edgeTypes = {
  custom: CustomEdge,
};
const EMPTY_EDGE_ID_SET = new Set<string>();

import { syncLodForZoom } from '../lib/lod';

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

// Tracks viewport changes without routing live zoom through React state.
// LOD updates are threshold-based: registered nodes only get touched when
// their effective zoom crosses the full/low-detail boundary. localStorage
// persist is a separate 1s debounce.
function ZoomTracker({
  arrangementId,
  zoomVarTargetRef,
}: {
  arrangementId: string | null;
  zoomVarTargetRef: RefObject<HTMLElement | null>;
}) {
  const rafRef = useRef<number | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef({ x: 0, y: 0, zoom: 1 });

  const scheduleWork = useCallback(
    (viewport: { x: number; y: number; zoom: number }) => {
      latestRef.current = viewport;

      // Coalesce viewport work into one RAF. No store writes — live zoom
      // should stay out of Zustand while the wheel/pinch gesture is active.
      if (rafRef.current === null) {
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = null;
          syncLodForZoom(latestRef.current.zoom);

          // NOTE: deliberately NO store write here. canvasZoom lives in the
          // Zustand store, and every node/edge (hundreds of them) holds a live
          // store subscription. A `set()` re-runs *every* subscriber's selector,
          // so writing zoom on each RAF tick fires thousands of selector
          // executions per frame during a pinch — that was the zoom lag. The
          // store mirror is committed once, on gesture END (see onEnd below).
          // Keep this invariant.
        });
      }

      // Persistence is a separate debounce — localStorage write is best
      // throttled to once per second, independent of paint cadence.
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        if (arrangementId) writeSavedViewport(arrangementId, latestRef.current);
      }, 1000);
    },
    [arrangementId],
  );

  // onChange runs the cheap per-tick LOD threshold sync.
  // onEnd additionally commits the zoom into the store exactly once, so the
  // top-bar chip / spawn-scale calc see the settled value without paying the
  // per-frame subscriber-notification cost during the gesture.
  const commitZoomToStore = useCallback((viewport: { x: number; y: number; zoom: number }) => {
    scheduleWork(viewport);
    zoomVarTargetRef.current?.style.setProperty('--canvas-zoom', String(viewport.zoom));
    useCanvasStore.getState().setCanvasZoom(viewport.zoom);
  }, [scheduleWork, zoomVarTargetRef]);
  useOnViewportChange({ onChange: scheduleWork, onEnd: commitZoomToStore });

  useEffect(() => {
    zoomVarTargetRef.current?.style.setProperty('--canvas-zoom', '1');
    syncLodForZoom(1);
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [zoomVarTargetRef]);

  return null;
}

type DecoratedNodeCacheEntryLocal = {
  sourceNode: ReactFlowNode;
  zIndex: number;
  hidden: boolean;
  decoratedNode: ReactFlowNode;
};

interface ReactFlowCanvasInnerProps {
  canvasKey: number;
  selectedNodeId: string | null;
  hiddenNodeIds: Set<string>;
  onNodesChange: any;
  onEdgesChange: any;
  onConnect: any;
  onNodeClick: (event: React.MouseEvent, node: ReactFlowNode) => void;
  onNodeDoubleClick: (event: React.MouseEvent, node: ReactFlowNode) => void;
  onPaneClick: (event: React.MouseEvent | MouseEvent) => void;
  onNodeDragStop: any;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  validateConnection: (connection: Connection) => boolean;
  onInit: (instance: ReactFlowInstance) => void;
  arrangementId: string | null;
  zoomVarTargetRef: RefObject<HTMLElement | null>;
}

// Subscribes to `nodes` + `edges` internally so that Canvas (the parent) does
// NOT re-render on every drag tick. Without this, the parent's whole JSX tree
// (toolbar, ActionsProvider, dropdowns, dialog hosts, ...) re-evaluates 60×/s
// during a drag, swamping the actual node-position diff that React Flow needs
// to commit. Here the only thing that re-renders is this tiny inner component
// and the diffed ReactFlow subtree — exactly what should re-render.
function ReactFlowCanvasInner({
  canvasKey,
  selectedNodeId,
  hiddenNodeIds,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onNodeDoubleClick,
  onPaneClick,
  onNodeDragStop,
  onDragOver,
  onDrop,
  validateConnection,
  onInit,
  arrangementId,
  zoomVarTargetRef,
}: ReactFlowCanvasInnerProps) {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const visibleLayers = useCanvasStore((state) => state.visibleLayers);
  const globalVisible = useCanvasStore((state) => state.globalVisible);
  const decoratedCacheRef = useRef<Map<string, DecoratedNodeCacheEntryLocal>>(new Map());
  const layerHiddenIdsRef = useRef<Set<string>>(new Set());

  // Layer-filter pass: a node is layer-hidden iff none of its layers is in
  // the visible set (with `globalVisible` controlling the `[]` shape). Edges
  // to filtered-out endpoints become hidden too — a dangling line is worse
  // than no line.
  const layerHiddenIds = useMemo(() => {
    const out = new Set<string>();
    for (const n of nodes) {
      if (!Note.Layers.isVisibleOn(n.data as any, visibleLayers, globalVisible)) out.add(n.id);
    }
    if (setsEqual(layerHiddenIdsRef.current, out)) return layerHiddenIdsRef.current;
    layerHiddenIdsRef.current = out;
    return out;
  }, [nodes, visibleLayers, globalVisible]);

  const edgeByTarget = useMemo(() => {
    const byTarget = new Map<string, (typeof edges)[number]>();
    for (const edge of edges) byTarget.set(edge.target, edge);
    return byTarget;
  }, [edges]);

  const selectedAncestorEdgeIds = useMemo(() => {
    if (!selectedNodeId) return EMPTY_EDGE_ID_SET;
    const ancestorEdges = new Set<string>();
    let currentId: string | null = selectedNodeId;

    while (currentId) {
      const parentEdge = edgeByTarget.get(currentId);
      if (!parentEdge) break;
      ancestorEdges.add(parentEdge.id);
      currentId = parentEdge.source;
    }

    return ancestorEdges;
  }, [edgeByTarget, selectedNodeId]);

  const highlightedEdges = useMemo(() => {
    let changed = false;
    const nextEdges = edges.map(edge => {
      const shouldBeBold = selectedAncestorEdgeIds.has(edge.id);
      const targetStrokeWidth = shouldBeBold ? 4 : 2;
      const currentStrokeWidth = edge.style?.strokeWidth || 2;
      const shouldBeLayerHidden =
        layerHiddenIds.size > 0 && (layerHiddenIds.has(edge.source) || layerHiddenIds.has(edge.target));

      if (currentStrokeWidth === targetStrokeWidth && !shouldBeLayerHidden) {
        return edge;
      }

      changed = true;
      const styledEdge =
        currentStrokeWidth === targetStrokeWidth
          ? edge
          : { ...edge, style: { ...edge.style, strokeWidth: targetStrokeWidth } };
      return shouldBeLayerHidden ? { ...styledEdge, hidden: true } : styledEdge;
    });

    return changed ? nextEdges : edges;
  }, [edges, selectedAncestorEdgeIds, layerHiddenIds]);

  // Topology-derived depth only changes when edges change. Keeping this out
  // of the `nodes` memo prevents a full graph DFS on every position tick.
  const graphDepthByNodeId = useMemo(() => {
    const parentsOf = new Map<string, string[]>();
    for (const e of edges) {
      const list = parentsOf.get(e.target) ?? [];
      list.push(e.source);
      parentsOf.set(e.target, list);
    }
    const depthOf = new Map<string, number>();
    const measure = (id: string, visiting: Set<string>): number => {
      const cached = depthOf.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const parents = parentsOf.get(id) ?? [];
      const d = parents.length > 0 ? Math.max(...parents.map((p) => measure(p, visiting))) + 1 : 0;
      visiting.delete(id);
      depthOf.set(id, d);
      return d;
    };

    for (const id of parentsOf.keys()) measure(id, new Set());
    for (const parents of parentsOf.values()) {
      for (const id of parents) measure(id, new Set());
    }
    return depthOf;
  }, [edges]);

  // Per-node zIndex so children render above parents. Cache keyed on node ref
  // so a drag tick (one node changes ref, rest are reference-equal) only
  // redecorates the changed node; topology is already cached above.
  const nodesWithZIndex = useMemo(() => {
    const cache = decoratedCacheRef.current;
    const nextIds = new Set<string>();
    const decorated = nodes.map((n) => {
      nextIds.add(n.id);
      // Annotations sit behind content: ZONE at the very back (a backdrop to
      // organize within), DRAWING just above it; everything else stacks by
      // graph depth (precomputed in graphDepthByNodeId) so children render
      // over parents.
      const ntype = (n.data as { type?: string } | undefined)?.type;
      const zIndex =
        ntype === 'ZONE' ? 0 : ntype === 'DRAWING' ? 1 : 1000 + (graphDepthByNodeId.get(n.id) ?? 0);
      // Hidden = collapsed-via-ancestor OR filtered-out-by-layer.
      const hidden = hiddenNodeIds.has(n.id) || layerHiddenIds.has(n.id);
      const cached = cache.get(n.id);
      if (cached && cached.sourceNode === n && cached.zIndex === zIndex && cached.hidden === hidden) {
        return cached.decoratedNode;
      }
      // Locked shapes (ZONE / DRAWING) pin in place — RF honours per-node
      // `draggable: false` even inside a multi-select drag. Lock state rides
      // in `data.style.locked`; toggling it changes the node ref, so this
      // recomputes on the next render.
      const draggable = !CanvasNode.isLocked(n.data as CanvasNode.UI);
      const decoratedNode = { ...n, zIndex, hidden, draggable };
      cache.set(n.id, { sourceNode: n, zIndex, hidden, decoratedNode });
      return decoratedNode;
    });
    for (const id of cache.keys()) if (!nextIds.has(id)) cache.delete(id);
    return decorated;
  }, [nodes, graphDepthByNodeId, hiddenNodeIds, layerHiddenIds]);

  return (
    <ReactFlow
      key={canvasKey}
      nodes={nodesWithZIndex}
      edges={highlightedEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onPaneClick={onPaneClick}
      onNodeDragStop={onNodeDragStop}
      onDragOver={onDragOver}
      onDrop={onDrop}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      connectionLineComponent={ConnectionLine}
      isValidConnection={validateConnection}
      onInit={onInit}
      fitView
      className="bg-[#f4efe5]"
      minZoom={0.05}
      maxZoom={50}
      // Keep viewport changes transform-first. React Flow's visibility
      // culling adds per-zoom bookkeeping and can mount/unmount nodes while
      // the wheel gesture is active; our CSS LOD handles zoomed-out density.
      onlyRenderVisibleElements={false}
      elevateNodesOnSelect={false}
      elevateEdgesOnSelect={false}
      // React Flow's default deleteKeyCode is ['Backspace', 'Delete'].
      // We never want raw key-based deletion: it eats Backspace inside
      // textareas adjacent to the canvas, fights the per-node delete
      // affordance and the running-grace window. Explicit menu / X
      // button is the only sanctioned delete path.
      deleteKeyCode={null}
    >
      <ZoomTracker arrangementId={arrangementId} zoomVarTargetRef={zoomVarTargetRef} />
      <Controls />
      <Minimap />
      {/* Drawing-tool capture overlay — active only when a draw tool is
          selected; otherwise renders nothing and the canvas is untouched. */}
      <DrawingLayer />
    </ReactFlow>
  );
}

interface CanvasProps {
  arrangementId: string | null;
}

// Mounted INSIDE ActionsProvider so useArrangementHotkeys can read the
// visible-actions list via useActionsContext. Renders nothing — it's just
// a hook host.
function ArrangementHotkeyMounter({ arrangement }: { arrangement: Arrangement.Model | null }) {
  useArrangementHotkeys({ arrangement });
  return null;
}

type PlacementMode =
  | { kind: 'note' }
  | { kind: 'text' }
  | { kind: 'machine'; templateId: string | null; label: string; daemonId: string | null }
  | null;

type ParentPickerMode = { childIds: string[] } | null;

function placementLabel(mode: PlacementMode): string | null {
  if (!mode) return null;
  if (mode.kind === 'note') return 'Note';
  if (mode.kind === 'text') return 'Text';
  return mode.label || 'Machine';
}

function CanvasComponent({ arrangementId }: CanvasProps) {
  // `nodes` and `edges` are deliberately NOT subscribed here — that lives in
  // <ReactFlowCanvasInner> below. Canvas mustn't re-render on every drag
  // tick or the whole toolbar/dialog tree above evaluates at 60Hz.
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const onNodeClick = useCanvasStore((state) => state.onNodeClick);
  const onPaneClick = useCanvasStore((state) => state.onPaneClick);
  const onNodeDragStop = useCanvasStore((state) => state.onNodeDragStop);
  const setParentForNodes = useCanvasStore((state) => state.setParentForNodes);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const hiddenNodeIds = useCanvasStore((state) => state.hiddenNodeIds);
  const setArrangementId = useCanvasStore((state) => state.setArrangementId);
  const setGetViewportCenter = useCanvasStore((state) => state.setGetViewportCenter);
  const setImperativeZoomTo = useCanvasStore((state) => state.setImperativeZoomTo);
  const createNode = useCanvasStore((state) => state.createNode);
  const createTextNode = useCanvasStore((state) => state.createTextNode);
  const activeTool = useCanvasStore((state) => state.activeTool);
  const setActiveTool = useCanvasStore((state) => state.setActiveTool);
  const createMachineNodeFromTemplate = useCanvasStore(
    (state) => state.createMachineNodeFromTemplate
  );
  const pasteNodes = useCanvasStore((state) => state.pasteNodes);
  const loadCanvasState = useCanvasStore((state) => state.loadCanvasState);
  const machineTemplates = useMachineCenterStore((state) => state.templates);
  const fetchMachineTemplates = useMachineCenterStore((state) => state.fetchTemplates);

  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [windowStats, setWindowStats] = useState<CanvasWindowLayerStats>({
    open: 0,
    minimized: 0,
    canGroup: false,
    canUngroup: false,
  });
  const windowLayerRef = useRef<CanvasWindowLayerHandle>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);

  const [placementMode, setPlacementMode] = useState<PlacementMode>(null);
  const [parentPickerMode, setParentPickerMode] = useState<ParentPickerMode>(null);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [isMachinePickerOpen, setIsMachinePickerOpen] = useState(false);
  const [machinePickerTemplateId, setMachinePickerTemplateId] = useState<string | null>(null);
  const [machinePickerLabel, setMachinePickerLabel] = useState('Machine');
  const {
    selectedDaemonId: machinePickerDaemonId,
    setSelectedDaemonId: setMachinePickerDaemonId,
    onlineDaemons,
  } = useDaemonPicker();
  const isCursorOnCanvasRef = useRef(false);
  const canvasCursorScreenRef = useRef<{ x: number; y: number } | null>(null);
  const [placementCursorScreen, setPlacementCursorScreen] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // createCycleValidator returns a closure that only reads nodes/edges
  // when called (at connect-attempt time, which is rare). No need to thread
  // current nodes/edges through useCallback deps — read fresh from the
  // store at validation time. Stable callback identity = RF doesn't churn
  // its internal connection handler bindings on every drag tick.
  const validateConnection = useCallback(
    (connection: Connection) => {
      const { nodes, edges } = useCanvasStore.getState();
      return cycleValidator.isValidConnection(connection, nodes, edges);
    },
    []
  );

  const user = useAuthStore((state) => state.user);

  // Fetch arrangement data
  const { arrangement, updateArrangementField } = useArrangement(arrangementId);

  // Fetch actions once (globally, not per node)
  const fetchActions = useActionsStore((state) => state.fetchActions);

  const save = useCallback(async () => {
    // Save is handled by useCanvasSync automatically
  }, []);

  useCanvasSync(arrangementId); // Enable optimistic sync
  useRunningNodeUpdates(user?.id || null); // SSE updates for running nodes
  useCanvasReactiveSync(); // One-way mirror of state.nodes into the Valtio shadow store
  usePersistMachineLayouts(); // MachineWindow layout changes → mark MACHINE node dirty for sync

  // Fetch actions once on mount
  useEffect(() => {
    fetchActions();
  }, [fetchActions]);

  // Update arrangementId in store when it changes
  useEffect(() => {
    setArrangementId(arrangementId);
  }, [arrangementId, setArrangementId]);

  // Seed canvas state from the RQ cache the FIRST time we visit each
  // arrangement in this session. After that, the per-arrangement snapshot in
  // the Zustand store (see `setArrangementId`) is authoritative — re-running
  // `loadCanvasState` on background refetches would wipe undo history and
  // overwrite in-progress edits with stale cache data. Tab round-trips
  // A→B→A restore from the snapshot without consulting the cache at all.
  const loadedArrangementIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!arrangementId) return;
    if (
      !arrangement ||
      typeof arrangement !== 'object' ||
      !('notes' in arrangement) ||
      !('edges' in arrangement)
    )
      return;
    if (loadedArrangementIdsRef.current.has(arrangementId)) return;
    // If a snapshot already exists (e.g. user briefly visited this arrangement
    // earlier in the session), the store has the canonical state — don't load.
    if (useCanvasStore.getState().arrangementSnapshots.has(arrangementId)) {
      loadedArrangementIdsRef.current.add(arrangementId);
      return;
    }
    loadedArrangementIdsRef.current.add(arrangementId);

    const notes = (arrangement.notes as Note.Model[]) || [];
    const edges = (arrangement.edges as EdgeModel.Model[]) || [];
    let rfNodes = notes.map(Note.Transform.toRfNode);
    rfNodes = clearOrphanedNodes(rfNodes);
    const sortedNodes = topologicalSort(rfNodes);
    const rfEdges = edges.map(EdgeModel.Transform.toRfEdge);
    loadCanvasState(sortedNodes, rfEdges);
  }, [arrangement, arrangementId, loadCanvasState]);
  const windowsPersistenceReady = Boolean(
    arrangementId &&
    (loadedArrangementIdsRef.current.has(arrangementId) ||
      useCanvasStore.getState().arrangementSnapshots.has(arrangementId))
  );

  // Separate viewport-restore effect. Runs once per arrangementId AFTER the
  // reactFlowInstance exists. Two effects instead of one because the load effect
  // can fire before onInit sets the instance (cache hit path), and we don't
  // want viewport restore to silently no-op in that case.
  const restoredViewportForArrangementIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!reactFlowInstance || !arrangementId) return;
    if (restoredViewportForArrangementIdRef.current === arrangementId) return;
    if (!arrangement || !('notes' in arrangement)) return;

    restoredViewportForArrangementIdRef.current = arrangementId;

    const saved = readSavedViewport(arrangementId);
    if (saved) {
      reactFlowInstance.setViewport(saved, { duration: 0 });
      // duration:0 doesn't emit a viewport-change event, so seed the store
      // mirror + LOD registry once here — otherwise the chip and low-detail
      // buckets stay stale until the first manual zoom.
      syncLodForZoom(saved.zoom);
      useCanvasStore.getState().setCanvasZoom(saved.zoom);
      return;
    }

    // No saved viewport — fall back to centering on the most-recently-edited note.
    const notes = arrangement.notes as Note.Model[];
    if (!notes || notes.length === 0) return;
    const latestTimestamp = Math.max(...notes.map((n) => new Date(n.updatedAt).getTime()));
    const lastEditedNote = notes.find((n) => new Date(n.updatedAt).getTime() === latestTimestamp);
    if (lastEditedNote) {
      reactFlowInstance.setCenter(lastEditedNote.x, lastEditedNote.y, { duration: 0, zoom: 1.0 });
    }
  }, [reactFlowInstance, arrangementId, arrangement]);

  // Prevent text selection during Shift key operations (multi-select)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        document.body.style.userSelect = 'none';
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        document.body.style.userSelect = '';
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      document.body.style.userSelect = ''; // Clean up on unmount
    };
  }, []);

  // Set viewport center getter when React Flow instance is ready
  useEffect(() => {
    if (reactFlowInstance) {
      const getCenter = () => {
        const { x, y, zoom } = reactFlowInstance.getViewport();
        // Position at 30% from left and top of viewport
        const targetX = window.innerWidth * 0.3;
        const targetY = window.innerHeight * 0.3;
        // React Flow v11+ uses screenToFlowPosition instead of project
        const position = reactFlowInstance.screenToFlowPosition
          ? reactFlowInstance.screenToFlowPosition({ x: targetX, y: targetY })
          : { x: (targetX - x) / zoom, y: (targetY - y) / zoom }; // Manual calculation fallback
        return position;
      };
      setGetViewportCenter(getCenter);

      // Pivot around the screen centre so the slider doesn't pan the canvas.
      const zoomTo = (zoom: number, opts?: { duration?: number }) => {
        const { x, y, zoom: current } = reactFlowInstance.getViewport();
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const flowX = (cx - x) / current;
        const flowY = (cy - y) / current;
        reactFlowInstance.setViewport(
          { x: cx - flowX * zoom, y: cy - flowY * zoom, zoom },
          { duration: opts?.duration ?? 120 },
        );
      };
      setImperativeZoomTo(zoomTo);

      // Cleanup function to remove the getter when component unmounts
      return () => {
        setGetViewportCenter(null);
        setImperativeZoomTo(null);
      };
    }
  }, [reactFlowInstance, setGetViewportCenter, setImperativeZoomTo]);

  // nodesWithZIndex / highlightedEdges and the underlying nodes/edges
  // subscriptions now live inside <ReactFlowCanvasInner> — see the top of
  // this file. Keeping them here would re-subscribe Canvas itself to nodes
  // and defeat the whole point of the extraction. Layer filtering lives
  // there too: it depends on per-node data and must run on the same render
  // path as the z-index/hidden decoration.

  // If the selected node just became hidden (user collapsed an ancestor),
  // drop selection so the edit panel doesn't linger on an invisible node.
  useEffect(() => {
    if (selectedNodeId && hiddenNodeIds.has(selectedNodeId)) {
      useCanvasStore.setState({ selectedNodeId: null });
    }
  }, [hiddenNodeIds, selectedNodeId]);

  const getCursorFlowPosition = useCallback(
    (point = canvasCursorScreenRef.current) => {
      if (!reactFlowInstance || !point) return null;

      const { x, y, zoom } = reactFlowInstance.getViewport();
      return reactFlowInstance.screenToFlowPosition
        ? reactFlowInstance.screenToFlowPosition(point)
        : { x: (point.x - x) / zoom, y: (point.y - y) / zoom };
    },
    [reactFlowInstance]
  );

  const requireCanvasCursor = useCallback(() => {
    if (!isCursorOnCanvasRef.current || !canvasCursorScreenRef.current) {
      toast.error('Canvas cursor is unknown');
      return false;
    }
    return true;
  }, []);

  const beginPlacement = useCallback(
    (mode: Exclude<PlacementMode, null>) => {
      if (!arrangementId) return;
      setParentPickerMode(null);
      setActiveTool('select'); // placement and draw tools are mutually exclusive
      setPlacementMode(mode);
    },
    [arrangementId, setActiveTool]
  );

  // Toggle a draw tool (zone/pen/line). Clears any pending click-to-place mode
  // so the two interaction modes never fight; clicking the active tool exits.
  const toggleTool = useCallback(
    (tool: 'zone' | 'pen' | 'line') => {
      if (!arrangementId) return;
      setPlacementMode(null);
      setActiveTool(activeTool === tool ? 'select' : tool);
    },
    [arrangementId, activeTool, setActiveTool],
  );

  const beginParentPicker = useCallback(
    (childIds: string[]) => {
      if (!arrangementId || childIds.length === 0) return;
      setPlacementMode(null);
      setParentPickerMode({ childIds });
      toast.info(`Click a parent node for ${childIds.length} selected node${childIds.length !== 1 ? 's' : ''}`);
    },
    [arrangementId]
  );

  const openMachinePicker = useCallback(() => {
    if (!arrangementId) return;
    setMachinePickerTemplateId(null);
    setMachinePickerLabel('Machine');
    // Daemon selection is sustained across reopens by useDaemonPicker — if
    // the previously-picked daemon is still online it stays selected, otherwise
    // the hook auto-falls-back to [0]. Don't force-reset here.
    setIsMachinePickerOpen(true);
  }, [arrangementId]);

  // Full canvas reload - unmount and remount the ReactFlow component
  const [canvasKey, setCanvasKey] = useState(0);
  const [isReloading, setIsReloading] = useState(false);

  const handleReloadCanvas = useCallback(() => {
    setIsReloading(true);
    // Clear selection state
    const { nodes } = useCanvasStore.getState();
    const updatedNodes = nodes.map((n) => ({ ...n, selected: false }));
    useCanvasStore.setState({ nodes: updatedNodes, selectedNodeId: null });

    // Brief delay to show loading, then remount
    setTimeout(() => {
      setCanvasKey((k) => k + 1);
      setIsReloading(false);
      toast.success('Canvas reloaded');
    }, 150);
  }, []);

  // Workspace shortcuts (1..9 jump, Alt+1..9 save) live inside useWorkspaces
  // — see WorkspacesButton below. Keep the Esc-cancel binding here because
  // it touches placement-mode state owned by this component.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPlacementMode(null);
        setParentPickerMode(null);
        setIsMachinePickerOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  useEffect(() => {
    if (isMachinePickerOpen && machineTemplates.length === 0) {
      void fetchMachineTemplates();
    }
  }, [fetchMachineTemplates, isMachinePickerOpen, machineTemplates.length]);

  const handlePasteAtCursor = useCallback(() => {
    if (!requireCanvasCursor()) return;
    pasteNodes(getCursorFlowPosition());
  }, [getCursorFlowPosition, pasteNodes, requireCanvasCursor]);

  // When the user picks a template, default the label to the template's name
  // — but auto-number if a machine with that name is already on the canvas.
  // Same family algorithm as branch (Machine 2 → Machine 3), so spawning the
  // same template multiple times yields "foo", "foo 2", "foo 3" rather than
  // three nodes all called "foo". User can still override the value in the
  // input before confirming.
  const handleMachineTemplateSelect = useCallback(
    (templateId: string | null) => {
      setMachinePickerTemplateId(templateId);
      const template = machineTemplates.find((item) => item.id === templateId);
      const base = template?.name || 'Machine';
      // Read nodes lazily at click time so Canvas does not subscribe to
      // `state.nodes` just to compute a label that's only used when the
      // user opens the template picker.
      const existingLabels = useCanvasStore.getState().nodes
        .map((n) => n.data as CanvasNode.UI)
        .filter(CanvasNode.isMachine)
        .map((d) => d.label || '');
      setMachinePickerLabel(MachineLabel.nextLabelInFamily(base, existingLabels));
    },
    [machineTemplates]
  );

  const handleMachinePickerConfirm = useCallback(() => {
    if (!machinePickerDaemonId) {
      return;
    }
    const template = machineTemplates.find((item) => item.id === machinePickerTemplateId);
    beginPlacement({
      kind: 'machine',
      templateId: machinePickerTemplateId,
      label: machinePickerLabel.trim() || template?.name || 'Machine',
      daemonId: machinePickerDaemonId,
    });
    setIsMachinePickerOpen(false);
  }, [beginPlacement, machinePickerLabel, machinePickerTemplateId, machinePickerDaemonId, machineTemplates]);

  const handleCanvasMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const point = { x: event.clientX, y: event.clientY };
      canvasCursorScreenRef.current = point;
      isCursorOnCanvasRef.current = true;

      if (placementMode || parentPickerMode) {
        setPlacementCursorScreen(point);
      }
    },
    [parentPickerMode, placementMode]
  );

  const handleCanvasMouseLeave = useCallback(() => {
    isCursorOnCanvasRef.current = false;
    canvasCursorScreenRef.current = null;
    setPlacementCursorScreen(null);
  }, []);

  const placeAtPoint = useCallback(
    async (point: { x: number; y: number }) => {
      if (!placementMode) return;

      if (placementMode.kind === 'note') {
        createNode(point, '');
        return;
      }

      if (placementMode.kind === 'text') {
        createTextNode(point, 'Heading');
        return;
      }

      if (!placementMode.daemonId) {
        toast.error('No daemon selected — pair one in Settings → Daemons.');
        return;
      }
      await createMachineNodeFromTemplate(
        placementMode.templateId,
        placementMode.daemonId,
        point,
        placementMode.label.trim() || 'Machine'
      );
    },
    [createMachineNodeFromTemplate, createNode, createTextNode, placementMode]
  );

  const handlePaneClick = useCallback(
    async (event: React.MouseEvent | MouseEvent) => {
      if (parentPickerMode) {
        setParentPickerMode(null);
        return;
      }

      if (placementMode) {
        const point =
          getCursorFlowPosition({ x: event.clientX, y: event.clientY }) ?? getCursorFlowPosition();
        if (!point) {
          toast.error('Canvas cursor is unknown');
          return;
        }
        await placeAtPoint(point);
        return;
      }

      onPaneClick();
      windowLayerRef.current?.minimizeAll();
    },
    [getCursorFlowPosition, onPaneClick, parentPickerMode, placeAtPoint, placementMode]
  );

  const handleNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: ReactFlowNode) => {
      if (!parentPickerMode) windowLayerRef.current?.openNode(node.id);
    },
    [parentPickerMode],
  );

  // Drop on canvas: file → USER note, pane → promote TERMINAL. Delegates
  // payload dispatch to the dropOnCanvas use case.
  const handleCanvasDragOver = useCallback((event: React.DragEvent) => {
    const effect = canvasAcceptsDrop(event.dataTransfer.types);
    if (effect) {
      event.preventDefault();
      event.dataTransfer.dropEffect = effect;
    }
  }, []);

  const handleCanvasDrop = useCallback(
    async (event: React.DragEvent) => {
      if (!canvasAcceptsDrop(event.dataTransfer.types)) return;
      event.preventDefault();
      const point = getCursorFlowPosition({ x: event.clientX, y: event.clientY });
      if (!point) {
        toast.error('Canvas cursor is unknown');
        return;
      }
      match(await dropOnCanvas({ dataTransfer: event.dataTransfer, position: point }), {
        ok: ({ what, name }) =>
          toast.success(
            what === 'note-from-file'
              ? `Created note from ${name ?? 'file'}`
              : 'Promoted pane to canvas terminal',
          ),
        refused: ({ reason }) => toast.error(reason),
        fileResult: (fr) => toastForFileResult(fr, toast),
        ignored: () => undefined,
      });
    },
    [getCursorFlowPosition],
  );

  const handleReactFlowNodeClick = useCallback(
    (event: React.MouseEvent, node: ReactFlowNode) => {
      if (!parentPickerMode) {
        onNodeClick(event, node);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const result = setParentForNodes(node.id, parentPickerMode.childIds);
      setParentPickerMode(null);

      if (result.updated > 0) {
        const skipped = result.skipped > 0 ? `, skipped ${result.skipped}` : '';
        toast.success(`Set parent for ${result.updated} node${result.updated !== 1 ? 's' : ''}${skipped}`);
      } else {
        toast.error('Could not set parent without creating a cycle');
      }
    },
    [onNodeClick, parentPickerMode, setParentForNodes]
  );

  const cursorBubbleStyle = useMemo(() => {
    if (!placementCursorScreen || !canvasAreaRef.current) return null;
    const rect = canvasAreaRef.current.getBoundingClientRect();
    return {
      left: placementCursorScreen.x - rect.left + 18,
      top: placementCursorScreen.y - rect.top + 18,
    };
  }, [placementCursorScreen]);

  useKeyboardShortcuts({
    save,
    onPasteAtCursor: handlePasteAtCursor,
    onNewNote: () => beginPlacement({ kind: 'note' }),
    onNewText: () => beginPlacement({ kind: 'text' }),
    onNewMachine: openMachinePicker,
  });

  // One callback factory for every arrangement.config sub-slice. Both
  // ActionsProvider and ModelSelector ship updates through this — they
  // don't need to know about Arrangement.Config or null-arrangement guards.
  const updateConfigSection = useCallback(
    <K extends keyof Arrangement.Config>(key: K) =>
      (value: Arrangement.Config[K] | null) => {
        if (!arrangementId) return;
        const next = Arrangement.Config.withSection(arrangement?.config ?? null, key, value);
        updateArrangementField({ config: next });
      },
    [arrangementId, arrangement, updateArrangementField]
  );

  return (
    <ActionsProvider
      actionsConfig={arrangement?.config?.actions ?? null}
      onActionsConfigChange={updateConfigSection('actions')}
    >
      <ArrangementHotkeyMounter arrangement={arrangement} />
      <div className="relative flex h-full flex-col overflow-hidden bg-[#f6f1e8]">
        <div className="shrink-0 border-b border-stone-200/80 bg-white/85 backdrop-blur-xl">
          <div className="flex items-center gap-2 overflow-x-auto px-4 py-3">
            <ModelSelector
              modelsConfig={arrangement?.config?.models ?? null}
              disabled={!arrangementId}
              onModelsConfigChange={updateConfigSection('models')}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!arrangementId}
              onClick={() => setProjectSettingsOpen(true)}
              title="Project settings (actions, models, system prompt)"
              className={cn(
                'h-8 gap-1.5 bg-white px-3 text-xs shadow-sm',
                ((arrangement?.config !== null && arrangement?.config !== undefined) || arrangement?.systemPrompt) &&
                  'border-amber-300 bg-amber-50 hover:bg-amber-100',
              )}
            >
              <Settings className="h-3.5 w-3.5" />
              Settings
              {((arrangement?.config !== null && arrangement?.config !== undefined) || arrangement?.systemPrompt) && (
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              )}
            </Button>
            <OperationsButton disabled={!arrangementId} />

            <div className="h-6 w-px flex-shrink-0 bg-stone-200" />

            <CanvasInspector
              reactFlowInstance={reactFlowInstance}
              onStartSetParent={beginParentPicker}
              disabled={!arrangementId}
            />

            <div className="h-6 w-px flex-shrink-0 bg-stone-200" />

            <div className="flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-1 py-1">
              <Button
                variant={placementMode?.kind === 'note' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 w-7 rounded-full p-0"
                onClick={() => beginPlacement({ kind: 'note' })}
                disabled={!arrangementId}
                title="Add node at cursor (N)"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={placementMode?.kind === 'text' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 w-7 rounded-full p-0"
                onClick={() => beginPlacement({ kind: 'text' })}
                disabled={!arrangementId}
                title="Add text at cursor (T)"
              >
                <Type className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={placementMode?.kind === 'machine' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 w-7 rounded-full p-0"
                onClick={openMachinePicker}
                disabled={!arrangementId}
                title="Add machine at cursor (M)"
              >
                <Server className="h-3.5 w-3.5" />
              </Button>

              {/* Drawing tools: drag on the canvas to create. Zone = a resizable
                  rectangle to group/organize; Pen = freehand; Line = straight. */}
              <div className="mx-0.5 h-5 w-px flex-shrink-0 bg-stone-200" />
              <Button
                variant={activeTool === 'zone' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 w-7 rounded-full p-0"
                onClick={() => toggleTool('zone')}
                disabled={!arrangementId}
                title="Zone — drag to draw a grouping rectangle"
              >
                <Frame className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={activeTool === 'pen' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 w-7 rounded-full p-0"
                onClick={() => toggleTool('pen')}
                disabled={!arrangementId}
                title="Pen — freehand drawing"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={activeTool === 'line' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 w-7 rounded-full p-0"
                onClick={() => toggleTool('line')}
                disabled={!arrangementId}
                title="Line — drag to draw a straight line"
              >
                <Slash className="h-3.5 w-3.5" />
              </Button>
              {placementMode ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 rounded-full p-0"
                  onClick={() => setPlacementMode(null)}
                  title="Cancel placement (Esc)"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button
                variant={windowStats.canUngroup ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => windowLayerRef.current?.toggleGroup()}
                disabled={!windowStats.canGroup && !windowStats.canUngroup}
                title={
                  windowStats.canUngroup
                    ? 'Ungroup windows — minimize/restore will stop cascading'
                    : 'Group the currently open windows — minimize/restore will cascade together, and restoring the group will minimize any other open windows'
                }
                className="h-8 gap-1.5 rounded-full px-3 text-xs"
              >
                <Layers className="h-3.5 w-3.5" />
                {windowStats.canUngroup
                  ? `Ungroup (${windowStats.open})`
                  : `Group (${windowStats.open})`}
              </Button>
              {/* Sits next to Group because both control "how the canvas is being
                  viewed right now" — workspaces are saved viewports, group is
                  the windowing mode for them. */}
              <WorkspacesButton
                arrangementId={arrangementId}
                reactFlowInstance={reactFlowInstance}
                disabled={!arrangementId}
              />
              <SyncStatusIndicator />
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReloadCanvas}
                disabled={isReloading}
                title="Reload canvas (fixes stuck states)"
                className="h-8 w-8 rounded-full p-0"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div
          ref={canvasAreaRef}
          className={cn('relative flex-1', (placementMode || parentPickerMode) && 'cursor-crosshair')}
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={handleCanvasMouseLeave}
          style={{ '--canvas-zoom': 1 } as CSSProperties}
        >
          {isReloading ? (
            <div className="animate-in fade-in flex h-full flex-1 flex-col items-center justify-center bg-gradient-to-b from-gray-50 to-gray-100 duration-150">
              <div className="relative">
                <div
                  className="absolute inset-0 rounded-full bg-emerald-400/20"
                  style={{ animationDuration: '1s' }}
                />
                <div className="relative rounded-full border border-gray-100 bg-white p-4 shadow-lg">
                  <RefreshCw
                    className="h-6 w-6 text-emerald-500"
                    style={{ animationDuration: '0.8s' }}
                  />
                </div>
              </div>
              <p className="mt-4 text-sm font-medium text-gray-500">Refreshing canvas...</p>
            </div>
          ) : (
            <>
              <ReactFlowCanvasInner
                canvasKey={canvasKey}
                selectedNodeId={selectedNodeId}
                hiddenNodeIds={hiddenNodeIds}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={handleReactFlowNodeClick}
                onNodeDoubleClick={handleNodeDoubleClick}
                onPaneClick={handlePaneClick}
                onNodeDragStop={onNodeDragStop}
                onDragOver={handleCanvasDragOver}
                onDrop={handleCanvasDrop}
                validateConnection={validateConnection}
                onInit={setReactFlowInstance}
                arrangementId={arrangementId}
                zoomVarTargetRef={canvasAreaRef}
              />

              <CanvasWindowLayer
                ref={windowLayerRef}
                arrangementId={arrangementId}
                persistenceReady={windowsPersistenceReady}
                selectedNodeId={selectedNodeId}
                reactFlowInstance={reactFlowInstance}
                onStatsChange={setWindowStats}
              />

              {/* Single host for all per-node action dialogs (label / color /
                  tags / ancestors). Any surface's 3-dot menu opens them via
                  the unified registry; see lib/node-actions.tsx. */}
              <NodeDialogsHost />

              {(placementMode || parentPickerMode) && cursorBubbleStyle && isCursorOnCanvasRef.current ? (
                <div
                  className="pointer-events-none absolute"
                  style={{ ...cursorBubbleStyle, zIndex: Z.placementBubble }}
                >
                  <div className="flex items-center gap-2 rounded-full border border-stone-300 bg-white/96 px-3 py-2 text-xs font-medium text-stone-700 shadow-sm backdrop-blur">
                    {parentPickerMode ? <CornerDownRight className="h-3.5 w-3.5" /> : null}
                    {placementMode?.kind === 'note' ? <Square className="h-3.5 w-3.5" /> : null}
                    {placementMode?.kind === 'text' ? <Type className="h-3.5 w-3.5" /> : null}
                    {placementMode?.kind === 'machine' ? <Server className="h-3.5 w-3.5" /> : null}
                    <span>
                      {parentPickerMode
                        ? `Choose parent for ${parentPickerMode.childIds.length}`
                        : `Place ${placementLabel(placementMode)}`}
                    </span>
                  </div>
                </div>
              ) : null}
            </>
          )}

          <Dialog open={isMachinePickerOpen} onOpenChange={setIsMachinePickerOpen}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Select Machine</DialogTitle>
              </DialogHeader>

              <div className="grid gap-3">
                {/* Sequential picker: daemon first, then templates filtered
                    to that host. Templates store their overlay files on a
                    specific daemon — spawning across daemons would 404, so
                    picking the host first surfaces only what can actually
                    materialise. */}
                <div className="grid gap-2">
                  <div className="text-sm font-medium text-stone-700">1. Host daemon</div>
                  {onlineDaemons.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-amber-300 bg-amber-50 px-4 py-3 text-xs text-stone-700">
                      <div className="font-medium text-amber-700">No daemons online</div>
                      <div className="mt-1">
                        Pair one in <span className="font-medium">Settings → Daemons</span> to
                        run machines. Without a daemon there&apos;s nowhere to host the container.
                      </div>
                    </div>
                  ) : (
                    <div className="grid max-h-[140px] gap-2 overflow-y-auto pr-1">
                      {onlineDaemons.map((daemon) => (
                        <button
                          key={daemon.id}
                          type="button"
                          className={cn(
                            'flex items-center justify-between rounded-2xl border px-4 py-2 text-left transition',
                            machinePickerDaemonId === daemon.id
                              ? 'border-stone-900 bg-stone-900 text-white'
                              : 'border-stone-200 bg-stone-50 hover:border-stone-300 hover:bg-stone-100'
                          )}
                          onClick={() => setMachinePickerDaemonId(daemon.id)}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
                            <span className="truncate font-medium">{daemon.name}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid gap-2">
                  <div className="text-sm font-medium text-stone-700">
                    2. Template
                    {!machinePickerDaemonId ? (
                      <span className="ml-2 text-xs font-normal text-stone-500">— pick a host first</span>
                    ) : null}
                  </div>
                  <div className={cn(
                    'grid max-h-[280px] gap-2 overflow-y-auto pr-1',
                    !machinePickerDaemonId && 'pointer-events-none opacity-50',
                  )}>
                    <button
                      type="button"
                      className={cn(
                        'flex items-start justify-between rounded-2xl border px-4 py-3 text-left transition',
                        machinePickerTemplateId === null
                          ? 'border-stone-900 bg-stone-900 text-white'
                          : 'border-stone-200 bg-stone-50 hover:border-stone-300 hover:bg-stone-100'
                      )}
                      onClick={() => handleMachineTemplateSelect(null)}
                    >
                      <div>
                        <div className="font-medium">Blank machine</div>
                        <div
                          className={cn(
                            'text-xs',
                            machinePickerTemplateId === null ? 'text-stone-300' : 'text-stone-500'
                          )}
                        >
                          Start without a template
                        </div>
                      </div>
                    </button>

                    {machineTemplates
                      .filter((template) => !machinePickerDaemonId || MachineTemplate.isAvailableOn(template, machinePickerDaemonId))
                      .map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        className={cn(
                          'flex items-start justify-between rounded-2xl border px-4 py-3 text-left transition',
                          machinePickerTemplateId === template.id
                            ? 'border-stone-900 bg-stone-900 text-white'
                            : 'border-stone-200 bg-stone-50 hover:border-stone-300 hover:bg-stone-100'
                        )}
                        onClick={() => handleMachineTemplateSelect(template.id)}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">{template.name}</div>
                          <div
                            className={cn(
                              'mt-1 text-xs',
                              machinePickerTemplateId === template.id
                                ? 'text-stone-300'
                                : 'text-stone-500'
                            )}
                          >
                            {template.description || 'No description'}
                            {template.daemonId === null ? (
                              <span className="ml-2 inline-block rounded bg-amber-200/50 px-1.5 py-0.5 text-[10px] text-amber-700">legacy</span>
                            ) : null}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-2">
                  <div className="text-sm font-medium text-stone-700">Label</div>
                  <Input
                    value={machinePickerLabel}
                    onChange={(event) => setMachinePickerLabel(event.target.value)}
                    placeholder="Machine label"
                  />
                </div>
              </div>

              <DialogFooter className="gap-2 sm:justify-end">
                <Button variant="ghost" onClick={() => setIsMachinePickerOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleMachinePickerConfirm} disabled={!machinePickerDaemonId}>
                  Arm placement
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <ProjectSettingsOverlay
          open={projectSettingsOpen}
          onClose={() => setProjectSettingsOpen(false)}
          arrangement={(arrangement as Arrangement.Model) ?? null}
          modelsConfig={arrangement?.config?.models ?? null}
          onModelsConfigChange={updateConfigSection('models')}
          onSystemPromptSave={(systemPrompt) => updateArrangementField({ systemPrompt })}
        />
      </div>
    </ActionsProvider>
  );
}

// Export with memo to prevent re-renders when parent components change
export const Canvas = memo(CanvasComponent);
