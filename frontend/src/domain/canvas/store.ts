// Canvas UI state only - no server data, no business logic
import { create } from 'zustand';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { produce, enableMapSet } from 'immer';
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type NodeChange,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type Connection,
  type Node,
  type Edge as ReactFlowEdge,
} from '@xyflow/react';
import { ArrangementService } from '@/domain/arrangement/services';
import { TemplateService } from '@/domain/machine-center/services';
import { MachineService } from '@/domain/machine/services';
import { useMachineCenterStore } from '@/domain/machine-center/store';
import { CanvasNode, CanvasEdge, CanvasState, MachineLabel, type CanvasTool } from './types';
import { cleanupOrphanPanes } from './components/MachineWindow/use-cases';
import { useMachineWindowStore } from './components/MachineWindow/store';
import { MachineWindow } from '@piano/shared';

/** Cast `node.data` to our discriminated union for type-narrowed access. */
const asUI = (data: unknown): CanvasNode.UI => data as CanvasNode.UI
import { readSavedCollapse, writeSavedCollapse } from './lib/collapse-persistence';
import { readCanvasContext, writeCanvasContext } from './lib/canvas-context-persistence';
import { sortNodesByReadingOrder } from './lib/reading-order';
import { Union } from '@/lib/types';
import { Analytics } from '@/lib/analytics';
import { copyToClipboard } from '@/lib/utils';
import {
  Arrangement,
  Note,
  Edge as EdgeModel,
  Canvas,
  LLM,
  Clipboard,
  clearOrphanedNodes,
  filterRootNodes,
  topologicalSort,
} from '@piano/shared';
import dagre from 'dagre';
import { toast } from 'sonner';

enableMapSet();

// Module-level tracking for dragged nodes (outside store to avoid Immer freezing)
const _lastDraggedNodeIds = new Set<string>();

/**
 * Custom equality function for `useCanvasStore(s => s.nodes, areNodesStructurallyEqual)`.
 *
 * Returns true when the two arrays differ ONLY by node positions — meaning
 * the subscriber's UI depends on structural state (ids, data, selection,
 * hidden, parentage) but not on where the nodes are drawn on the canvas.
 * Zustand uses this to decide whether to notify the subscriber: equal →
 * skip notify → no re-render. The dragged-node ref change every pointer
 * tick stops cascading through dropdowns / nav buttons / anything else
 * that doesn't care about position.
 *
 * React Flow's applyNodeChanges for a position update returns a new node
 * via `{...n, position: newPos}`: ref differs, but `data` ref and all
 * other fields are preserved. That's exactly what we check below.
 *
 * Used by every subscriber that doesn't need live positions. The Canvas
 * itself stays on the default equality (===) because React Flow needs
 * the new array refs to repaint the moved node.
 */
export function areNodesStructurallyEqual(a: Node[], b: Node[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const an = a[i];
    const bn = b[i];
    if (an.id !== bn.id) return false;
    if (an.data !== bn.data) return false;
    if (an.hidden !== bn.hidden) return false;
    if (an.selected !== bn.selected) return false;
    if (an.parentId !== bn.parentId) return false;
  }
  return true;
}

function isInteractiveNodeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest(
    'button, input, textarea, select, a, [contenteditable="true"], [data-node-action], [role="button"]'
  );
}

/**
 * Normalize nodes for history storage by excluding ephemeral runtime fields.
 * This prevents undo/redo from restoring transient states like "running" status.
 *
 * For ASSISTANT nodes we strip `status` (runtime execution state) but KEEP
 * `content`: when an ASSISTANT node is alive, `mergeRuntimeState` overrides
 * history's content with the current one, so AI-generated content stays
 * authoritative. When the node has been DELETED and we're restoring it via
 * undo, there's no current source to merge from — keeping content in history
 * is the only way resurrection isn't a content wipe.
 */
function normalizeNodesForHistory(nodes: Node[]): Node[] {
  return produce(nodes, (draft) => {
    draft.forEach((node) => {
      const isAssistant = (node.data.type as string) === 'ASSISTANT';
      if (isAssistant) {
        delete node.data.status;
      }
    });
  });
}

/**
 * Merge runtime state from current nodes into restored historical nodes.
 * Preserves status/content of assistant nodes during undo/redo.
 */
function mergeRuntimeState(historicalNodes: Node[], currentNodes: Node[]): Node[] {
  const currentNodeMap = new Map(currentNodes.map((n) => [n.id, n]));

  return produce(historicalNodes, (draft) => {
    draft.forEach((node) => {
      const isAssistant = (node.data.type as string) === 'ASSISTANT';
      const currentNode = currentNodeMap.get(node.id);

      if (isAssistant && currentNode) {
        node.data.status = currentNode.data.status;
        node.data.content = currentNode.data.content;
      }
    });
  });
}

/**
 * Undo/redo operates ONLY on `syncable` notes (see `Note.capabilities`).
 * Non-syncable types (MACHINE / TERMINAL) are owned by the daemon — undoing
 * a freshly-created machine or resurrecting a frozen one has no reverse
 * operation on the daemon side, so they bypass history entirely. Same goes
 * for edges that touch them: dropping such an edge on undo would orphan
 * the daemon side.
 *
 * `partitionByDaemon` splits the canvas into "tracked" (history-managed)
 * and "untracked" (daemon-owned, passed through unchanged on undo/redo).
 */
const isSyncableNode = (node: Node): boolean =>
  Note.capabilities({ type: node.data.type as Note.Type }).syncable;

function partitionByDaemon(
  nodes: Node[],
  edges: ReactFlowEdge[]
): {
  trackedNodes: Node[];
  untrackedNodes: Node[];
  trackedEdges: ReactFlowEdge[];
  untrackedEdges: ReactFlowEdge[];
} {
  const trackedNodes: Node[] = [];
  const untrackedNodes: Node[] = [];
  for (const n of nodes) {
    if (isSyncableNode(n)) trackedNodes.push(n);
    else untrackedNodes.push(n);
  }
  const untrackedIds = new Set(untrackedNodes.map((n) => n.id));
  const trackedEdges: ReactFlowEdge[] = [];
  const untrackedEdges: ReactFlowEdge[] = [];
  for (const e of edges) {
    if (untrackedIds.has(e.source) || untrackedIds.has(e.target)) untrackedEdges.push(e);
    else trackedEdges.push(e);
  }
  return { trackedNodes, untrackedNodes, trackedEdges, untrackedEdges };
}

/**
 * Universal diff utility - compares two canvas states and returns all changed entities.
 * This is the SINGLE SOURCE OF TRUTH for detecting changes.
 * Works for ANY property changes without manual checking.
 */
function diffCanvasStates(
  oldNodes: Node[],
  newNodes: Node[],
  oldEdges: ReactFlowEdge[],
  newEdges: ReactFlowEdge[]
): {
  changedNodeIds: string[];
  changedEdgeIds: string[];
} {
  const changedNodeIds: string[] = [];
  const changedEdgeIds: string[] = [];

  const oldNodeMap = new Map(oldNodes.map((n) => [n.id, n]));
  const newNodeMap = new Map(newNodes.map((n) => [n.id, n]));
  const oldEdgeMap = new Map(oldEdges.map((e) => [e.id, e]));
  const newEdgeMap = new Map(newEdges.map((e) => [e.id, e]));

  // Check all new nodes (added or modified)
  newNodes.forEach((newNode) => {
    const oldNode = oldNodeMap.get(newNode.id);
    if (!oldNode) {
      // Node was added
      changedNodeIds.push(newNode.id);
    } else {
      // Node exists - compare by stringifying (catches ANY property change)
      if (JSON.stringify(oldNode) !== JSON.stringify(newNode)) {
        changedNodeIds.push(newNode.id);
      }
    }
  });

  // Check removed nodes
  oldNodes.forEach((oldNode) => {
    if (!newNodeMap.has(oldNode.id)) {
      changedNodeIds.push(oldNode.id);
    }
  });

  // Check all new edges (added or modified)
  newEdges.forEach((newEdge) => {
    const oldEdge = oldEdgeMap.get(newEdge.id);
    if (!oldEdge) {
      // Edge was added
      changedEdgeIds.push(newEdge.id);
    } else {
      // Edge exists - compare by stringifying (catches ANY property change)
      if (JSON.stringify(oldEdge) !== JSON.stringify(newEdge)) {
        changedEdgeIds.push(newEdge.id);
      }
    }
  });

  // Check removed edges
  oldEdges.forEach((oldEdge) => {
    if (!newEdgeMap.has(oldEdge.id)) {
      changedEdgeIds.push(oldEdge.id);
    }
  });

  return { changedNodeIds, changedEdgeIds };
}

interface HistoryState {
  nodes: Node[];
  edges: ReactFlowEdge[];
}

// Per-arrangement local snapshot — preserved across tab switches so that
// returning to an arrangement restores the user's exact in-progress state
// (nodes, edges, undo history) instead of re-loading from a stale RQ cache.
// See `setArrangementId` for the save/restore flow.
interface ArrangementSnapshot {
  nodes: Node[];
  edges: ReactFlowEdge[];
  history: HistoryState[];
  currentHistoryIndex: number;
}
interface CanvasStore {
  // Canvas UI State
  arrangementId: string | null;
  nodes: Node[];
  edges: ReactFlowEdge[];
  hasUnsavedChanges: boolean;
  selectedNodeId: string | null;
  isLoadingCanvas: boolean;
  isSyncing: boolean;

  // Copy/paste state
  clipboardData: Clipboard.Data | null; // For node-level copy/paste
  copiedContent: string | null; // For content-level copy/paste within nodes

  runningNodes: Map<string, string>; // Map<optimisticNodeId, sourceNodeId>
  // When a node entered RUNNING state, in ms (Date.now()). Used by deleteNode
  // for a short grace-window so a hot-finger click right after Run doesn't
  // delete the node before the user even sees it kick off. After the window
  // elapses, deletion is fully allowed even if the node is still running —
  // the backend will discard a late AI response for a missing target.
  runStartedAt: Map<string, number>;
  // Parent machine nodes currently being branched. Ephemeral UI state only:
  // key = parentNodeId, value = Date.now() when the branch request started.
  branchingNodes: Map<string, number>;
  selectedModel: LLM.ModelId;

  // Dirty tracking for optimistic sync — TWO-PHASE: an edit lands in `dirty*`
  // first; on sync start `beginSync()` MOVES those entries to `dirtyInFlight*`
  // and `dirty*` becomes ∅ ready to capture any new edits that happen WHILE
  // the PATCH is still in flight (e.g. Ctrl+Z mid-sync). Success clears only
  // the in-flight set, so concurrent edits survive and trigger the next sync.
  dirtyEntityIds: Set<string>;
  dirtyEntityTypes: Map<string, 'node' | 'edge'>;
  dirtyInFlightIds: Set<string>;
  dirtyInFlightTypes: Map<string, 'node' | 'edge'>;
  // Subset of dirty node ids whose removal is a DEMOTION (canvas TERMINAL
  // moving into a machine-window pane) rather than a destructive delete.
  // useCanvasSync routes these into PatchPayload.demotedNodeIds so the
  // backend skips the `command:delete` daemon RPC.
  demotedNodeIds: Set<string>;
  lastChangeTimestamp: number; // Updates on EVERY change, even if entity already dirty

  // Per-arrangement local snapshots — see ArrangementSnapshot above.
  arrangementSnapshots: Map<string, ArrangementSnapshot>;

  // React Flow viewport helper
  getViewportCenter: (() => { x: number; y: number }) | null;

  // Viewport zoom — wheel & chip slider both write here; spawn-paths read it.
  canvasZoom: number;
  setCanvasZoom: (zoom: number) => void;
  // Registered by Canvas once React Flow mounts; the top-bar chip uses it
  // to drive zoom without holding its own RF instance.
  imperativeZoomTo: ((zoom: number, opts?: { duration?: number }) => void) | null;
  setImperativeZoomTo: (fn: ((zoom: number, opts?: { duration?: number }) => void) | null) => void;

  // Layer context. Spawn paths inherit activeLayer; render filter checks
  // visibleLayers ∋ note.layers; knownLayers is the user's intent set so a
  // freshly-created empty layer survives a reload. All persisted together.
  activeLayer: string | null;
  setActiveLayer: (layer: string | null) => void;
  visibleLayers: Set<string>;
  setVisibleLayers: (layers: Set<string>) => void;
  toggleVisibleLayer: (layer: string) => void;
  knownLayers: Set<string>;
  registerLayer: (layer: string) => void;
  // Global (`note.layers === []`) gets its own visibility toggle so the
  // user can focus on a single named layer without globals leaking in.
  globalVisible: boolean;
  toggleGlobalVisible: () => void;


  // Child node positioning config
  childNodeOffset: { x: number; y: number };

  // Undo/Redo State
  history: HistoryState[];
  currentHistoryIndex: number;

  // Canvas UI Actions
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onNodeClick: (_event: React.MouseEvent, node: Node) => void;
  onPaneClick: () => void;
  onNodeDragStop: (_event: React.MouseEvent, node: Node) => void;

  // Node management
  createNode: (
    position?: { x: number; y: number } | null,
    content?: string,
    scale?: number,
    /** Explicit layer membership. Omit to inherit `activeLayer` (or global). */
    layers?: string[],
  ) => string | null;
  // Add a child node below `parentId` (the "+" button under a note). Two
  // layout modes (Task 22):
  //   - parent has children but NO grandchildren → re-distribute all
  //     children (incl. the new one) horizontally so they read as a row
  //   - parent has grandchildren → drop at default offset, then bump
  //     +20,+20 until clear of any other node (stack effect)
  // Returns the new node id, or null on failure.
  addChildBelow: (parentId: string) => string | null;
  createTextNode: (position?: { x: number; y: number } | null, content?: string) => string | null;
  // Drawing tools. `activeTool` drives the DrawingLayer; create* commit the
  // gesture as a persisted ZONE/DRAWING node (box in flow coords).
  activeTool: CanvasTool;
  setActiveTool: (tool: CanvasTool) => void;
  createZone: (box: { x: number; y: number; width: number; height: number }) => string | null;
  createDrawing: (
    box: { x: number; y: number; width: number; height: number },
    drawing: Note.DrawingStyle,
  ) => string | null;
  createMachineNode: (
    position?: { x: number; y: number } | null,
    label?: string
  ) => { nodeId: string; machineId: string } | null;
  createMachineNodeFromTemplate: (
    templateId: string | null,
    daemonId: string,
    position?: { x: number; y: number } | null,
    label?: string
  ) => Promise<{ nodeId: string; machineId: string } | null>;
  setNodeStatus: (nodeId: string, status: string) => void;
  freezeMachine: (nodeId: string, name?: string) => Promise<void>;
  branchMachine: (parentNodeId: string, branchName?: string) => Promise<{ nodeId: string; machineId: string } | null>;
  createTerminal: (machineNodeId: string) => Promise<{ nodeId: string; machineId: string } | null>;
  // Promote an existing in-window pane to a canvas-level TERMINAL node.
  // The daemon pane stays as-is; we just add a TERMINAL Note pointing at it.
  // Caller (drop-on-canvas) is responsible for removing the pane from the
  // source MachineWindow.Layout afterwards.
  promotePane: (
    paneId: string,
    parentMachineNodeId: string,
    position: { x: number; y: number },
  ) => string | null;
  // Inverse of promotePane: capture an existing canvas TERMINAL node's
  // paneId + label, then delete the node (daemon pane survives — it's
  // about to be embedded in a window).
  demoteTerminal: (terminalNodeId: string) => { paneId: string; label: string } | null;
  addNodes: (nodes: Node[]) => void;
  deleteNode: (nodeId: string) => void;
  duplicateNode: (nodeId: string) => void;
  updateNodeContent: (nodeId: string, _arrangementId: string, content: string) => void;
  updateNodeLabel: (nodeId: string, label: string | null) => void;
  updateNodeColor: (nodeId: string, color: string | null) => void;
  // Cache config is written by NoteCacheService on success; this just
  // updates the canvas so the badge reflects the new state without a refetch.
  updateNodeCacheConfig: (nodeId: string, cacheConfig: any | null) => void;
  updateNodeTags: (nodeId: string, tags: string[]) => void;
  updateNodeStyle: (nodeId: string, style: Record<string, any> | null) => void;
  updateNodeScale: (nodeId: string, scale: number) => void;
  updateNodeAncestorOverride: (nodeId: string, ancestorIds: string[]) => void;
  updateNodeSize: (nodeId: string, width: number, height: number) => void;
  toggleNodePinned: (nodeId: string) => void;
  // Lock a shape (ZONE / DRAWING) in place: flips `style.locked`. The Canvas
  // decoration reads it to set the node's `draggable`. Persists via `style`.
  toggleNodeLocked: (nodeId: string) => void;
  toggleNodeMergePoint: (nodeId: string) => void;

  // Subtree collapse — IMPERATIVE model. Each click on a node walks its
  // descendants and writes the `hidden` flag directly on `hiddenNodeIds`;
  // visibility is NOT derived from a propagation BFS. The button's three-
  // state cycle ('recursive' / 'single' / absent) is purely a memo of "what
  // does the next click do" — it never participates in visibility
  // computation. Last click on any subtree wins.
  //
  // Cycle (label = next click's effect):
  //   absent      → "Hide all descendants"   → hides everything below
  //   'recursive' → "Show direct children only" → reveals direct, hides deeper
  //   'single'    → "Show all descendants"   → reveals subtree, resets cycle
  hiddenNodeIds: Set<string>;
  collapsedNodeIds: Set<string>;
  collapseStates: Map<string, 'recursive' | 'single'>;
  toggleCollapsed: (nodeId: string) => void;
  uncollapseNode: (nodeId: string) => void;

  // Bulk operations
  bulkUpdateLabel: (nodeIds: string[], label: string | null) => void;
  bulkAddTags: (nodeIds: string[], tags: string[]) => void;
  bulkUpdateColor: (nodeIds: string[], color: string | null) => void;
  /** Replace layer membership wholesale on each node. `[]` = global. */
  bulkUpdateLayers: (nodeIds: string[], layers: string[]) => void;
  bulkUpdateScale: (
    nodeIds: string[],
    scale: number,
    options?: {
      referenceScale?: number;
      referencePositions?: Record<string, { x: number; y: number }>;
      transient?: boolean;
      skipHistoryBefore?: boolean;
    }
  ) => void;

  // Copy/paste/cut
  copySelectedNodes: () => void;
  cutSelectedNodes: () => void;
  pasteNodes: (position?: { x: number; y: number } | null) => void;

  // Text-level copy helpers (branch/selection → system clipboard as plain text)
  copyBranchText: (nodeId: string) => Promise<void>;
  copySelectedNodesAsText: () => Promise<void>;

  // Selection helpers (tree traversal)
  selectDescendants: (nodeId: string, includeSelf?: boolean) => void;
  selectAncestors: (nodeId: string, includeSelf?: boolean) => void;
  selectByTag: (tag: string) => void;

  // Compact / expand — scales node positions around the centroid
  compactCanvas: (
    factor: number,
    referencePositions?: Record<string, { x: number; y: number }>,
    nodeIds?: string[],
    options?: { transient?: boolean }
  ) => void;

  // Alignment / distribution for selected (or given) nodes
  alignSelection: (
    mode: 'horizontal-line' | 'vertical-line' | 'grid' | 'distribute-h' | 'distribute-v',
    nodeIds?: string[]
  ) => void;

  // Disconnect the given nodes from everything else and chain them in reading
  // order (top-to-bottom, left-to-right). Returns the number of edges created.
  connectSelected: (nodeIds: string[]) => number;
  setParentForNodes: (parentId: string, childIds: string[]) => { updated: number; skipped: number };

  // Content clipboard (for text within nodes)
  setCopiedContent: (content: string) => void;
  getCopiedContent: () => string | null;

  // Running state
  setNodeRunning: (nodeId: string, isRunning: boolean) => void;
  runNode: (nodeId: string, actionId: string) => Promise<void>;
  createChildFromSelection: (sourceNodeId: string, selectedText: string) => void;

  // Canvas state management
  setArrangementId: (id: string | null) => void;
  loadCanvasState: (nodes: Node[], edges: ReactFlowEdge[]) => void;
  clearCanvas: () => void;
  setHasUnsavedChanges: (value: boolean) => void;
  clearSelectedNode: () => void;
  setGetViewportCenter: (fn: (() => { x: number; y: number }) | null) => void;
  autoLayout: (direction?: 'LR' | 'TB', nodeIds?: string[]) => void;

  // Model selection
  setSelectedModel: (model: LLM.ModelId) => void;

  // Dirty tracking actions
  setDirty: (entityId: string, isDirty: boolean, type?: 'node' | 'edge') => void;
  // Mark a node id whose pending deletion is actually a DEMOTION (terminal
  // moving into a machine-window pane). Caller still calls setDirty(id) —
  // setDemoted only tags it so useCanvasSync routes it as a demotion, sparing
  // the daemon pane.
  setDemoted: (nodeId: string) => void;
  clearDemoted: (ids: string[]) => void;
  clearDirty: (ids: string[]) => void;
  clearAllDirty: () => void;
  setIsSyncing: (isSyncing: boolean) => void;

  // Two-phase sync coordination — see the dirty-tracking field comment.
  /** Move all current `dirty*` entries into `dirtyInFlight*`. Returns the
   *  snapshot so the caller can build the PATCH payload from a stable list
   *  even if `dirty*` changes mid-sync. */
  beginSync: () => { ids: string[]; types: Map<string, 'node' | 'edge'> };
  /** Drop the given IDs from `dirtyInFlight*`. Any in-flight IDs that the
   *  backend did NOT acknowledge are merged BACK into `dirty*` so the next
   *  sync round retries them. `patchArrangementId` is the arrangement the
   *  PATCH was sent for: if the user switched tabs mid-flight, it won't
   *  match the current arrangement and the remaining items are dropped
   *  rather than polluting the new arrangement's dirty set. */
  endSyncSuccess: (patchArrangementId: string, processedIds: string[]) => void;
  /** Whole sync failed (network error). Merge `dirtyInFlight*` back into
   *  `dirty*` for retry. See `endSyncSuccess` for `patchArrangementId` rules. */
  endSyncFailure: (patchArrangementId: string) => void;

  // Undo/Redo actions
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

// Generate unique ID for new nodes
const generateNodeId = () => `node_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

// Mirrors Note.DTO.UpdateSchema (min 0.1, max 10). Viewport zoom can run past
// 10×, so we clamp before persisting or the patch endpoint will reject.
const NODE_SCALE_MIN = 0.1;
const NODE_SCALE_MAX = 10.0;
const clampNodeScale = (s: number): number =>
  Math.min(NODE_SCALE_MAX, Math.max(NODE_SCALE_MIN, s));

// 1/zoom so screen-size ≈ constant: zoomed out → big inherent scale,
// zoomed in → small. Branched/child spawns inherit from parent instead.
const inherentScaleForCurrentZoom = (viewportZoom: number): number =>
  clampNodeScale(1 / viewportZoom);

// Flush current collapse state to localStorage under the current
// arrangement key. Called after every toggle / uncollapse so a reload
// (or tab close) restores exactly what the user was looking at.
function persistCollapseForCurrentArrangement(state: {
  arrangementId: string | null;
  hiddenNodeIds: Set<string>;
  collapseStates: Map<string, 'recursive' | 'single'>;
}) {
  if (!state.arrangementId) return;
  writeSavedCollapse(state.arrangementId, {
    hidden: [...state.hiddenNodeIds],
    states: [...state.collapseStates.entries()],
  });
}

// Each setter passes only the keys it just changed; we serialise the
// post-mutation values without re-reading possibly-uncommitted immer state.
function persistCanvasContextFor(
  prev: {
    arrangementId: string | null;
    activeLayer: string | null;
    visibleLayers: Set<string>;
    knownLayers: Set<string>;
    globalVisible: boolean;
  },
  patch: Partial<{
    activeLayer: string | null;
    visibleLayers: Set<string>;
    knownLayers: Set<string>;
    globalVisible: boolean;
  }>,
) {
  if (!prev.arrangementId) return;
  writeCanvasContext(prev.arrangementId, {
    activeLayer: 'activeLayer' in patch ? (patch.activeLayer ?? null) : prev.activeLayer,
    visibleLayers: [...(patch.visibleLayers ?? prev.visibleLayers)],
    knownLayers: [...(patch.knownLayers ?? prev.knownLayers)],
    globalVisible: patch.globalVisible ?? prev.globalVisible,
  });
}

// One-shot graph walk for collapse clicks. Used by toggleCollapsed and
// uncollapseNode — both need direct children + all descendants of a node.
// Built per-call rather than memoised: clicks are rare and the edge list
// is small, so the simpler code wins.
function collectDescendants(
  nodeId: string,
  edges: ReactFlowEdge[]
): { directChildren: Set<string>; allDescendants: Set<string> } {
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    const list = childrenOf.get(e.source) ?? [];
    list.push(e.target);
    childrenOf.set(e.source, list);
  }
  const directChildren = new Set(childrenOf.get(nodeId) ?? []);
  const allDescendants = new Set<string>();
  const queue = [...directChildren];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (allDescendants.has(id)) continue;
    allDescendants.add(id);
    for (const c of childrenOf.get(id) ?? []) queue.push(c);
  }
  return { directChildren, allDescendants };
}

// Grace window in ms after a node enters RUNNING state during which delete
// is suppressed. Defends against a hot-finger click right after pressing
// Run. Past the window, the backend gracefully drops late AI responses for
// missing targets (see action/worker.ts → onUserDeleted), so we don't need
// any longer protection here.
export const RUN_DELETE_GRACE_MS = 3000;

const useCanvasStoreBase = create<CanvasStore>((set, get) => ({
  // Initial state
  arrangementId: null,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  clipboardData: null,
  copiedContent: null,
  hasUnsavedChanges: false,
  isLoadingCanvas: false,
  runningNodes: new Map(),
  runStartedAt: new Map(),
  branchingNodes: new Map(),
  dirtyEntityIds: new Set(),
  dirtyEntityTypes: new Map(),
  dirtyInFlightIds: new Set(),
  dirtyInFlightTypes: new Map(),
  demotedNodeIds: new Set(),
  arrangementSnapshots: new Map(),
  lastChangeTimestamp: 0,
  isSyncing: false,
  getViewportCenter: null,
  canvasZoom: 1,
  setCanvasZoom: (zoom) =>
    set((state) => (Math.abs(state.canvasZoom - zoom) < 0.0005 ? state : { canvasZoom: zoom })),
  imperativeZoomTo: null,
  setImperativeZoomTo: (fn) => set({ imperativeZoomTo: fn }),

  // Persisted per arrangement; hydrated in setArrangementId.
  activeLayer: null,
  setActiveLayer: (layer) =>
    set((state) => {
      // Activating null = "go global" — also force globalVisible so newly
      // spawned notes land somewhere visible.
      if (!layer) {
        const next = { activeLayer: null, globalVisible: true };
        persistCanvasContextFor(state, next);
        return next;
      }
      // Active layer must always be visible AND known — single place to
      // enforce both invariants.
      const visibleLayers = new Set(state.visibleLayers);
      visibleLayers.add(layer);
      const knownLayers = new Set(state.knownLayers);
      knownLayers.add(layer);
      const next = { activeLayer: layer, visibleLayers, knownLayers };
      persistCanvasContextFor(state, next);
      return next;
    }),
  visibleLayers: new Set<string>(),
  setVisibleLayers: (layers) =>
    set((state) => {
      const visibleLayers = new Set(layers);
      // Active layer must stay visible — drop it if the caller hid it.
      const activeLayer =
        state.activeLayer && !visibleLayers.has(state.activeLayer)
          ? null
          : state.activeLayer;
      const next = { visibleLayers, activeLayer };
      persistCanvasContextFor(state, next);
      return next;
    }),
  toggleVisibleLayer: (layer) =>
    set((state) => {
      const visibleLayers = new Set(state.visibleLayers);
      if (visibleLayers.has(layer)) {
        visibleLayers.delete(layer);
        const activeLayer = state.activeLayer === layer ? null : state.activeLayer;
        const next = { visibleLayers, activeLayer };
        persistCanvasContextFor(state, next);
        return next;
      }
      visibleLayers.add(layer);
      const next = { visibleLayers };
      persistCanvasContextFor(state, next);
      return next;
    }),
  knownLayers: new Set<string>(),
  registerLayer: (layer) =>
    set((state) => {
      const trimmed = layer.trim();
      if (!trimmed) return {};
      const knownLayers = new Set(state.knownLayers);
      knownLayers.add(trimmed);
      const visibleLayers = new Set(state.visibleLayers);
      visibleLayers.add(trimmed);
      const next = { knownLayers, visibleLayers, activeLayer: trimmed };
      persistCanvasContextFor(state, next);
      return next;
    }),

  globalVisible: true,
  toggleGlobalVisible: () =>
    set((state) => {
      // Same invariant as named layers: can't hide global while it's active.
      if (state.activeLayer === null && state.globalVisible) return {};
      const next = { globalVisible: !state.globalVisible };
      persistCanvasContextFor(state, next);
      return next;
    }),
  selectedModel: (() => {
    // Load from localStorage or use default
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('piano-selected-model');
      if (saved && LLM.ModelIds.includes(saved as LLM.ModelId)) {
        return saved as LLM.ModelId;
      }
    }
    return LLM.DEFAULT_MODEL;
  })(),

  // Child node positioning config
  childNodeOffset: { x: 0, y: 260 },

  // Undo/Redo state
  history: [],
  currentHistoryIndex: -1,

  // React Flow handlers
  onNodesChange: (changes: NodeChange[]) => {
    // Filter selection changes to prevent React Flow's spurious re-selection of dragged nodes
    let selectChanges = changes.filter((c) => c.type === 'select');

    // If there's a single select change for a recently dragged node, it's likely spurious
    // Only filter if it's selecting (not deselecting) and there are no other selected nodes
    if (selectChanges.length === 1 && _lastDraggedNodeIds.size > 0) {
      const change = selectChanges[0] as any;
      if (change.selected && _lastDraggedNodeIds.has(change.id)) {
        const currentSelected = get().nodes.filter((n) => n.selected);
        if (currentSelected.length === 0) {
          // Remove spurious select change for recently dragged node
          changes = changes.filter((c) => c !== selectChanges[0]);
          selectChanges = [];
        }
      }
    }

    // Separate position changes from other changes
    const positionChanges = changes.filter((c) => c.type === 'position');
    const otherChanges = changes.filter((c) => c.type !== 'position');

    // Apply non-position changes immediately (selection, dimensions, etc.)
    if (otherChanges.length > 0) {
      const hasStructural = otherChanges.some((c) => c.type === 'add' || c.type === 'remove');

      // Pre-push: capture any pending non-pushing edits (debounced content
      // typing) as their own undo step BEFORE we layer this structural
      // change on top. Otherwise typing + structural collapse into a single
      // snapshot and Ctrl+Z wipes typing along with the structural change.
      if (hasStructural && !get().isLoadingCanvas) get().pushHistory();

      set(
        produce((state: CanvasStore) => {
          state.nodes = applyNodeChanges(otherChanges, state.nodes);

          // Handle dirty tracking for non-position changes
          if (!state.isLoadingCanvas) {
            otherChanges.forEach((change) => {
              if (change.type === 'remove') {
                get().setDirty(change.id, true, 'node');
              } else if (change.type === 'add') {
                get().setDirty(change.item.id, true, 'node');
                state.hasUnsavedChanges = true;
              } else if (change.type === 'dimensions' && (change as { resizing?: boolean }).resizing) {
                // User-driven resize (NodeResizer, e.g. zones). `resizing` is
                // only set during an interactive drag — auto-measurement of
                // nodes leaves it falsy, so we don't spuriously dirty everything.
                get().setDirty(change.id, true, 'node');
                state.hasUnsavedChanges = true;
              }
            });
          }
        })
      );

      if (hasStructural && !get().isLoadingCanvas) get().pushHistory();
    }

    // Apply position changes immediately. React Flow is in controlled mode
    // here — it renders from the `nodes` prop, so every applyNodeChanges
    // must land for the node to follow the cursor at 60Hz.
    if (positionChanges.length > 0) {
      const isDragEnd = positionChanges.some((c) => 'dragging' in c && c.dragging === false);
      set((state) => ({
        nodes: applyNodeChanges(positionChanges, state.nodes),
        ...((isDragEnd && !state.isLoadingCanvas) ? { hasUnsavedChanges: true } : {}),
      }));
    }
  },

  onEdgesChange: (changes) => {
    const hasStructural = changes.some((c) => c.type === 'add' || c.type === 'remove');

    // Pre-push: see comment in onNodesChange.
    if (hasStructural && !get().isLoadingCanvas) get().pushHistory();

    set(
      produce((state: CanvasStore) => {
        state.edges = applyEdgeChanges(changes, state.edges);
      })
    );

    if (!get().isLoadingCanvas) {
      changes.forEach((change) => {
        if (change.type === 'remove') {
          get().setDirty(change.id, true, 'edge');
        } else if (change.type === 'add') {
          get().setDirty(change.item.id, true, 'edge');
        }
      });

      if (hasStructural) get().pushHistory();
    }
  },

  onConnect: (connection: Connection) => {
    // Pre-push: see comment in onNodesChange.
    get().pushHistory();

    const newEdge = { ...connection, type: 'custom', animated: true };
    set(
      produce((state: CanvasStore) => {
        state.edges = addEdge(newEdge, state.edges);
        state.hasUnsavedChanges = true;
      })
    );

    // Mark new edge as dirty - user created it
    const addedEdge = get().edges.find(
      (e) => e.source === connection.source && e.target === connection.target
    );
    if (addedEdge) {
      get().setDirty(addedEdge.id, true, 'edge');
    }

    // Creating a child under a collapsed node expands it — otherwise the
    // new child would spawn invisible under a closed "folder".
    if (connection.source) get().uncollapseNode(connection.source);

    get().pushHistory();
  },

  onNodeClick: (_event: React.MouseEvent, node: Node) => {
    if (isInteractiveNodeTarget(_event.target)) return;
    // Only notes with canOpenEditPanel get a side panel / window. TEXT
    // annotations are handled by their inline toolbar. We clear any stale
    // selection so the panel doesn't linger on a previously-selected note.
    if (!Note.capabilities(node.data as { type?: Note.Type } | undefined).canOpenEditPanel) {
      if (get().selectedNodeId !== null) set({ selectedNodeId: null });
      return;
    }
    if (get().selectedNodeId !== node.id) set({ selectedNodeId: node.id });
  },

  onPaneClick: () => {
    // Close drawer when clicking on canvas background
    // Also clear all node selections to prevent stale selection state
    const { nodes } = get();
    const hasSelected = nodes.some((n) => n.selected);

    if (hasSelected) {
      set(
        produce((state: CanvasStore) => {
          // Mutate in place with Immer instead of creating new objects
          for (const node of state.nodes) {
            if (node.selected) node.selected = false;
          }
          state.selectedNodeId = null;
        })
      );
    } else if (get().selectedNodeId !== null) {
      set({ selectedNodeId: null });
    }
  },

  onNodeDragStop: (_event: React.MouseEvent, node: Node) => {
    // Simple position update - React Flow handles parent-child constraints automatically
    // (Groups removed — text nodes serve the "visual anchor" use case now.)

    // Pre-push: see comment in onNodesChange.
    get().pushHistory();

    const { nodes } = get();
    const draggedNodes = nodes.filter((n) => n.selected || n.id === node.id);

    // Track dragged nodes to prevent spurious re-selection by React Flow
    _lastDraggedNodeIds.clear();
    draggedNodes.forEach((n) => _lastDraggedNodeIds.add(n.id));

    // Clear tracking after 500ms (enough time for React Flow's spurious events)
    setTimeout(() => {
      _lastDraggedNodeIds.clear();
    }, 500);

    set(
      produce((state: CanvasStore) => {
        // Keep data.x/y in lockstep with position. Anything that reads
        // coordinates off `data` (clipboard payload, branch text, sync
        // patches) gets the post-drag values, not the pre-drag stale ones.
        draggedNodes.forEach((draggedNode) => {
          const stateNode = state.nodes.find((n) => n.id === draggedNode.id);
          if (stateNode) {
            stateNode.position = draggedNode.position;
            (stateNode.data as any).x = draggedNode.position.x;
            (stateNode.data as any).y = draggedNode.position.y;
          }
        });
        state.hasUnsavedChanges = true;
      })
    );

    // Mark dragged nodes as dirty for sync
    draggedNodes.forEach((draggedNode) => {
      get().setDirty(draggedNode.id, true, 'node');
    });

    // Drag is a discrete user action — single undo step covering all moved
    // nodes (multi-select drag rolls back together).
    get().pushHistory();
  },

  // Node management
  createNode: (position, content = '', scale, layers) => {
    // Pre-push: see comment in onNodesChange.
    get().pushHistory();

    const id = generateNodeId();
    const { arrangementId, getViewportCenter, canvasZoom, activeLayer } = get();

    // If position is not provided and we have a viewport center function, use it
    const finalPosition =
      position ||
      (getViewportCenter
        ? getViewportCenter()
        : { x: Canvas.VIEWPORT.DEFAULT_X, y: Canvas.VIEWPORT.DEFAULT_Y });

    // Inherit canvas context: explicit args win, otherwise fall back to
    // the canvas's active scale and layer. `layers === []` is a valid
    // explicit choice ("global"), so we only fall back when layers is
    // undefined.
    const inheritedScale = scale !== undefined
      ? clampNodeScale(scale)
      : inherentScaleForCurrentZoom(canvasZoom);
    const inheritedLayers = layers ?? (activeLayer ? [activeLayer] : []);

    set(
      produce((state: CanvasStore) => {
        const newNode = CanvasNode.createNew(
          id,
          finalPosition,
          content,
          arrangementId || '',
          undefined,
          undefined,
          inheritedScale,
          inheritedLayers,
        );
        state.nodes.push(newNode);
        state.hasUnsavedChanges = true;
      })
    );

    get().setDirty(id, true, 'node');
    get().pushHistory();
    Analytics.track('note_created', {
      arrangementId: arrangementId || null,
      noteId: id,
      noteType: 'USER',
      hasInitialContent: content.trim().length > 0,
    });

    return id;
  },

  addChildBelow: (parentId) => {
    const { nodes, edges, childNodeOffset, createNode, onConnect } = get();
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) return null;

    const parentScale = (parent.data as CanvasNode.UI).scale || 1;
    const childIds = edges.filter((e) => e.source === parentId).map((e) => e.target);
    const children = nodes.filter((n) => childIds.includes(n.id));
    const hasGrandchildren = edges.some((e) => childIds.includes(e.source));

    const baseX = parent.position.x + childNodeOffset.x * parentScale;
    const baseY = parent.position.y + childNodeOffset.y * parentScale;

    let position: { x: number; y: number };
    const STEP = Canvas.NODE_DIMENSIONS.WIDTH * parentScale + 60;

    if (children.length > 0 && !hasGrandchildren) {
      // First-level fan-out: place at the trailing slot of the row; the
      // post-step below redistributes once the new edge is wired.
      const total = children.length + 1;
      const rowStartX = parent.position.x - ((total - 1) * STEP) / 2;
      position = { x: rowStartX + (total - 1) * STEP, y: baseY };
    } else {
      // Stack mode: bump +20,+20 until the spot is clear. 40px proximity
      // mirrors the window-placement collision rule — close enough to look
      // stacked, far enough that partial overlap is fine.
      const SHIFT = 20;
      const THRESHOLD = 40;
      const occupied = (p: { x: number; y: number }) =>
        nodes.some(
          (n) =>
            Math.abs(n.position.x - p.x) < THRESHOLD && Math.abs(n.position.y - p.y) < THRESHOLD
        );
      let candidate = { x: baseX, y: baseY };
      let safety = 50;
      while (occupied(candidate) && safety-- > 0) {
        candidate = { x: candidate.x + SHIFT, y: candidate.y + SHIFT };
      }
      position = candidate;
    }

    // Children inherit their parent's layer membership — a tree of thought
    // belongs to one layer, not whichever layer the user happens to have
    // active when they click "+".
    const parentLayers = ((parent.data as any).layers as string[] | undefined) ?? [];
    const newId = createNode(position, '', parentScale, parentLayers);
    if (!newId) return null;

    // Defer connect by one tick so the new node is mounted before the edge
    // references it. The horizontal redistribution runs after connect so
    // the new id is already in the children list.
    setTimeout(() => {
      onConnect({ source: parentId, target: newId, sourceHandle: null, targetHandle: null });

      if (children.length > 0 && !hasGrandchildren) {
        const allChildren = [
          ...children,
          { id: newId, position: { x: position.x, y: baseY } } as Node,
        ];
        const sortedByX = [...allChildren].sort((a, b) => a.position.x - b.position.x);
        const total = sortedByX.length;
        const rowStartX = parent.position.x - ((total - 1) * STEP) / 2;
        const newPositions = new Map<string, { x: number; y: number }>();
        sortedByX.forEach((c, i) => newPositions.set(c.id, { x: rowStartX + i * STEP, y: baseY }));

        set(
          produce((state: CanvasStore) => {
            for (const node of state.nodes) {
              const next = newPositions.get(node.id);
              if (!next) continue;
              node.position = next;
              (node.data as { x: number; y: number }).x = next.x;
              (node.data as { x: number; y: number }).y = next.y;
            }
            state.hasUnsavedChanges = true;
          })
        );
        for (const id of newPositions.keys()) get().setDirty(id, true, 'node');
      }
    }, 10);

    return newId;
  },

  createTextNode: (position, content = 'Heading') => {
    // Pre-push: see comment in onNodesChange.
    get().pushHistory();

    const id = generateNodeId();
    const { arrangementId, getViewportCenter } = get();

    const finalPosition =
      position ||
      (getViewportCenter
        ? getViewportCenter()
        : { x: Canvas.VIEWPORT.DEFAULT_X, y: Canvas.VIEWPORT.DEFAULT_Y });

    const inheritedLayers = get().activeLayer ? [get().activeLayer as string] : [];
    set(
      produce((state: CanvasStore) => {
        state.nodes.push(
          CanvasNode.createText(id, finalPosition, arrangementId || '', content, inheritedLayers),
        );
        state.hasUnsavedChanges = true;
      })
    );

    get().setDirty(id, true, 'node');
    get().pushHistory();
    Analytics.track('note_created', {
      arrangementId: arrangementId || null,
      noteId: id,
      noteType: 'TEXT',
      hasInitialContent: content.trim().length > 0,
    });
    return id;
  },

  activeTool: 'select',
  setActiveTool: (tool) => set({ activeTool: tool }),

  // Commit a drawn rectangle as a ZONE node. Mirrors createTextNode: optimistic
  // push + setDirty so the existing useCanvasSync PATCH persists it.
  createZone: (box) => {
    get().pushHistory();
    const id = generateNodeId();
    const { arrangementId, activeLayer } = get();
    const layers = activeLayer ? [activeLayer] : [];
    set(
      produce((state: CanvasStore) => {
        state.nodes.push(CanvasNode.createZone(id, box, arrangementId || '', null, null, layers));
        state.hasUnsavedChanges = true;
      }),
    );
    get().setDirty(id, true, 'node');
    get().pushHistory();
    return id;
  },

  // Commit a freehand/line gesture as a DRAWING node. `drawing.points` are
  // node-local (relative to box top-left), so the stroke is position-stable.
  createDrawing: (box, drawing) => {
    get().pushHistory();
    const id = generateNodeId();
    const { arrangementId, activeLayer } = get();
    const layers = activeLayer ? [activeLayer] : [];
    set(
      produce((state: CanvasStore) => {
        state.nodes.push(CanvasNode.createDrawing(id, box, arrangementId || '', drawing, null, layers));
        state.hasUnsavedChanges = true;
      }),
    );
    get().setDirty(id, true, 'node');
    get().pushHistory();
    return id;
  },

  createMachineNode: (position, label = 'Machine') => {
    const id = generateNodeId();
    const machineId = id; // use the same ID as the machine daemon-side ID
    const { arrangementId, getViewportCenter, canvasZoom, activeLayer } = get();

    const finalPosition =
      position ||
      (getViewportCenter
        ? getViewportCenter()
        : { x: Canvas.VIEWPORT.DEFAULT_X, y: Canvas.VIEWPORT.DEFAULT_Y });

    const inheritedLayers = activeLayer ? [activeLayer] : [];

    set(
      produce((state: CanvasStore) => {
        const newNode = CanvasNode.createMachine(
          id,
          finalPosition,
          machineId,
          arrangementId || '',
          label,
          undefined,
          inherentScaleForCurrentZoom(canvasZoom),
          inheritedLayers,
        );
        state.nodes.push(newNode);
        state.hasUnsavedChanges = true;
      })
    );

    get().setDirty(id, true, 'node');
    Analytics.track('machine_created', {
      arrangementId: arrangementId || null,
      nodeId: id,
      source: 'blank',
    });
    return { nodeId: id, machineId };
  },

  // Provision a new machine as part of the canvas patch — no separate
  // POST /templates/create-machine. Frontend pushes a PROVISIONING node,
  // sends one immediate PATCH carrying the provisioning intent, and the
  // backend's patch handler creates the Note AND kicks the daemon. Status
  // flips to RUNNING via SSE when the daemon ack's. The terminal stays
  // closed until that flip — see MachineEditPanel's PROVISIONING guard.
  // No setDirty: the backend already has the canonical row, the debounced
  // sync loop only handles subsequent edits (move/label/content).
  createMachineNodeFromTemplate: async (templateId, daemonId, position, label) => {
    const id = generateNodeId();
    const { arrangementId, getViewportCenter, canvasZoom, activeLayer } = get();
    if (!arrangementId) return null;

    const finalPosition =
      position ||
      (getViewportCenter
        ? getViewportCenter()
        : { x: Canvas.VIEWPORT.DEFAULT_X, y: Canvas.VIEWPORT.DEFAULT_Y });
    const nodeLabel = label || 'Machine';

    const inheritedLayers = activeLayer ? [activeLayer] : [];
    set(
      produce((state: CanvasStore) => {
        const newNode = CanvasNode.createMachine(
          id,
          finalPosition,
          id,
          arrangementId,
          nodeLabel,
          undefined,
          inherentScaleForCurrentZoom(canvasZoom),
          inheritedLayers,
        );
        newNode.data.daemonId = daemonId;
        newNode.data.status = 'PROVISIONING';
        state.nodes.push(newNode);
        state.hasUnsavedChanges = true;
      }),
    );

    const result = await ArrangementService.patch(arrangementId, {
      dirtyNodes: [{
        id,
        type: 'MACHINE',
        x: finalPosition.x,
        y: finalPosition.y,
        label: nodeLabel,
        machineId: id,
        daemonId,
        status: 'PROVISIONING',
        provisioning: { kind: 'template', templateId: templateId || '' },
      }],
      dirtyEdges: [],
      deletedNodeIds: [],
      deletedEdgeIds: [],
      demotedNodeIds: [],
    });

    // A patch can also "succeed" with this node in `failed[]` (e.g. Prisma
    // rejected the row). Treat that as a hard failure — backend has no row,
    // mounting the terminal would 1006.
    let ok = false;
    let failureReason: string | null = null;
    Union.match({
      success: ({ failed }) => {
        const myFailure = failed.find(f => f.id === id);
        if (myFailure) failureReason = myFailure.reason;
        else ok = true;
      },
      error: ({ message }) => { failureReason = message; },
    }, result);

    if (!ok) {
      toast.error(`Failed to create machine: ${failureReason ?? 'unknown error'}`);
      set(produce((state: CanvasStore) => {
        state.nodes = state.nodes.filter(n => n.id !== id);
      }));
      return null;
    }

    Analytics.track('machine_created', {
      arrangementId,
      nodeId: id,
      source: templateId ? 'template' : 'blank',
      templateId: templateId || undefined,
    });
    return { nodeId: id, machineId: id };
  },

  setNodeStatus: (nodeId, status) => {
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          node.data.status = status as any;
          state.hasUnsavedChanges = true;
        }
      })
    );
    get().setDirty(nodeId, true, 'node');
  },

  freezeMachine: async (nodeId, name) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const data = asUI(node.data);
    if (!CanvasNode.isMachine(data)) return;
    const prevStatus = data.status as Note.Status | null | undefined;
    const machineId = CanvasNode.machineIdOf(data, nodeId);

    set(
      produce((state: CanvasStore) => {
        const n = state.nodes.find((x) => x.id === nodeId);
        if (n) (n.data as CanvasNode.UI).status = 'saving';
      })
    );

    const result = await MachineService.freeze(machineId, name);
    if ('error' in result) {
      set(
        produce((state: CanvasStore) => {
          const n = state.nodes.find((x) => x.id === nodeId);
          if (n) (n.data as CanvasNode.UI).status = prevStatus;
        })
      );
      const { message, code } = result.error;
      const friendly = code === 503
        ? (message?.toLowerCase().includes('no associated daemon')
            ? message
            : 'Daemon not connected — open the terminal first')
        : (message || 'Failed to freeze machine');
      toast.error(friendly);
      return;
    }

    const { templateId, templateName, deletedNoteIds } = result.success;
    const idSet = new Set(deletedNoteIds.length ? deletedNoteIds : [nodeId]);
    set(
      produce((state: CanvasStore) => {
        state.nodes = state.nodes.filter((n) => !idSet.has(n.id));
        state.edges = state.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target));
      })
    );

    for (const id of idSet) {
      get().setDirty(id, false, 'node');
    }

    const mcStore = useMachineCenterStore.getState();
    if (mcStore.activeForward?.machineId === machineId) {
      void mcStore.deactivateForward();
    }

    void useMachineCenterStore.getState().fetchTemplates();

    toast.success(`Saved "${templateName}" to Packages`, {
      action: {
        label: 'Open',
        onClick: () => {
          window.dispatchEvent(new CustomEvent('piano:open-template', { detail: { templateId } }));
        },
      },
    });
  },

  // Port-forward / IDE-open / SSH-copy actions used to live on the canvas
  // store so MachineNode/MachineEditPanel could invoke them directly.
  // They've since moved into the unified NODE_ACTIONS registry
  // (see ../lib/node-actions.tsx) which every surface reads, so the
  // canvas store no longer owns those entrypoints. The machine-center
  // store owns port-forward state and `useMachineCenterStore.getState()
  // .activateForward()` is the canonical toggle.

  // Same shape as createMachineNodeFromTemplate: optimistic PROVISIONING
  // push + patch carrying provisioning intent. Backend creates the Note,
  // fires `command:branch` on the daemon, flips status to RUNNING via SSE.
  branchMachine: async (parentNodeId, branchName) => {
    const parentNode = get().nodes.find((n) => n.id === parentNodeId);
    if (!parentNode) return null;
    const parentData = asUI(parentNode.data);
    if (!CanvasNode.isMachine(parentData)) return null;

    const { arrangementId } = get();
    if (!arrangementId) return null;
    const parentMachineId = CanvasNode.machineIdOf(parentData, parentNodeId);
    const parentLabel = parentData.label || 'Machine';
    const newId = generateNodeId();
    // Branch lives on the parent's daemon — daemon-side overlay CoW is local.
    const childDaemonId = parentData.daemonId;
    if (!childDaemonId) {
      toast.error('Cannot branch a machine that has no associated daemon');
      return null;
    }

    const requestedBranchName = branchName?.trim();
    const allMachineLabels = get()
      .nodes.map((n) => asUI(n.data))
      .filter(CanvasNode.isMachine)
      .map((d) => d.label || '');
    const branchLabel = requestedBranchName || MachineLabel.nextBranchName(parentLabel, allMachineLabels);

    const parentPosition = parentNode.position;
    const parentScale = (parentNode.data.scale as number) ?? 1.0;
    // Inherit the parent's layer membership: branching is "do the same thing
    // again", so the new machine should sit on the same layer(s) as its
    // parent — not silently fall back to the canvas's active layer.
    const parentLayers = ((parentNode.data as any).layers as string[] | undefined) ?? [];
    const siblingOffset = Canvas.NODE_SPACING.CHILD_SIBLING * parentScale;
    const branchPosition = {
      x: parentPosition.x + siblingOffset,
      y: parentPosition.y,
    };

    set(
      produce((state: CanvasStore) => {
        state.branchingNodes.set(parentNodeId, Date.now());
        const newNode = CanvasNode.createMachine(
          newId,
          branchPosition,
          newId,
          arrangementId,
          branchLabel,
          parentNodeId,
          parentScale,
          parentLayers,
        );
        newNode.data.parentMachineNodeId = parentNodeId;
        newNode.data.daemonId = childDaemonId;
        newNode.data.status = 'PROVISIONING';
        state.nodes.push(newNode);
        state.hasUnsavedChanges = true;
      }),
    );

    const result = await ArrangementService.patch(arrangementId, {
      dirtyNodes: [{
        id: newId,
        type: 'MACHINE',
        x: branchPosition.x,
        y: branchPosition.y,
        scale: parentScale,
        label: branchLabel,
        machineId: newId,
        daemonId: childDaemonId,
        parentMachineNodeId: parentNodeId,
        status: 'PROVISIONING',
        provisioning: { kind: 'branch', fromMachineId: parentMachineId },
      }],
      dirtyEdges: [],
      deletedNodeIds: [],
      deletedEdgeIds: [],
      demotedNodeIds: [],
    });

    set(produce((state: CanvasStore) => {
      state.branchingNodes.delete(parentNodeId);
    }));

    let ok = false;
    let failureReason: string | null = null;
    Union.match({
      success: ({ failed }) => {
        const myFailure = failed.find(f => f.id === newId);
        if (myFailure) failureReason = myFailure.reason;
        else ok = true;
      },
      error: ({ message }) => { failureReason = message; },
    }, result);

    if (!ok) {
      toast.error(`Failed to branch machine: ${failureReason ?? 'unknown error'}`);
      set(produce((state: CanvasStore) => {
        state.nodes = state.nodes.filter(n => n.id !== newId);
      }));
      return null;
    }

    Analytics.track('machine_created', {
      arrangementId,
      nodeId: newId,
      source: 'branch',
    });
    return { nodeId: newId, machineId: newId };
  },

  // Terminal node = TERMINAL Note backed by a shared mount onto the parent
  // machine. Same provisioning shape — backend fires `command:share` on the
  // daemon, flips status when ack'd.
  createTerminal: async (machineNodeId) => {
    const machineNode = get().nodes.find((n) => n.id === machineNodeId);
    if (!machineNode) return null;
    const machineData = asUI(machineNode.data);
    if (!CanvasNode.isMachine(machineData)) return null;

    const { arrangementId } = get();
    if (!arrangementId) return null;
    const machineId = CanvasNode.machineIdOf(machineData, machineNodeId);
    const machineLabel = machineData.label || 'Machine';
    const newId = generateNodeId();
    const childDaemonId = machineData.daemonId;
    if (!childDaemonId) {
      toast.error('Cannot open a terminal on a machine that has no associated daemon');
      return null;
    }

    const machinePosition = machineNode.position;
    const machineScale = (machineNode.data.scale as number) ?? 1.0;
    const machineLayers = ((machineNode.data as any).layers as string[] | undefined) ?? [];
    const terminalOffset = Canvas.NODE_SPACING.CHILD_SIBLING * machineScale;
    const terminalPosition = {
      x: machinePosition.x + terminalOffset,
      y: machinePosition.y + Canvas.NODE_SPACING.TERMINAL_BELOW_MACHINE * machineScale,
    };

    set(
      produce((state: CanvasStore) => {
        const newNode = CanvasNode.createTerminal(
          newId,
          terminalPosition,
          newId,
          machineNodeId,
          arrangementId,
          machineLabel,
          machineScale,
          machineLayers,
        );
        newNode.data.daemonId = childDaemonId;
        newNode.data.status = 'PROVISIONING';
        state.nodes.push(newNode);
        state.hasUnsavedChanges = true;
      }),
    );

    const result = await ArrangementService.patch(arrangementId, {
      dirtyNodes: [{
        id: newId,
        type: 'TERMINAL',
        x: terminalPosition.x,
        y: terminalPosition.y,
        scale: machineScale,
        machineId: newId,
        daemonId: childDaemonId,
        parentMachineNodeId: machineNodeId,
        status: 'PROVISIONING',
        provisioning: { kind: 'share', fromMachineId: machineId },
      }],
      dirtyEdges: [],
      deletedNodeIds: [],
      deletedEdgeIds: [],
      demotedNodeIds: [],
    });

    let ok = false;
    let failureReason: string | null = null;
    Union.match({
      success: ({ failed }) => {
        const myFailure = failed.find(f => f.id === newId);
        if (myFailure) failureReason = myFailure.reason;
        else ok = true;
      },
      error: ({ message }) => { failureReason = message; },
    }, result);

    if (!ok) {
      toast.error(`Failed to create terminal: ${failureReason ?? 'unknown error'}`);
      set(produce((state: CanvasStore) => {
        state.nodes = state.nodes.filter(n => n.id !== newId);
      }));
      return null;
    }

    return { nodeId: newId, machineId: newId };
  },

  // Promote an in-window pane (daemon-side share session, no canvas Note)
  // into a canvas TERMINAL node pointing at the same paneId. Daemon
  // session is reused — no `command:share` call needed.
  promotePane: (paneId, parentMachineNodeId, position) => {
    const parent = get().nodes.find(n => n.id === parentMachineNodeId);
    if (!parent) return null;
    const parentData = asUI(parent.data);
    if (!CanvasNode.isMachine(parentData)) return null;
    const parentScale = parentData.scale ?? 1.0;
    const parentLabel = parentData.label || 'Machine';
    const daemonId = parentData.daemonId;
    const arrangementId = get().arrangementId;
    if (!arrangementId) return null;
    const newId = generateNodeId();
    set(
      produce((state: CanvasStore) => {
        const node = CanvasNode.createTerminal(
          newId,
          position,
          paneId, // daemon machine id == pane id (same substrate as share)
          parentMachineNodeId,
          arrangementId,
          parentLabel,
          parentScale,
        );
        if (daemonId) node.data.daemonId = daemonId;
        state.nodes.push(node);
        state.hasUnsavedChanges = true;
      }),
    );
    get().setDirty(newId, true, 'node');
    return newId;
  },

  // Capture an existing canvas TERMINAL node's paneId + label, then
  // delete the node locally (mark dirty → patch flow deletes the row).
  // Daemon pane is intentionally NOT closed — it's about to be embedded
  // into a machine window.
  demoteTerminal: (terminalNodeId) => {
    const node = get().nodes.find(n => n.id === terminalNodeId);
    if (!node) return null;
    const data = asUI(node.data);
    if (!CanvasNode.isTerminal(data)) return null;
    const paneId = data.machineId || node.id;
    const label = data.label || 'Terminal';
    get().pushHistory();
    set(produce((state: CanvasStore) => {
      state.nodes = state.nodes.filter(n => n.id !== terminalNodeId);
      state.edges = state.edges.filter(
        e => e.source !== terminalNodeId && e.target !== terminalNodeId,
      );
      state.hasUnsavedChanges = true;
    }));
    // Sync flow detects deletion as "dirty id not in nodes anymore" — so
    // marking dirty after removal IS the delete signal. setDemoted tags this
    // id so useCanvasSync routes it as a demotion (DB-only) instead of a
    // destructive delete (DB + daemon kill) — otherwise we'd kill the very
    // pane we're about to embed.
    get().setDirty(terminalNodeId, true, 'node');
    get().setDemoted(terminalNodeId);
    return { paneId, label };
  },

  addNodes: (nodes) => {
    // Add nodes from external sources (e.g., backend optimistic response).
    // Don't mark as dirty - backend already has these entities. Dedup by id
    // so retries / parallel paths can't insert React-key collisions.
    set(
      produce((state: CanvasStore) => {
        nodes.forEach((node) => {
          const idx = state.nodes.findIndex((n) => n.id === node.id);
          if (idx === -1) state.nodes.push(node);
          else state.nodes[idx] = node;
        });
      })
    );
  },

  deleteNode: (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);

    // Brief anti-fat-finger gate: if the node JUST entered RUNNING (within
    // the grace window) we suppress delete so a click right after pressing
    // Run doesn't nuke the optimistic node before the user sees it. After
    // the window deletion is allowed even if still running — the backend
    // worker drops late AI responses for missing targets.
    const runStartedAt = get().runStartedAt.get(nodeId);
    if (runStartedAt && Date.now() - runStartedAt < RUN_DELETE_GRACE_MS) {
      const remaining = Math.ceil((RUN_DELETE_GRACE_MS - (Date.now() - runStartedAt)) / 1000);
      toast.info(`Wait ${remaining}s — node just started running`);
      return;
    }

    // Pre-push: see comment in onNodesChange.
    get().pushHistory();

    // When deleting a machine, also remove its terminal nodes.
    const terminalNodes =
      node?.data.type === 'MACHINE'
        ? get().nodes.filter(
            (n) => n.data.type === 'TERMINAL' && (n.data as any).parentMachineNodeId === nodeId
          )
        : [];
    // Branch children are independent clones. Keep them, but clear the stale
    // lineage pointer so UI and persisted state don't reference a deleted node.
    const childMachineNodes =
      node?.data.type === 'MACHINE'
        ? get().nodes.filter((n) => {
            const data = asUI(n.data);
            return CanvasNode.isMachine(data) && data.parentMachineNodeId === nodeId;
          })
        : [];

    // Tear down in-window panes (daemon share sessions that aren't canvas
    // Notes). Parent's own PTY is left alone — DeleteBatch on the daemon
    // sweeps it through the MACHINE node's normal sync-delete path.
    if (node?.data.type === 'MACHINE') {
      const machineId = (node.data as { machineId?: string }).machineId || nodeId;
      cleanupOrphanPanes(nodeId, machineId);
    }

    const idsToRemove = new Set([nodeId, ...terminalNodes.map((n) => n.id)]);
    set(
      produce((state: CanvasStore) => {
        for (const child of childMachineNodes) {
          const match = state.nodes.find((n) => n.id === child.id);
          const data = match ? asUI(match.data) : null;
          if (data && CanvasNode.isMachine(data)) {
            data.parentMachineNodeId = null;
          }
        }
        state.nodes = state.nodes.filter((n) => !idsToRemove.has(n.id));
        state.edges = state.edges.filter(
          (e) => !idsToRemove.has(e.source) && !idsToRemove.has(e.target)
        );
        for (const id of idsToRemove) state.runStartedAt.delete(id);
        for (const id of idsToRemove) state.branchingNodes.delete(id);
        state.hasUnsavedChanges = true;
      })
    );

    // Mark all for deletion — sync handles DB + daemon cleanup.
    for (const id of idsToRemove) {
      get().setDirty(id, true, 'node');
    }
    for (const child of childMachineNodes) {
      get().setDirty(child.id, true, 'node');
    }

    get().pushHistory();

    // If the deleted machine was the one currently port-forwarding, clear
    // the global slice so the Mission Control sticky widget and any open
    // node chips don't show stale state for a machine that no longer exists.
    // MissionControlTab does the same in its per-row onDelete; Canvas owns
    // the parallel path here.
    const deletedMachineIds = new Set<string>();
    if (node?.data.type === 'MACHINE') {
      deletedMachineIds.add((node.data as any).machineId || nodeId);
    }
    for (const t of terminalNodes) {
      deletedMachineIds.add((t.data as any).machineId || t.id);
    }
    const mcStore = useMachineCenterStore.getState();
    if (mcStore.activeForward && deletedMachineIds.has(mcStore.activeForward.machineId)) {
      void mcStore.deactivateForward();
    }
  },

  duplicateNode: (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;

    // Pre-push: see comment in onNodesChange.
    get().pushHistory();

    const newId = generateNodeId();
    set(
      produce((state: CanvasStore) => {
        state.nodes.push({
          ...node,
          id: newId,
          position: {
            x: node.position.x + 50,
            y: node.position.y + 50,
          },
          data: {
            ...node.data,
            id: newId,
          },
          selected: false,
        });
        state.hasUnsavedChanges = true;
      })
    );

    get().setDirty(newId, true, 'node');
    get().pushHistory();
  },

  updateNodeContent: (nodeId, _arrangementId, content) => {
    // Note: History is pushed automatically before sync (2s debounce)
    // This keeps undo/redo perfectly coordinated with backend state
    const updatedAt = new Date();
    let changed = false;

    set((state) => {
      const nodes = state.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        if (node.data.content === content) return node;

        changed = true;
        return {
          ...node,
          data: {
            ...node.data,
            content,
            updatedAt,
          },
        };
      });

      return changed ? { nodes, hasUnsavedChanges: true } : {};
    });

    if (changed) {
      // Mark as dirty for optimistic sync (which triggers debounced history push)
      get().setDirty(nodeId, true, 'node');
    }
  },

  updateNodeLabel: (nodeId, label) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          node.data.label = label;
          node.data.updatedAt = new Date();
          state.hasUnsavedChanges = true;
        }
      })
    );

    get().setDirty(nodeId, true, 'node');
    get().pushHistory();
  },

  updateNodeColor: (nodeId, color) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          node.data.color = color;
          node.data.updatedAt = new Date();
          state.hasUnsavedChanges = true;
        }
      })
    );

    get().setDirty(nodeId, true, 'node');
    get().pushHistory();
  },

  updateNodeCacheConfig: (nodeId, cacheConfig) => {
    // NoteCacheService.set/toggle/clear already persisted the change; this
    // is a UI-only sync so the CacheButton re-renders with the right state.
    // No setDirty — server is the source of truth for cache config.
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          (node.data as any).cacheConfig = cacheConfig;
          node.data.updatedAt = new Date();
        }
      })
    );
  },

  updateNodeTags: (nodeId, tags) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          node.data.tags = tags;
          node.data.updatedAt = new Date();
          state.hasUnsavedChanges = true;
        }
      })
    );

    get().setDirty(nodeId, true, 'node');
    get().pushHistory();
  },

  // Structured per-type rendering metadata (TextStyle for TEXT nodes, could be
  // extended for future node types). Uses the same dirty-tracking path as every
  // other mutation so patch sync picks it up automatically.
  updateNodeStyle: (nodeId, style) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          (node.data as any).style = style;
          node.data.updatedAt = new Date();
          state.hasUnsavedChanges = true;
        }
      })
    );

    get().setDirty(nodeId, true, 'node');
    get().pushHistory();
  },

  updateNodeScale: (nodeId, scale) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          node.data.scale = scale;
          node.data.updatedAt = new Date();
          // Card-shaped types need explicit dims so RF hit-testing matches the
          // scaled visual. TEXT auto-measures from fontSize × content; writing
          // 300 × 200 would freeze it at the wrong size.
          if (node.data.type !== 'TEXT') {
            node.width = Canvas.NODE_DIMENSIONS.WIDTH * scale;
            node.height = Canvas.NODE_DIMENSIONS.HEIGHT * scale;
          }
          state.hasUnsavedChanges = true;
        }
      })
    );

    get().setDirty(nodeId, true, 'node');
    get().pushHistory();
  },

  updateNodeAncestorOverride: (nodeId, ancestorIds) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          node.data.ancestorOverride = ancestorIds;
          node.data.updatedAt = new Date();
          state.hasUnsavedChanges = true;
        }
      })
    );

    get().setDirty(nodeId, true, 'node');
    get().pushHistory();
  },

  updateNodeSize: (nodeId, width, height) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          node.width = width;
          node.height = height;
          if (node.style) {
            node.style.width = width;
            node.style.height = height;
          } else {
            node.style = { width, height };
          }
          state.hasUnsavedChanges = true;
        }
      })
    );

    get().setDirty(nodeId, true, 'node');
    get().pushHistory();
  },

  hiddenNodeIds: new Set<string>(),
  collapsedNodeIds: new Set<string>(),
  collapseStates: new Map<string, 'recursive' | 'single'>(),

  toggleCollapsed: (nodeId) => {
    const { edges } = get();
    const { directChildren, allDescendants } = collectDescendants(nodeId, edges);

    set(
      produce((state: CanvasStore) => {
        const cur = state.collapseStates.get(nodeId);
        if (!cur) {
          // hide-all: write hidden=true to every descendant
          for (const id of allDescendants) state.hiddenNodeIds.add(id);
          state.collapseStates.set(nodeId, 'recursive');
          state.collapsedNodeIds.add(nodeId);
        } else if (cur === 'recursive') {
          // show-one: hide everything, then peel direct children back
          for (const id of allDescendants) state.hiddenNodeIds.add(id);
          for (const id of directChildren) state.hiddenNodeIds.delete(id);
          state.collapseStates.set(nodeId, 'single');
          state.collapsedNodeIds.add(nodeId);
        } else {
          // show-all: clear hidden on the entire subtree
          for (const id of allDescendants) state.hiddenNodeIds.delete(id);
          state.collapseStates.delete(nodeId);
          state.collapsedNodeIds.delete(nodeId);
        }
      })
    );

    persistCollapseForCurrentArrangement(get());
  },

  // Called from edge-creation paths so a brand-new child under a previously
  // collapsed node doesn't appear as a "ghost" with its parent missing. We
  // treat it as an implicit "show all" click on `nodeId`: reveal nodeId and
  // its subtree, reset the button cycle. Imperative, last-action-wins.
  uncollapseNode: (nodeId) => {
    const { edges, collapseStates, hiddenNodeIds } = get();
    if (!collapseStates.has(nodeId) && !hiddenNodeIds.has(nodeId)) return;

    const { allDescendants } = collectDescendants(nodeId, edges);

    set(
      produce((state: CanvasStore) => {
        state.hiddenNodeIds.delete(nodeId);
        for (const id of allDescendants) state.hiddenNodeIds.delete(id);
        state.collapseStates.delete(nodeId);
        state.collapsedNodeIds.delete(nodeId);
      })
    );

    persistCollapseForCurrentArrangement(get());
  },

  toggleNodePinned: (nodeId) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          node.data.pinned = !node.data.pinned;
          node.data.updatedAt = new Date();
          state.hasUnsavedChanges = true;
        }
      })
    );

    get().setDirty(nodeId, true, 'node');
    get().pushHistory();
  },

  toggleNodeLocked: (nodeId) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          const cur = (node.data.style as { locked?: boolean } | null) ?? {};
          (node.data as any).style = { ...cur, locked: !cur.locked };
          node.data.updatedAt = new Date();
          state.hasUnsavedChanges = true;
        }
      })
    );

    get().setDirty(nodeId, true, 'node');
    get().pushHistory();
  },

  toggleNodeMergePoint: (nodeId) => {
    const state = get();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    // Pre-push: see comment in onNodesChange.
    get().pushHistory();

    const wasMergePoint = (node.data as CanvasNode.UI).isMergePoint;
    const willBeMergePoint = !wasMergePoint;

    // If disabling merge point, remove extra parent edges (keep only first parent)
    if (wasMergePoint && !willBeMergePoint) {
      const parentEdges = state.edges.filter((e) => e.target === nodeId);

      if (parentEdges.length > 1) {
        console.info(`[MergePoint] Removing ${parentEdges.length - 1} extra parent edges`, {
          nodeId,
          totalParents: parentEdges.length,
        });

        // Keep first edge, remove the rest
        const edgesToRemove = parentEdges.slice(1);

        set(
          produce((state: CanvasStore) => {
            // Remove edges
            state.edges = state.edges.filter((e) => !edgesToRemove.some((rem) => rem.id === e.id));

            // Toggle merge point
            const node = state.nodes.find((n) => n.id === nodeId);
            if (node) {
              node.data.isMergePoint = false;
              node.data.updatedAt = new Date();
              state.hasUnsavedChanges = true;
            }
          })
        );

        // Mark removed edges as dirty (deleted)
        edgesToRemove.forEach((edge) => {
          get().setDirty(edge.id, true, 'edge');
        });
      } else {
        // No extra edges to remove, just toggle
        set(
          produce((state: CanvasStore) => {
            const node = state.nodes.find((n) => n.id === nodeId);
            if (node) {
              node.data.isMergePoint = false;
              node.data.updatedAt = new Date();
              state.hasUnsavedChanges = true;
            }
          })
        );
      }
    } else {
      // Enabling merge point - just toggle
      set(
        produce((state: CanvasStore) => {
          const node = state.nodes.find((n) => n.id === nodeId);
          if (node) {
            node.data.isMergePoint = true;
            node.data.updatedAt = new Date();
            state.hasUnsavedChanges = true;
          }
        })
      );
    }

    // Mark node as dirty for optimistic sync
    get().setDirty(nodeId, true, 'node');
    get().pushHistory();
  },

  // Bulk operations
  bulkUpdateLabel: (nodeIds, label) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        nodeIds.forEach((nodeId) => {
          const node = state.nodes.find((n) => n.id === nodeId);
          if (node) {
            node.data.label = label;
            node.data.updatedAt = new Date();
            state.hasUnsavedChanges = true;
          }
        });
      })
    );

    nodeIds.forEach((nodeId) => get().setDirty(nodeId, true, 'node'));
    get().pushHistory();
  },

  bulkAddTags: (nodeIds, tags) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        nodeIds.forEach((nodeId) => {
          const node = state.nodes.find((n) => n.id === nodeId);
          if (node) {
            // Merge tags, avoid duplicates
            const existingTags = new Set<string>((node.data.tags as string[]) || []);
            tags.forEach((tag) => existingTags.add(tag));
            node.data.tags = Array.from(existingTags).sort();
            node.data.updatedAt = new Date();
            state.hasUnsavedChanges = true;
          }
        });
      })
    );

    nodeIds.forEach((nodeId) => get().setDirty(nodeId, true, 'node'));
    get().pushHistory();
  },

  bulkUpdateColor: (nodeIds, color) => {
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        nodeIds.forEach((nodeId) => {
          const node = state.nodes.find((n) => n.id === nodeId);
          if (node) {
            node.data.color = color;
            node.data.updatedAt = new Date();
            state.hasUnsavedChanges = true;
          }
        });
      })
    );

    nodeIds.forEach((nodeId) => get().setDirty(nodeId, true, 'node'));
    get().pushHistory();
  },

  bulkUpdateLayers: (nodeIds, layers) => {
    // Wholesale replace — "move to X" must not merge with the previous membership.
    const normalised = Note.Layers.replace(layers);
    get().pushHistory();
    set(
      produce((state: CanvasStore) => {
        nodeIds.forEach((nodeId) => {
          const node = state.nodes.find((n) => n.id === nodeId);
          if (node) {
            (node.data as any).layers = [...normalised];
            node.data.updatedAt = new Date();
            state.hasUnsavedChanges = true;
          }
        });
        // Treat the move as registration too, so a freshly-typed name persists.
        for (const l of normalised) state.knownLayers.add(l);
        persistCanvasContextFor(state, { knownLayers: state.knownLayers });
      })
    );

    nodeIds.forEach((nodeId) => get().setDirty(nodeId, true, 'node'));
    get().pushHistory();
  },

  bulkUpdateScale: (nodeIds, scale, options) => {
    const transient = options?.transient === true;
    if (!transient && !options?.skipHistoryBefore) get().pushHistory();

    const nodeIdSet = new Set(nodeIds);
    const updatedIds: string[] = [];
    const updatedAt = new Date();

    let anchor: { x: number; y: number } | null = null;
    let scaleFactor = 1.0;
    if (options?.referenceScale && options?.referencePositions) {
      const positions = Object.values(options.referencePositions);
      if (positions.length > 0) {
        const minX = Math.min(...positions.map((p) => p.x));
        const minY = Math.min(...positions.map((p) => p.y));
        anchor = { x: minX, y: minY };
        scaleFactor = scale / options.referenceScale;
      }
    }

    set((state) => {
      let changed = false;
      const nodes = state.nodes.map((node) => {
        if (!nodeIdSet.has(node.id)) return node;

        const nextPosition = { ...node.position };
        if (anchor && options?.referencePositions?.[node.id]) {
          const refPos = options.referencePositions[node.id];
          nextPosition.x = anchor.x + (refPos.x - anchor.x) * scaleFactor;
          nextPosition.y = anchor.y + (refPos.y - anchor.y) * scaleFactor;
        }

        const nextWidth =
          node.data.type !== 'TEXT' ? Canvas.NODE_DIMENSIONS.WIDTH * scale : node.width;
        const nextHeight =
          node.data.type !== 'TEXT' ? Canvas.NODE_DIMENSIONS.HEIGHT * scale : node.height;

        const visuallyChanged =
          node.data.scale !== scale ||
          node.position.x !== nextPosition.x ||
          node.position.y !== nextPosition.y ||
          node.width !== nextWidth ||
          node.height !== nextHeight;

        if (transient && !visuallyChanged) return node;

        changed = true;
        updatedIds.push(node.id);
        return {
          ...node,
          position: nextPosition,
          width: nextWidth,
          height: nextHeight,
          data: {
            ...node.data,
            scale,
            updatedAt: transient ? node.data.updatedAt : updatedAt,
          },
        };
      });

      return changed ? { nodes, hasUnsavedChanges: true } : {};
    });

    if (!transient) {
      updatedIds.forEach((nodeId) => get().setDirty(nodeId, true, 'node'));
      get().pushHistory();
    }
  },

  connectSelected: (nodeIds) => {
    const { nodes, edges, setDirty } = get();
    const selectedSet = new Set(nodeIds);
    const targets = nodes.filter((n) => selectedSet.has(n.id));
    if (targets.length < 2) return 0;

    // Pre-push: see comment in onNodesChange.
    get().pushHistory();

    const sorted = sortNodesByReadingOrder(targets);

    // Disconnect selected nodes from EVERYTHING else (incoming + outgoing).
    // Edges wholly outside the selection are left alone.
    const edgesToRemove = edges.filter(
      (e) => selectedSet.has(e.source) || selectedSet.has(e.target)
    );
    const removeIds = new Set(edgesToRemove.map((e) => e.id));

    const ts = Date.now();
    const newEdges: ReactFlowEdge[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const source = sorted[i].id;
      const target = sorted[i + 1].id;
      newEdges.push({
        id: `edge_${ts}_${i}_${Math.random().toString(36).substring(2, 9)}`,
        source,
        target,
        sourceHandle: null,
        targetHandle: null,
        type: 'custom',
        animated: true,
      });
    }

    set(
      produce((state: CanvasStore) => {
        state.edges = state.edges.filter((e) => !removeIds.has(e.id));
        state.edges.push(...newEdges);
        state.hasUnsavedChanges = true;
      })
    );

    // Sync: removed edges become deletes (their IDs are now absent from state.edges
    // but present in dirtyEntityIds → useCanvasSync treats them as deletions).
    removeIds.forEach((id) => setDirty(id, true, 'edge'));
    newEdges.forEach((e) => setDirty(e.id, true, 'edge'));

    get().pushHistory();
    return newEdges.length;
  },

  setParentForNodes: (parentId, childIds) => {
    const { nodes, edges, arrangementId, setDirty } = get();
    const nodeIds = new Set(nodes.map((n) => n.id));
    if (!nodeIds.has(parentId)) return { updated: 0, skipped: childIds.length };

    const uniqueChildIds = Array.from(new Set(childIds)).filter(
      (id) => id !== parentId && nodeIds.has(id)
    );
    if (uniqueChildIds.length === 0) return { updated: 0, skipped: childIds.length };

    // Reparenting replaces the old incoming edge for each child. Check cycles
    // against that effective graph, because old parents are intentionally gone.
    const childSet = new Set(uniqueChildIds);
    const effectiveEdges = edges.filter((edge) => !childSet.has(edge.target));
    const edgeModels: EdgeModel.Model[] = effectiveEdges.map((edge) => ({
      id: edge.id,
      arrangementId: arrangementId || '',
      sourceId: edge.source,
      targetId: edge.target,
      sourceHandleId: edge.sourceHandle ?? undefined,
      targetHandleId: edge.targetHandle ?? undefined,
      type: edge.type || 'default',
      label: typeof edge.label === 'string' ? edge.label : undefined,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const acceptedChildIds = uniqueChildIds.filter((childId) => {
      const descendants = EdgeModel.getDescendantIds(childId, edgeModels);
      return !descendants.includes(parentId);
    });
    if (acceptedChildIds.length === 0) {
      return { updated: 0, skipped: childIds.length };
    }

    get().pushHistory();

    const acceptedSet = new Set(acceptedChildIds);
    const edgesToRemove = edges.filter((edge) => acceptedSet.has(edge.target));
    const removeIds = new Set(edgesToRemove.map((edge) => edge.id));
    const ts = Date.now();
    const newEdges: ReactFlowEdge[] = acceptedChildIds.map((childId, index) => ({
      id: `edge_${ts}_parent_${index}_${Math.random().toString(36).substring(2, 9)}`,
      source: parentId,
      target: childId,
      sourceHandle: null,
      targetHandle: null,
      type: 'custom',
      animated: true,
    }));

    set(
      produce((state: CanvasStore) => {
        state.edges = state.edges.filter((edge) => !removeIds.has(edge.id));
        state.edges.push(...newEdges);
        state.hasUnsavedChanges = true;
      })
    );

    removeIds.forEach((id) => setDirty(id, true, 'edge'));
    newEdges.forEach((edge) => setDirty(edge.id, true, 'edge'));
    get().uncollapseNode(parentId);
    get().pushHistory();

    return {
      updated: acceptedChildIds.length,
      skipped: childIds.length - acceptedChildIds.length,
    };
  },

  // Copy/paste/cut
  copySelectedNodes: () => {
    const { nodes, edges } = get();
    const selectedNodes = nodes.filter((n) => n.selected === true);

    if (selectedNodes.length === 0) {
      toast.info('No nodes selected');
      return;
    }

    // Infra nodes (machines + their terminals) are session state backed by
    // the daemon — duplicating them by clipboard would clone the client
    // side without provisioning a new machine, leaving phantom refs. The
    // proper way to "copy" a machine is the explicit `branchMachine`
    // action in the node menu, so we silently drop them from Ctrl+C.
    const copyable = selectedNodes.filter((n) => !CanvasNode.isInfra(asUI(n.data)));
    const skippedInfra = selectedNodes.length - copyable.length;

    if (copyable.length === 0) {
      toast.info('Machines and terminals can\u2019t be copied — use "Branch machine" instead');
      return;
    }

    // Convert to Note.Model format. React Flow's position is the live source
    // of truth — data.x/y can drift if any code path moves a node and forgets
    // to mirror it (we sync in onNodeDragStop, but defending the clipboard
    // boundary keeps copy/paste correct even if some other path slips).
    const noteModels: Note.Model[] = copyable.map((n) => ({
      ...(n.data as unknown as Note.Model),
      x: n.position.x,
      y: n.position.y,
    }));

    // Convert edges to EdgeModel format
    const edgeModels: EdgeModel.Model[] = edges.map((e) => ({
      id: e.id,
      arrangementId: noteModels[0].arrangementId,
      sourceId: e.source,
      targetId: e.target,
      sourceHandleId: e.sourceHandle || undefined,
      targetHandleId: e.targetHandle || undefined,
      type: e.type || 'smoothstep',
      label: e.label as string | undefined,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    // Create clipboard data (this filters edges to only internal ones)
    const clipboardData = Clipboard.create(noteModels, edgeModels);

    set({ clipboardData });
    const suffix =
      skippedInfra > 0
        ? ` (${skippedInfra} machine${skippedInfra !== 1 ? 's' : ''}/terminal${skippedInfra !== 1 ? 's' : ''} skipped)`
        : '';
    toast.success(`Copied ${copyable.length} node${copyable.length !== 1 ? 's' : ''}${suffix}`);
  },

  cutSelectedNodes: () => {
    const { nodes, copySelectedNodes, deleteNode } = get();
    const selectedNodes = nodes.filter((n) => n.selected === true);

    if (selectedNodes.length === 0) {
      toast.info('No nodes selected');
      return;
    }

    // Only delete what we actually copied — machines/terminals are
    // filtered out of the clipboard (see copySelectedNodes), so cutting
    // them would destroy state that we can't restore via paste.
    const cutList = selectedNodes.filter((n) => !CanvasNode.isInfra(asUI(n.data)));

    if (cutList.length === 0) {
      toast.info('Machines and terminals can\u2019t be cut');
      return;
    }

    // First copy (this also reports any skipped infra nodes to the user)
    copySelectedNodes();

    cutList.forEach((node) => {
      deleteNode(node.id);
    });

    toast.success(`Cut ${cutList.length} node${cutList.length !== 1 ? 's' : ''}`);
  },

  pasteNodes: (position) => {
    const { clipboardData, setDirty } = get();

    if (!clipboardData) {
      toast.error('Nothing to paste');
      return;
    }

    if (!Clipboard.validate(clipboardData)) {
      toast.error('Invalid clipboard data');
      return;
    }

    // Pre-push: see comment in onNodesChange.
    get().pushHistory();

    // Generate new IDs for nodes and create mapping
    const idMap = new Map<string, string>();
    const timestamp = Date.now();
    clipboardData.nodes.forEach((node, index) => {
      idMap.set(node.id, `${timestamp}-${index}-${Math.random().toString(36).substr(2, 9)}`);
    });

    const bbox = clipboardData.nodes.reduce(
      (acc, note) => ({
        minX: Math.min(acc.minX, note.x),
        minY: Math.min(acc.minY, note.y),
        maxX: Math.max(acc.maxX, note.x),
        maxY: Math.max(acc.maxY, note.y),
      }),
      {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      }
    );

    const PASTE_OFFSET = 50;
    const targetCenter = position
      ? { x: position.x, y: position.y }
      : {
          x: (bbox.minX + bbox.maxX) / 2 + PASTE_OFFSET,
          y: (bbox.minY + bbox.maxY) / 2 + PASTE_OFFSET,
        };
    const offsetX = targetCenter.x - (bbox.minX + bbox.maxX) / 2;
    const offsetY = targetCenter.y - (bbox.minY + bbox.maxY) / 2;

    // Map the domain Note.Type to the React Flow node type. Must match
    // Note.Transform.toRfNode — otherwise a TEXT note gets rendered by
    // NoteCard (the "big square" bug). Machines/terminals never reach
    // here because copySelectedNodes drops them, but we keep the full
    // mapping so this function stays correct if that filter changes.
    const rfTypeFor = (t: Note.Type | string | undefined): string =>
      t === 'MACHINE' ? 'machine' : t === 'TERMINAL' ? 'terminal' : t === 'TEXT' ? 'text' : 'note';

    // Create new nodes with offset positions and new IDs.
    // copySelectedNodes filters infra out, so paste only ever handles
    // NOTE / TEXT — they fit the union without reshaping per variant.
    const newNodes = clipboardData.nodes.map((note) => {
      const newId = idMap.get(note.id)!;
      const nextX = note.x + offsetX;
      const nextY = note.y + offsetY;

      return {
        id: newId,
        type: rfTypeFor(note.type),
        position: {
          x: nextX,
          y: nextY,
        },
        data: {
          ...note,
          id: newId,
          x: nextX,
          y: nextY,
          createdAt: new Date(),
          updatedAt: new Date(),
          version: 1,
        } as CanvasNode.UI,
        selected: true,
      } as Node;
    });

    // Create new edges with new IDs
    const newEdges: ReactFlowEdge[] = clipboardData.edges.map((edge, index) => ({
      id: `${timestamp}-edge-${index}-${Math.random().toString(36).substr(2, 9)}`,
      source: idMap.get(edge.sourceId)!,
      target: idMap.get(edge.targetId)!,
      sourceHandle: edge.sourceHandleId || null,
      targetHandle: edge.targetHandleId || null,
      type: 'custom',
      label: edge.label,
      animated: true,
    }));

    // Add nodes and edges to canvas
    set(
      produce((state: CanvasStore) => {
        // Clear all existing selections
        state.nodes = state.nodes.map((node) => ({ ...node, selected: false }));
        // Add new nodes (which are already marked as selected)
        state.nodes = [...state.nodes, ...newNodes];
        state.edges = [...state.edges, ...newEdges];
        state.hasUnsavedChanges = true;
      })
    );

    // Mark all new nodes and edges as dirty
    newNodes.forEach((node) => setDirty(node.id, true, 'node'));
    newEdges.forEach((edge) => setDirty(edge.id, true, 'edge'));

    get().pushHistory();

    toast.success(`Pasted ${newNodes.length} node${newNodes.length !== 1 ? 's' : ''}`);
  },

  // ----- Text-level copy helpers -----

  copyBranchText: async (nodeId: string) => {
    const { nodes, edges, arrangementId } = get();
    const noteModels = nodes.map((n) => n.data as unknown as Note.Model);
    const edgeModels: EdgeModel.Model[] = edges.map((e) => ({
      id: e.id,
      arrangementId: arrangementId || '',
      sourceId: e.source,
      targetId: e.target,
      sourceHandleId: e.sourceHandle || undefined,
      targetHandleId: e.targetHandle || undefined,
      type: e.type || 'default',
      label: (e.label as string) || undefined,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const text = Note.collectBranchText(nodeId, noteModels, edgeModels);
    const depth = EdgeModel.getAncestorIds(nodeId, edgeModels).length + 1;
    try {
      await copyToClipboard(text || '');
      // Mirror copy-content / copy-context: also seed the in-memory paste
      // buffer so the user can drop the branch text into another node.
      set({ copiedContent: text || '' });
      toast.success(`Copied branch (${depth} node${depth !== 1 ? 's' : ''})`);
    } catch (err) {
      toast.error(`Copy failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  },

  copySelectedNodesAsText: async () => {
    const { nodes } = get();
    const selected = sortNodesByReadingOrder(nodes.filter((n) => n.selected === true));
    if (selected.length === 0) {
      toast.info('No nodes selected');
      return;
    }
    const noteModels = nodes.map((n) => n.data as unknown as Note.Model);
    const selectedIds = selected.map((n) => n.id);
    const text = Note.collectTextFromIds(selectedIds, noteModels);
    const selectionDebug = selected.map((node) => ({
      id: node.id,
      type: (node.data as any).type,
      label: (node.data as any).label || null,
      contentLength:
        typeof (node.data as any).content === 'string'
          ? (node.data as any).content.trim().length
          : 0,
    }));

    if (!text.trim()) {
      console.warn('[copySelectedNodesAsText] selected nodes have no text content', selectionDebug);
      toast.info('Selected nodes have no text content');
      return;
    }

    try {
      console.info('[copySelectedNodesAsText] copying selected text', {
        ids: selectedIds,
        nodeCount: selected.length,
        textLength: text.length,
        textPreview: text.length > 200 ? `${text.slice(0, 200)}…` : text,
        selection: selectionDebug,
      });
      await copyToClipboard(text || '');
      console.info('[copySelectedNodesAsText] copy succeeded', {
        ids: selectedIds,
        textLength: text.length,
      });
      toast.success(`Copied text from ${selected.length} node${selected.length !== 1 ? 's' : ''}`);
    } catch (err) {
      console.error('[copySelectedNodesAsText] clipboard copy failed', {
        ids: selectedIds,
        textLength: text.length,
        error: err,
      });
      toast.error(`Copy failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  },

  // ----- Selection helpers (tree traversal) -----

  selectDescendants: (nodeId: string, includeSelf: boolean = true) => {
    const { edges, arrangementId } = get();
    const edgeModels: EdgeModel.Model[] = edges.map((e) => ({
      id: e.id,
      arrangementId: arrangementId || '',
      sourceId: e.source,
      targetId: e.target,
      type: e.type || 'default',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const descendantIds = EdgeModel.getDescendantIds(nodeId, edgeModels);
    const idsToSelect = new Set(includeSelf ? [nodeId, ...descendantIds] : descendantIds);
    set(
      produce((state: CanvasStore) => {
        for (const node of state.nodes) {
          node.selected = idsToSelect.has(node.id);
        }
      })
    );
    toast.success(
      `Selected ${idsToSelect.size} node${idsToSelect.size !== 1 ? 's' : ''} (subtree)`
    );
  },

  selectByTag: (tag: string) => {
    const matchingIds = new Set(
      get()
        .nodes.filter((node) => ((node.data as { tags?: string[] }).tags || []).includes(tag))
        .map((node) => node.id)
    );

    set(
      produce((state: CanvasStore) => {
        for (const node of state.nodes) {
          node.selected = matchingIds.has(node.id);
        }
      })
    );

    if (matchingIds.size === 0) {
      toast.info(`No nodes carry the "${tag}" tag`);
    } else {
      toast.success(
        `Selected ${matchingIds.size} node${matchingIds.size !== 1 ? 's' : ''} tagged "${tag}"`
      );
    }
  },

  selectAncestors: (nodeId: string, includeSelf: boolean = true) => {
    const { edges, arrangementId } = get();
    const edgeModels: EdgeModel.Model[] = edges.map((e) => ({
      id: e.id,
      arrangementId: arrangementId || '',
      sourceId: e.source,
      targetId: e.target,
      type: e.type || 'default',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const ancestorIds = EdgeModel.getAllAncestorIds(nodeId, edgeModels);
    const idsToSelect = new Set(includeSelf ? [nodeId, ...ancestorIds] : ancestorIds);
    set(
      produce((state: CanvasStore) => {
        for (const node of state.nodes) {
          node.selected = idsToSelect.has(node.id);
        }
      })
    );
    toast.success(
      `Selected ${idsToSelect.size} node${idsToSelect.size !== 1 ? 's' : ''} (ancestors)`
    );
  },

  // ----- Compact / expand -----
  // Scales every positionable node's position toward/away from the centroid.
  // All node types participate — pass nodeIds to scope to a subset.
  compactCanvas: (
    factor: number,
    referencePositions?: Record<string, { x: number; y: number }>,
    nodeIds?: string[],
    options?: { transient?: boolean }
  ) => {
    if (!isFinite(factor) || factor <= 0) return;
    const { nodes, setDirty } = get();
    const transient = options?.transient === true;
    const nodeIdSet = nodeIds && nodeIds.length > 0 ? new Set(nodeIds) : null;

    const eligible = nodes.filter((n) => {
      if (nodeIdSet) return nodeIdSet.has(n.id);
      return true;
    });
    if (eligible.length === 0) return;

    // Reference positions for smooth live updates, or capture-now for one-shot.
    // Build from the eligible set so the centroid isn't skewed by excluded nodes.
    const basePositions: Record<string, { x: number; y: number }> =
      referencePositions ??
      Object.fromEntries(eligible.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));

    const eligibleBasePoints = eligible
      .map((n) => basePositions[n.id])
      .filter((p): p is { x: number; y: number } => !!p);
    if (eligibleBasePoints.length === 0) return;
    const centroidX = eligibleBasePoints.reduce((s, p) => s + p.x, 0) / eligibleBasePoints.length;
    const centroidY = eligibleBasePoints.reduce((s, p) => s + p.y, 0) / eligibleBasePoints.length;

    const nextPositionById = new Map<string, { x: number; y: number }>();
    const dirtyIds: string[] = [];
    let hasVisualChange = false;

    for (const node of eligible) {
      const base = basePositions[node.id];
      if (!base) continue;
      const dx = base.x - centroidX;
      const dy = base.y - centroidY;
      const next = {
        x: centroidX + dx * factor,
        y: centroidY + dy * factor,
      };
      nextPositionById.set(node.id, next);

      const data = node.data as { x?: number; y?: number };
      const visualChanged =
        node.position.x !== next.x ||
        node.position.y !== next.y ||
        data.x !== next.x ||
        data.y !== next.y;
      if (visualChanged) hasVisualChange = true;

      if (!transient && (visualChanged || base.x !== next.x || base.y !== next.y)) {
        dirtyIds.push(node.id);
      }
    }

    if (hasVisualChange) {
      set((state) => {
        let changed = false;
        const nextNodes = state.nodes.map((node) => {
          const next = nextPositionById.get(node.id);
          if (!next) return node;

          const data = node.data as { x?: number; y?: number };
          if (
            node.position.x === next.x &&
            node.position.y === next.y &&
            data.x === next.x &&
            data.y === next.y
          ) {
            return node;
          }

          changed = true;
          return {
            ...node,
            position: next,
            data: {
              ...node.data,
              x: next.x,
              y: next.y,
            },
          };
        });

        return changed
          ? {
              nodes: nextNodes,
              ...(transient ? {} : { hasUnsavedChanges: true }),
            }
          : {};
      });
    }

    if (!transient) {
      for (const id of dirtyIds) setDirty(id, true, 'node');
    }
  },

  // ----- Alignment / distribution -----
  // Snap selected (or given) nodes into a clean geometric layout. Uses the
  // nodes' current positions as the anchor: "horizontal-line" keeps the first
  // node's y and reshuffles the rest to the right of it with uniform spacing,
  // "grid" packs them into a square-ish grid sorted by current reading order.
  // Pure arithmetic — no dagre, so it's cheap and predictable.
  alignSelection: (mode, nodeIdsArg) => {
    const { nodes, setDirty } = get();
    const nodeIds = nodeIdsArg
      ? nodeIdsArg
      : nodes.filter((n) => n.selected === true).map((n) => n.id);

    if (nodeIds.length < 2) {
      toast.info('Select at least 2 nodes to align');
      return;
    }

    const targets = nodes.filter((n) => nodeIds.includes(n.id));
    if (targets.length < 2) {
      toast.info('Select at least 2 nodes to align');
      return;
    }

    // Reading order: top-left → bottom-right. Used as the canonical order so
    // alignment is reproducible even when the user clicked nodes in weird order.
    const sortedByReading = sortNodesByReadingOrder(targets);

    // Gap defaults — match the visual NODE_DIMENSIONS plus breathing room.
    const H_GAP = 360;
    const V_GAP = 260;

    const newPositions = new Map<string, { x: number; y: number }>();

    if (mode === 'horizontal-line') {
      const y = sortedByReading[0].position.y;
      let x = sortedByReading[0].position.x;
      for (const n of sortedByReading) {
        newPositions.set(n.id, { x, y });
        x += H_GAP;
      }
    } else if (mode === 'vertical-line') {
      const x = sortedByReading[0].position.x;
      let y = sortedByReading[0].position.y;
      for (const n of sortedByReading) {
        newPositions.set(n.id, { x, y });
        y += V_GAP;
      }
    } else if (mode === 'grid') {
      const cols = Math.ceil(Math.sqrt(sortedByReading.length));
      const originX = sortedByReading[0].position.x;
      const originY = sortedByReading[0].position.y;
      sortedByReading.forEach((n, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        newPositions.set(n.id, {
          x: originX + col * H_GAP,
          y: originY + row * V_GAP,
        });
      });
    } else if (mode === 'distribute-h' || mode === 'distribute-v') {
      // Distribute preserves the extremes and spaces the middle nodes equally.
      const axis = mode === 'distribute-h' ? 'x' : 'y';
      const sorted = [...targets].sort((a, b) => a.position[axis] - b.position[axis]);
      const first = sorted[0].position[axis];
      const last = sorted[sorted.length - 1].position[axis];
      const step = (last - first) / (sorted.length - 1);
      sorted.forEach((n, i) => {
        newPositions.set(n.id, {
          x: axis === 'x' ? first + step * i : n.position.x,
          y: axis === 'y' ? first + step * i : n.position.y,
        });
      });
    }

    set(
      produce((state: CanvasStore) => {
        for (const node of state.nodes) {
          const next = newPositions.get(node.id);
          if (!next) continue;
          node.position = next;
          (node.data as any).x = next.x;
          (node.data as any).y = next.y;
        }
        state.hasUnsavedChanges = true;
      })
    );

    for (const id of newPositions.keys()) setDirty(id, true, 'node');
    toast.success(`Aligned ${newPositions.size} node${newPositions.size !== 1 ? 's' : ''}`);
  },

  // Content clipboard (for text within nodes)
  setCopiedContent: (content: string) => set({ copiedContent: content }),
  getCopiedContent: () => get().copiedContent,

  // Running state
  setNodeRunning: (nodeId, isRunning) => {
    set(
      produce((state: CanvasStore) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          node.data.status = isRunning ? 'running' : 'idle';
        }
      })
    );
  },

  runNode: async (nodeId, actionId) => {
    const {
      arrangementId,
      selectedModel,
      childNodeOffset,
      dirtyEntityIds,
      dirtyEntityTypes,
      nodes,
      edges,
    } = get();
    if (!arrangementId) {
      console.error('No arrangement selected');
      return;
    }

    // Get source node and its scale
    const sourceNode = nodes.find((n) => n.id === nodeId);
    // Guard here so stray callers don't queue a bogus job against the worker.
    // Only content-role notes can originate an action (see Note.capabilities).
    if (!Note.capabilities(sourceNode?.data as { type?: Note.Type } | undefined).canRunAction) {
      console.warn('[runNode] ignored: node cannot run action', { nodeId });
      return;
    }
    const parentScale = sourceNode ? ((sourceNode.data.scale as number) ?? 1.0) : 1.0;

    const scaledChildNodeOffset = {
      x: childNodeOffset.x * parentScale,
      y: childNodeOffset.y * parentScale,
    };

    // Use shared recursive algorithm to determine if this is single or multiple path execution
    const edgeModels = edges.map((e) => ({
      id: e.id,
      sourceId: e.source,
      targetId: e.target,
      sourceHandleId: e.sourceHandle || '',
      targetHandleId: e.targetHandle || '',
      type: e.type || 'default',
      label: (e.label as string) || '',
      arrangementId: arrangementId,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    // Build ancestorOverride map from all nodes
    const ancestorOverrides = new Map<string, string[]>();
    nodes.forEach((node) => {
      const nodeData = node.data as CanvasNode.UI | undefined;
      if (nodeData?.ancestorOverride && nodeData.ancestorOverride.length > 0) {
        ancestorOverrides.set(node.id, nodeData.ancestorOverride);
      }
    });

    // Use shared recursive path finding algorithm
    const allPaths = EdgeModel.findPathsWithOverrides(nodeId, edgeModels, ancestorOverrides);

    if (allPaths.length > 1) {
      console.info(`[Multi-Path] Node has ${allPaths.length} paths - executing Cartesian product`, {
        nodeId,
        paths: allPaths,
      });
      toast.info(`Cartesian product execution`, {
        description: `This node has ${allPaths.length} paths to root. Creating ${allPaths.length} children (one per path).`,
        duration: 4000,
      });
    } else {
      console.info(`[Single-Path] Node has single path`, {
        nodeId,
        path: allPaths[0],
      });
    }

    try {
      // Only send patchPayload if there are dirty changes
      let patchPayload: Note.DTO.PatchPayload | undefined;

      if (dirtyEntityIds.size > 0) {
        // Separate dirty IDs by type
        const currentDirtyIds = Array.from(dirtyEntityIds);
        const existingNodeIds = new Set(nodes.map((n) => n.id));
        const existingEdgeIds = new Set(edges.map((e) => e.id));

        const dirtyNodeIds = currentDirtyIds.filter((id) => existingNodeIds.has(id));
        const dirtyEdgeIds = currentDirtyIds.filter((id) => existingEdgeIds.has(id));

        const deletedIds = currentDirtyIds.filter(
          (id) => !existingNodeIds.has(id) && !existingEdgeIds.has(id)
        );
        const deletedNodeIds: string[] = [];
        const deletedEdgeIds: string[] = [];

        deletedIds.forEach((id) => {
          const type = dirtyEntityTypes.get(id);
          if (type === 'edge') {
            deletedEdgeIds.push(id);
          } else {
            deletedNodeIds.push(id);
          }
        });

        patchPayload = {
          dirtyNodes: nodes
            .filter((node) => dirtyNodeIds.includes(node.id))
            .map((node) => ({
              id: node.id,
              x: node.position.x,
              y: node.position.y,
              label: (node.data.label as string | null) || null,
              color: (node.data.color as string | null) || null,
              scale: (node.data.scale as number) || 1.0,
              isMergePoint: (node.data.isMergePoint as boolean) || false, // DAG support
              content: (node.data.content as string) || '',
            })),
          dirtyEdges: edges
            .filter((edge) => dirtyEdgeIds.includes(edge.id))
            .map((edge) => ({
              id: edge.id,
              source: edge.source,
              target: edge.target,
              sourceHandle: edge.sourceHandle || null,
              targetHandle: edge.targetHandle || null,
              type: edge.type || 'default',
              label: (edge.label as string) || '',
            })),
          deletedNodeIds,
          deletedEdgeIds,
          demotedNodeIds: [],
        };
      }

      // Execute action with selected model
      const result = await ArrangementService.executeAction(arrangementId, {
        actionId,
        nodeId,
        model: selectedModel,
        childNodeOffset: scaledChildNodeOffset,
        parentScale: parentScale < 1.0 ? parentScale : undefined, // Pass parent scale to backend
        patchPayload,
      });

      // Handle the result using Union.match
      Union.match(
        {
          success: (data: Arrangement.Response.RunResult) => {
            Analytics.track('action_run_started', {
              arrangementId,
              sourceNoteId: nodeId,
              actionId,
              model: selectedModel,
              pathCount: allPaths.length,
              hasUnsavedPatch: !!patchPayload,
              dirtyNodeCount: patchPayload?.dirtyNodes.length ?? 0,
              dirtyEdgeCount: patchPayload?.dirtyEdges.length ?? 0,
              deletedNodeCount: patchPayload?.deletedNodeIds.length ?? 0,
              deletedEdgeCount: patchPayload?.deletedEdgeIds.length ?? 0,
            });

            // Action result is always a freshly-spawned RUNNING child + edge.
            // Defensive dedup: SSE may also emit node:created for the same id
            // (race / EventSource replay). Last-write-wins by id, never push
            // a duplicate that React Flow would warn about.
            // Pre-push: see comment in onNodesChange.
            get().pushHistory();
            set(
              produce((state: CanvasStore) => {
                const existingNodeIdx = state.nodes.findIndex(
                  (n) => n.id === data.responseNode.id
                );
                if (existingNodeIdx === -1) state.nodes.push(data.responseNode as Node);
                else state.nodes[existingNodeIdx] = data.responseNode as Node;

                const existingEdgeIdx = state.edges.findIndex(
                  (e) => e.id === data.responseEdge.id
                );
                if (existingEdgeIdx === -1) state.edges.push(data.responseEdge as ReactFlowEdge);
                else state.edges[existingEdgeIdx] = data.responseEdge as ReactFlowEdge;

                state.runStartedAt.set(data.responseNode.id, Date.now());
                // Don't set hasUnsavedChanges - backend already has these entities
              })
            );

            // AI-generated child expands its parent (same reason as onConnect).
            get().uncollapseNode(nodeId);

            // Select the new node
            set({ selectedNodeId: data.responseNode.id });

            // Run = discrete user action. Capture the post-add state so Ctrl+Z
            // can roll the AI run back (sync will then delete on backend).
            get().pushHistory();
          },
          error: (err) => {
            console.error('Run failed:', err.message);
          },
        },
        result
      );
    } catch (error) {
      console.error('Run failed:', error);
    }
  },

  createChildFromSelection: (sourceNodeId, selectedText) => {
    const { nodes, createNode, onConnect, childNodeOffset } = get();
    const sourceNode = nodes.find((n) => n.id === sourceNodeId);
    if (!sourceNode) return;

    // Inherit parent scale and offset
    const parentScale = (sourceNode.data.scale as number) ?? 1.0;
    const scaledOffset = {
      x: childNodeOffset.x * parentScale,
      y: childNodeOffset.y * parentScale,
    };

    // Format the selected text as a blockquote
    const quotedText = selectedText
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');

    const newPosition = {
      x: sourceNode.position.x + scaledOffset.x,
      y: sourceNode.position.y + scaledOffset.y,
    };

    const newNodeId = createNode(newPosition, quotedText, parentScale);
    if (!newNodeId) return;

    setTimeout(() => {
      onConnect({
        source: sourceNodeId,
        target: newNodeId,
        sourceHandle: null,
        targetHandle: null,
      });
    }, 10);
  },

  // Canvas state management — see ArrangementSnapshot. Switching tabs SAVES
  // the leaving arrangement's local state and RESTORES the target's, so that
  // a round-trip A→B→A returns the user to exactly the state they left
  // (including in-progress edits and undo history) regardless of what the
  // RQ cache happens to hold for A.
  setArrangementId: (id) => {
    const oldId = get().arrangementId;
    if (oldId === id) return;

    // Read the new arrangement's collapse state from localStorage BEFORE
    // entering produce(). localStorage is sync but lives outside the Immer
    // draft, so we resolve it up-front and apply inside.
    const savedCollapse = id ? readSavedCollapse(id) : null;
    const savedContext = id ? readCanvasContext(id) : null;

    set(
      produce((state: CanvasStore) => {
        // Save the leaving arrangement's local state (only when there's a real
        // arrangement to save — avoid stamping a snapshot for the initial null).
        if (oldId) {
          state.arrangementSnapshots.set(oldId, {
            nodes: state.nodes,
            edges: state.edges,
            history: state.history,
            currentHistoryIndex: state.currentHistoryIndex,
          });
        }

        state.arrangementId = id;
        state.selectedNodeId = null;

        // Restore the target's snapshot if we have one. Otherwise leave nodes
        // alone — Canvas's load effect will populate from the RQ cache on its
        // first mount under this id.
        if (id) {
          const snap = state.arrangementSnapshots.get(id);
          if (snap) {
            state.nodes = snap.nodes;
            state.edges = snap.edges;
            state.history = snap.history;
            state.currentHistoryIndex = snap.currentHistoryIndex;
          }
        }

        // Hydrate collapse state from localStorage. When switching to no
        // arrangement (id=null) or to an arrangement with no saved state,
        // reset to clean slate so a previous arrangement's flags don't leak.
        state.hiddenNodeIds = new Set(savedCollapse?.hidden ?? []);
        state.collapseStates = new Map(savedCollapse?.states ?? []);
        state.collapsedNodeIds = new Set(state.collapseStates.keys());

        state.activeLayer = savedContext?.activeLayer ?? null;
        state.visibleLayers = new Set(savedContext?.visibleLayers ?? []);
        state.knownLayers = new Set(savedContext?.knownLayers ?? []);
        state.globalVisible = savedContext?.globalVisible ?? true;
      })
    );
  },

  loadCanvasState: (nodes, edges) => {
    // Set loading flag first
    set({ isLoadingCanvas: true });

    // Preserve running states from current nodes
    const currentNodes = get().nodes;
    const runningNodeStates = new Map<string, 'running' | 'idle'>();

    // Collect running states from current nodes
    currentNodes.forEach((node) => {
      if (node.data.status === 'running') {
        runningNodeStates.set(node.id, 'running');
      }
    });

    // Apply running states to new nodes
    const nodesWithPreservedState = nodes.map((node) => {
      const preservedStatus = runningNodeStates.get(node.id);
      if (preservedStatus === 'running') {
        return {
          ...node,
          data: {
            ...node.data,
            status: 'running',
          },
        };
      }
      return node;
    });

    // Ensure all edges use the custom type and are animated
    const edgesWithCustomType = edges.map((edge) => ({
      ...edge,
      type: 'custom',
      animated: true,
    }));

    // Initial history snapshot must follow the SAME shape that pushHistory
    // produces — tracked-only (USER/ASSISTANT/etc), no MACHINE/TERMINAL.
    // Otherwise undo back to history[0] concats daemon nodes from history
    // with the SAME daemon nodes from currentUntrackedNodes → duplicate keys.
    const { trackedNodes: initialTrackedNodes, trackedEdges: initialTrackedEdges } =
      partitionByDaemon(nodesWithPreservedState, edgesWithCustomType);
    const initialNormalized = normalizeNodesForHistory(initialTrackedNodes);

    // Hydrate MachineWindow store from any persisted layouts on MACHINE
    // notes. Invalid JSON falls back to a fresh layout — don't crash the
    // whole canvas because one row's payload is malformed.
    const mwStore = useMachineWindowStore.getState();
    for (const node of nodesWithPreservedState) {
      const data = node.data as { type?: string; machineId?: string; windowLayout?: unknown };
      if (data?.type !== 'MACHINE') continue;
      const machineId = data.machineId || node.id;
      if (!data.windowLayout) continue;
      try {
        const valid = MachineWindow.validate.layout(data.windowLayout);
        mwStore.hydrate(node.id, valid);
      } catch {
        mwStore.ensure(node.id, machineId);
      }
    }

    // First visit (no persisted context → both sets empty) → show every
    // on-disk layer so the user doesn't open a "where did my notes go"
    // ghost canvas. Once they toggle anything, persistence keeps at least
    // one set non-empty and this branch stops firing.
    const cur = get();
    const fromNodes = Note.Layers.collectKnown(
      nodesWithPreservedState.map((n) => n.data as any),
    );
    const shouldSeedLayers =
      fromNodes.length > 0 &&
      cur.visibleLayers.size === 0 &&
      cur.knownLayers.size === 0;

    set({
      nodes: nodesWithPreservedState,
      edges: edgesWithCustomType,
      hasUnsavedChanges: false,
      selectedNodeId: null,
      isLoadingCanvas: false, // Clear loading flag after state is loaded
      // Fresh canvas → no in-flight runs from this session, drop stale entries.
      runStartedAt: new Map(),
      branchingNodes: new Map(),
      history: [
        { nodes: initialNormalized, edges: initialTrackedEdges },
      ],
      currentHistoryIndex: 0,
      ...(shouldSeedLayers
        ? {
            visibleLayers: new Set(fromNodes),
            knownLayers: new Set(fromNodes),
          }
        : {}),
    });

    // Persist the seed so the next visit reads "user accepted all" rather
    // than "no preference, seed again".
    if (shouldSeedLayers) persistCanvasContextFor(get(), {});
  },

  clearCanvas: () => {
    set({
      nodes: [],
      edges: [],
      selectedNodeId: null,
      hasUnsavedChanges: false,
    });
  },

  setHasUnsavedChanges: (value) => set({ hasUnsavedChanges: value }),

  clearSelectedNode: () => set((state) => (state.selectedNodeId === null ? state : { selectedNodeId: null })),

  setGetViewportCenter: (fn) => set({ getViewportCenter: fn }),

  // Auto layout using Dagre
  // If nodeIds provided, only layout those nodes within their current bounding box
  autoLayout: (direction = 'LR', nodeIds?: string[]) => {
    // Pre-push: see comment in onNodesChange.
    get().pushHistory();

    const { nodes, edges } = get();

    // 1. Clear orphaned nodes first
    const cleanedNodes = clearOrphanedNodes(nodes);

    // 2. Filter to only root-level nodes (children stay in their groups)
    let rootNodes = filterRootNodes(cleanedNodes);

    // 3. If specific nodeIds provided, filter to only those nodes
    const isPartialLayout = nodeIds && nodeIds.length > 0;
    if (isPartialLayout) {
      const nodeIdSet = new Set(nodeIds);
      rootNodes = rootNodes.filter((n) => nodeIdSet.has(n.id));
    }

    // 4. Calculate original center (for partial layouts - to keep nodes in same area)
    let originalCenterX = 0,
      originalCenterY = 0;
    if (isPartialLayout && rootNodes.length > 0) {
      const bounds = rootNodes.reduce(
        (b, n) => {
          const w = (n as any).width ?? Canvas.NODE_DIMENSIONS.WIDTH;
          const h = (n as any).height ?? Canvas.NODE_DIMENSIONS.HEIGHT;
          return {
            minX: Math.min(b.minX, n.position.x),
            minY: Math.min(b.minY, n.position.y),
            maxX: Math.max(b.maxX, n.position.x + w),
            maxY: Math.max(b.maxY, n.position.y + h),
          };
        },
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      );
      originalCenterX = (bounds.minX + bounds.maxX) / 2;
      originalCenterY = (bounds.minY + bounds.maxY) / 2;
    }

    // 5. Setup dagre graph for layout
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({
      rankdir: direction,
      nodesep: Canvas.NODE_SPACING.HORIZONTAL * (direction === 'LR' ? 1.4 : 1),
      ranksep: Canvas.NODE_SPACING.VERTICAL * (direction === 'LR' ? 1 : 0.8),
      marginx: 0,
      marginy: 0,
      ranker: 'tight-tree',
      align: 'UL',
    });

    // 6. Add root nodes to graph
    rootNodes.forEach((n) => {
      const width = (n as any).width ?? Canvas.NODE_DIMENSIONS.WIDTH;
      const height = (n as any).height ?? Canvas.NODE_DIMENSIONS.HEIGHT;
      g.setNode(n.id, { width, height });
    });

    // 7. Add edges between root nodes
    const rootNodeIds = new Set(rootNodes.map((n) => n.id));
    edges.forEach((e) => {
      if (rootNodeIds.has(e.source) && rootNodeIds.has(e.target)) {
        g.setEdge(String(e.source), String(e.target));
      }
    });

    // 8. Compute layout
    dagre.layout(g);

    // 9. Calculate dagre output center and offset (for partial layouts)
    let offsetX = 0,
      offsetY = 0;
    if (isPartialLayout && rootNodes.length > 0) {
      // Get dagre output bounds to find its center
      const dagreBounds = rootNodes.reduce(
        (bounds, n) => {
          const layoutNode = g.node(n.id);
          if (!layoutNode) return bounds;
          const w = (n as any).width ?? Canvas.NODE_DIMENSIONS.WIDTH;
          const h = (n as any).height ?? Canvas.NODE_DIMENSIONS.HEIGHT;
          const x = layoutNode.x - w / 2;
          const y = layoutNode.y - h / 2;
          return {
            minX: Math.min(bounds.minX, x),
            minY: Math.min(bounds.minY, y),
            maxX: Math.max(bounds.maxX, x + w),
            maxY: Math.max(bounds.maxY, y + h),
          };
        },
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      );

      const dagreCenterX = (dagreBounds.minX + dagreBounds.maxX) / 2;
      const dagreCenterY = (dagreBounds.minY + dagreBounds.maxY) / 2;

      // Translate dagre output so its center aligns with original center
      offsetX = originalCenterX - dagreCenterX;
      offsetY = originalCenterY - dagreCenterY;
    }

    // 10. Apply new positions to root nodes only
    set(
      produce((state: CanvasStore) => {
        state.nodes = state.nodes.map((n) => {
          // Skip child nodes - they use relative positioning
          if (n.parentId) return n;

          // Apply dagre layout position to root nodes
          const layoutNode = g.node(n.id);
          if (!layoutNode) return n;

          const width = (n as any).width ?? Canvas.NODE_DIMENSIONS.WIDTH;
          const height = (n as any).height ?? Canvas.NODE_DIMENSIONS.HEIGHT;

          // Calculate position with offset for partial layouts
          const x = layoutNode.x - width / 2 + offsetX;
          const y = layoutNode.y - height / 2 + offsetY;

          return {
            ...n,
            position: { x, y },
          };
        });

        // 11. Topological sort to maintain parent-before-child order
        state.nodes = topologicalSort(state.nodes);
        state.hasUnsavedChanges = true;
      })
    );

    // 12. Mark root nodes as dirty for sync
    rootNodes.forEach((n) => get().setDirty(n.id, true, 'node'));

    get().pushHistory();
  },

  // Model selection
  setSelectedModel: (model) => {
    set({ selectedModel: model });
    // Persist to localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem('piano-selected-model', model);
    }
  },

  // Dirty tracking implementations
  setDirty: (entityId, isDirty, type) => {
    set(
      produce((state: CanvasStore) => {
        if (isDirty) {
          // Create NEW Set to trigger React re-render
          state.dirtyEntityIds = new Set(state.dirtyEntityIds).add(entityId);
          // Track the type if provided
          if (type) {
            state.dirtyEntityTypes.set(entityId, type);
          }
          state.hasUnsavedChanges = true;
          // CRITICAL: Update timestamp on EVERY change, even if already dirty
          // This ensures debounce timer resets on each keystroke
          state.lastChangeTimestamp = Date.now();
        } else {
          // Create NEW Set without the ID
          const newSet = new Set(state.dirtyEntityIds);
          newSet.delete(entityId);
          state.dirtyEntityIds = newSet;
          state.dirtyEntityTypes.delete(entityId);
          state.hasUnsavedChanges = newSet.size > 0;
        }
      })
    );
  },

  setDemoted: (nodeId) => {
    set(
      produce((state: CanvasStore) => {
        state.demotedNodeIds = new Set(state.demotedNodeIds).add(nodeId);
      })
    );
  },

  clearDemoted: (ids) => {
    if (ids.length === 0) return;
    set(
      produce((state: CanvasStore) => {
        const next = new Set(state.demotedNodeIds);
        ids.forEach((id) => next.delete(id));
        state.demotedNodeIds = next;
      })
    );
  },

  // Atomic cleanup for specific IDs (prevents infinite loop)
  clearDirty: (ids) => {
    set(
      produce((state: CanvasStore) => {
        const newSet = new Set(state.dirtyEntityIds);
        ids.forEach((id) => {
          newSet.delete(id);
          state.dirtyEntityTypes.delete(id);
        });
        state.dirtyEntityIds = newSet;
        state.hasUnsavedChanges = newSet.size > 0;
      })
    );
  },

  clearAllDirty: () => {
    set(
      produce((state: CanvasStore) => {
        state.dirtyEntityIds = new Set();
        state.dirtyEntityTypes = new Map();
        state.hasUnsavedChanges = false;
      })
    );
  },

  setIsSyncing: (isSyncing) => set({ isSyncing }),

  // Two-phase sync — see field comment on `dirtyEntityIds` / `dirtyInFlightIds`.
  beginSync: () => {
    const { dirtyEntityIds, dirtyEntityTypes } = get();
    const ids = Array.from(dirtyEntityIds);
    const types = new Map(dirtyEntityTypes);
    set(
      produce((state: CanvasStore) => {
        // Replace any prior in-flight set (there shouldn't be one — beginSync
        // is gated by `isSyncing` on the caller side — but be defensive).
        state.dirtyInFlightIds = new Set(state.dirtyEntityIds);
        state.dirtyInFlightTypes = new Map(state.dirtyEntityTypes);
        state.dirtyEntityIds = new Set();
        state.dirtyEntityTypes = new Map();
        // `hasUnsavedChanges` reflects user-visible "stuff still to send".
        // After beginSync the dirty set is empty AND the in-flight payload
        // is being sent — show "syncing" via `isSyncing`, not "unsaved".
        state.hasUnsavedChanges = false;
      })
    );
    return { ids, types };
  },

  endSyncSuccess: (patchArrangementId, processedIds) => {
    set(
      produce((state: CanvasStore) => {
        const processed = new Set(processedIds);

        // Cross-arrangement ACK: user switched away while the PATCH was in
        // flight. Don't merge unprocessed items into the CURRENT arrangement's
        // dirty set — they belong to a different arrangement and would be
        // misinterpreted as phantom deletes on the next sync. The local
        // snapshot for `patchArrangementId` already holds the user's edits,
        // so visually nothing is lost on return. Any unprocessed items miss
        // one sync cycle — the user's next touch re-dirties and they sync.
        if (state.arrangementId !== patchArrangementId) {
          const unacked = Array.from(state.dirtyInFlightIds).filter((i) => !processed.has(i));
          if (unacked.length > 0) {
            console.warn(
              `[SYNC] Cross-arrangement partial success for ${patchArrangementId}; ` +
                `unacked items not auto-retried:`,
              unacked
            );
          }
          state.dirtyInFlightIds = new Set();
          state.dirtyInFlightTypes = new Map();
          return;
        }

        // Remove acknowledged IDs from in-flight.
        const remaining = new Set<string>();
        state.dirtyInFlightIds.forEach((id) => {
          if (processed.has(id)) {
            state.dirtyInFlightTypes.delete(id);
          } else {
            remaining.add(id);
          }
        });
        // Anything still in-flight (i.e. NOT processed) gets merged BACK into
        // dirty so the next sync round retries it.
        remaining.forEach((id) => {
          state.dirtyEntityIds.add(id);
          const t = state.dirtyInFlightTypes.get(id);
          if (t) state.dirtyEntityTypes.set(id, t);
        });
        state.dirtyInFlightIds = new Set();
        state.dirtyInFlightTypes = new Map();
        state.hasUnsavedChanges = state.dirtyEntityIds.size > 0;
      })
    );
  },

  endSyncFailure: (patchArrangementId) => {
    set(
      produce((state: CanvasStore) => {
        // Cross-arrangement failure: same rationale as endSyncSuccess. Drop
        // the in-flight rather than pollute the current arrangement's dirty
        // set. Snapshot[patchArrangementId] still has the local edits; server
        // is stale for that arrangement until the user returns and re-edits.
        if (state.arrangementId !== patchArrangementId) {
          const lost = Array.from(state.dirtyInFlightIds);
          if (lost.length > 0) {
            console.warn(
              `[SYNC] Cross-arrangement patch failure for ${patchArrangementId}; ` +
                `server will be stale until user returns and re-edits:`,
              lost
            );
          }
          state.dirtyInFlightIds = new Set();
          state.dirtyInFlightTypes = new Map();
          return;
        }

        // Whole sync failed — merge in-flight back to dirty for retry.
        state.dirtyInFlightIds.forEach((id) => {
          state.dirtyEntityIds.add(id);
          const t = state.dirtyInFlightTypes.get(id);
          if (t) state.dirtyEntityTypes.set(id, t);
        });
        state.dirtyInFlightIds = new Set();
        state.dirtyInFlightTypes = new Map();
        state.hasUnsavedChanges = state.dirtyEntityIds.size > 0;
      })
    );
  },

  // Undo/Redo implementations.
  //
  // The store is immutable end-to-end (every mutation goes through Immer's
  // produce), so history snapshots can hold direct references to the
  // tracked arrays. No JSON deep clone needed — old refs remain valid
  // because nothing ever mutates them in place. JSON.parse(JSON.stringify)
  // here was previously the single biggest cost on the canvas: ~100ms on
  // 500 nodes per push, and pushHistory fires on every structural edit.
  pushHistory: () => {
    const { nodes, edges, history, currentHistoryIndex } = get();
    const newHistory = history.slice(0, currentHistoryIndex + 1);

    const { trackedNodes, trackedEdges } = partitionByDaemon(nodes, edges);
    const normalizedNodes = normalizeNodesForHistory(trackedNodes);

    const snapshot = { nodes: normalizedNodes, edges: trackedEdges };

    // Element-wise reference equality. Catches the "only daemon-side ops
    // changed the store" case (a machine added/moved, tracked slice still
    // identical) without serialising the world. Each comparison is a
    // pointer check — sub-millisecond for 500 nodes.
    const last = newHistory[newHistory.length - 1];
    if (
      last
      && last.nodes.length === snapshot.nodes.length
      && last.edges.length === snapshot.edges.length
      && last.nodes.every((n, i) => n === snapshot.nodes[i])
      && last.edges.every((e, i) => e === snapshot.edges[i])
    ) {
      return;
    }

    newHistory.push(snapshot);
    if (newHistory.length > 50) newHistory.shift();

    set({
      history: newHistory,
      currentHistoryIndex: newHistory.length - 1,
    });
  },

  undo: () => {
    const { history, currentHistoryIndex, nodes: currentNodes, edges: currentEdges } = get();

    if (currentHistoryIndex > 0) {
      const previousState = history[currentHistoryIndex - 1];
      // History holds immutable refs; mergeRuntimeState below produces a new
      // immutable copy via Immer when it needs to merge runtime state.
      const restoredTrackedNodes = previousState.nodes;
      const restoredTrackedEdges = previousState.edges;

      // Daemon-backed slice (machines/terminals + their edges) is preserved
      // exactly as-is — undo doesn't touch it. Only the tracked slice is
      // rolled back.
      const {
        trackedNodes: currentTrackedNodes,
        untrackedNodes: currentUntrackedNodes,
        trackedEdges: currentTrackedEdges,
        untrackedEdges: currentUntrackedEdges,
      } = partitionByDaemon(currentNodes, currentEdges);

      // Merge current runtime state (status/content) back into assistant nodes
      const mergedTracked = mergeRuntimeState(restoredTrackedNodes, currentNodes);
      const newNodes = [...mergedTracked, ...currentUntrackedNodes];
      const newEdges = [...restoredTrackedEdges, ...currentUntrackedEdges];

      // Diff over the tracked slice only — daemon entities never count as
      // dirty here (they weren't in history to begin with).
      const normalizedCurrent = normalizeNodesForHistory(currentTrackedNodes);
      const normalizedNew = normalizeNodesForHistory(mergedTracked);
      const { changedNodeIds, changedEdgeIds } = diffCanvasStates(
        normalizedCurrent,
        normalizedNew,
        currentTrackedEdges,
        restoredTrackedEdges
      );

      // Mark all changed entities as dirty for sync
      changedNodeIds.forEach((id) => get().setDirty(id, true, 'node'));
      changedEdgeIds.forEach((id) => get().setDirty(id, true, 'edge'));

      set({
        nodes: newNodes,
        edges: newEdges,
        currentHistoryIndex: currentHistoryIndex - 1,
        hasUnsavedChanges: true,
      });
    }
  },

  redo: () => {
    const { history, currentHistoryIndex, nodes: currentNodes, edges: currentEdges } = get();

    if (currentHistoryIndex < history.length - 1) {
      const nextState = history[currentHistoryIndex + 1];
      const restoredTrackedNodes = nextState.nodes;
      const restoredTrackedEdges = nextState.edges;

      const {
        trackedNodes: currentTrackedNodes,
        untrackedNodes: currentUntrackedNodes,
        trackedEdges: currentTrackedEdges,
        untrackedEdges: currentUntrackedEdges,
      } = partitionByDaemon(currentNodes, currentEdges);

      const mergedTracked = mergeRuntimeState(restoredTrackedNodes, currentNodes);
      const newNodes = [...mergedTracked, ...currentUntrackedNodes];
      const newEdges = [...restoredTrackedEdges, ...currentUntrackedEdges];

      const normalizedCurrent = normalizeNodesForHistory(currentTrackedNodes);
      const normalizedNew = normalizeNodesForHistory(mergedTracked);
      const { changedNodeIds, changedEdgeIds } = diffCanvasStates(
        normalizedCurrent,
        normalizedNew,
        currentTrackedEdges,
        restoredTrackedEdges
      );

      changedNodeIds.forEach((id) => get().setDirty(id, true, 'node'));
      changedEdgeIds.forEach((id) => get().setDirty(id, true, 'edge'));

      set({
        nodes: newNodes,
        edges: newEdges,
        currentHistoryIndex: currentHistoryIndex + 1,
        hasUnsavedChanges: true,
      });
    }
  },

  canUndo: () => {
    const { currentHistoryIndex } = get();
    return currentHistoryIndex > 0;
  },

  canRedo: () => {
    const { history, currentHistoryIndex } = get();
    return currentHistoryIndex < history.length - 1;
  },
}));

// Export the store directly - tracking will be done through component-level WDYR
export const useCanvasStore = useCanvasStoreBase;

/**
 * Subscribe to canvas store with a custom equality function. Zustand v5's
 * `useStore(selector)` only takes one argument; for the equality variant
 * we route through `useStoreWithEqualityFn`. Wrapped here so callers
 * don't have to import two store modules.
 */
export function useCanvasStoreEq<T>(
  selector: (state: CanvasStore) => T,
  equalityFn: (a: T, b: T) => boolean,
): T {
  return useStoreWithEqualityFn(useCanvasStoreBase, selector, equalityFn);
}
