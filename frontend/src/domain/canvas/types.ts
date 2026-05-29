import { Note, Edge, Canvas } from '@piano/shared'
import type { Node as ReactFlowNode, Edge as ReactFlowEdge } from '@xyflow/react'

// Active canvas interaction tool. `select` is the normal React Flow mode
// (drag/pan/select). The others activate the DrawingLayer, which captures
// pointer gestures to create ZONE / DRAWING nodes.
export type CanvasTool = 'select' | 'zone' | 'pen' | 'line'

// ============================================
// CANVAS NODE TYPES
// ============================================

export namespace CanvasNode {
  /**
   * Common fields every variant carries. Mirrors Note.Model minus the
   * type-discriminating fields (type / machineId / daemonId / parentMachineNodeId)
   * so each variant below can declare those with the right specificity.
   */
  type BaseData = {
    id: string
    arrangementId: string
    userId: string
    status?: Note.Status | null
    isAncestor?: boolean
    content: string
    label?: string | null
    color?: string | null
    tags: string[]
    layers: string[]
    pinned: boolean
    isMergePoint: boolean
    ancestorOverride?: string[]
    scale: number
    x: number
    y: number
    width?: number | null
    height?: number | null
    style?: Note.Style
    assistantProvider?: string | null
    parentId?: string | null
    cacheConfig?: unknown
    version: number
    createdAt: Date
    updatedAt: Date
  }

  export type MachineData = BaseData & {
    type: 'MACHINE'
    machineId: string
    daemonId: string | null
    parentMachineNodeId: string | null
  }

  export type TerminalData = BaseData & {
    type: 'TERMINAL'
    machineId: string
    daemonId: string | null
    parentMachineNodeId: string
  }

  export type TextData = BaseData & {
    type: 'TEXT'
  }

  // A resizable rectangle to group/organize the canvas. Box = width/height,
  // optional color (border/fill tint) + label (title). No type-specific fields.
  export type ZoneData = BaseData & {
    type: 'ZONE'
  }

  // A freehand stroke or straight line. Geometry lives in BaseData.style as
  // Note.DrawingStyle (points in node-local coords); box = width/height bbox.
  export type DrawingData = BaseData & {
    type: 'DRAWING'
  }

  export type NoteData = BaseData & {
    type: 'USER' | 'ASSISTANT' | 'SYSTEM' | 'GROUP'
  }

  /**
   * Discriminated union over Note.Type. Narrow on `data.type` to access
   * variant-specific fields like machineId / parentMachineNodeId.
   */
  export type UI = MachineData | TerminalData | TextData | NoteData | ZoneData | DrawingData

  // Note: shared/src/types/note.ts → Note.Transform.toRfNode is the authoritative
  // DB-row-to-React-Flow-node transform. A duplicate `CanvasNode.fromNote` used
  // to live here with drifted behavior (missing style, parentId, scaled
  // dimensions) — it had zero callers and was deleted to prevent accidental use.

  /**
   * Type-narrowing predicates — use these in non-creator code paths so the
   * compiler can narrow `node.data` to the right variant.
   */
  export const isMachine = (data: UI): data is MachineData => data.type === 'MACHINE'
  export const isTerminal = (data: UI): data is TerminalData => data.type === 'TERMINAL'
  export const isText = (data: UI): data is TextData => data.type === 'TEXT'
  export const isZone = (data: UI): data is ZoneData => data.type === 'ZONE'
  export const isDrawing = (data: UI): data is DrawingData => data.type === 'DRAWING'

  /**
   * A shape (ZONE / DRAWING) the user can pin in place. Lock state lives in the
   * `style` JSON (persists via the existing patch — no schema change) rather
   * than `pinned`, which is taken by the NotesPanel "pin to top" feature.
   */
  export const isLocked = (data: UI): boolean => !!(data.style as { locked?: boolean } | null)?.locked
  export const isNote = (data: UI): data is NoteData =>
    data.type === 'USER' || data.type === 'ASSISTANT' || data.type === 'SYSTEM' || data.type === 'GROUP'

  /** True if the node is a machine or terminal (daemon-backed infra). */
  export const isInfra = (data: UI): data is MachineData | TerminalData =>
    isMachine(data) || isTerminal(data)

  /**
   * Resolve the daemon-side machineId for an infra node. Returns the variant's
   * machineId if set, otherwise falls back to the canvas node id (legacy data).
   */
  export const machineIdOf = (data: MachineData | TerminalData, nodeId: string): string =>
    data.machineId || nodeId

  /**
   * Create a new UI node for canvas (before it's saved to backend)
   */
  // React Flow needs explicit width/height for correct hit-testing on scaled nodes.
  const scaledDims = (scale: number) => ({
    width: Canvas.NODE_DIMENSIONS.WIDTH * scale,
    height: Canvas.NODE_DIMENSIONS.HEIGHT * scale,
  })

  export const createNew = (
    id: string,
    position: { x: number; y: number },
    content: string = '',
    arrangementId: string,
    label?: string,
    color?: string,
    scale?: number,
    layers?: string[],
  ): ReactFlowNode<NoteData> => {
    const nodeScale = scale ?? 1.0
    const scaledWidth = Canvas.NODE_DIMENSIONS.WIDTH * nodeScale
    const scaledHeight = Canvas.NODE_DIMENSIONS.HEIGHT * nodeScale

    return {
      id,
      type: 'note',
      position,
      width: scaledWidth,
      height: scaledHeight,
      data: {
        id,
        content,
        label,
        color,
        scale: nodeScale,
        tags: [],
        layers: layers ?? [],
        pinned: false,
        isMergePoint: false,
        status: null,
        type: 'USER',
        createdAt: new Date(),
        updatedAt: new Date(),
        arrangementId,
        userId: '',
        x: position.x,
        y: position.y,
        version: 1,
      },
    }
  }

  /**
   * Create a new TEXT node for canvas. TEXT nodes are standalone headings /
   * annotations that render without a card — see `components/TextNode.tsx`.
   * Font metadata lives in the structured `style` JSON column, not hacked into
   * `color` or `tags`.
   */
  export const createText = (
    id: string,
    position: { x: number; y: number },
    arrangementId: string,
    content: string = 'Heading',
    layers?: string[],
  ): ReactFlowNode<TextData> => ({
    id,
    type: 'text',
    position,
    data: {
      id,
      content,
      label: null,
      color: null,
      type: 'TEXT',
      tags: [],
      layers: layers ?? [],
      pinned: false,
      isMergePoint: false,
      ancestorOverride: [],
      scale: 1,
      x: position.x,
      y: position.y,
      style: { fontSize: 64, fontWeight: 700, fontFamily: 'sans' } as Note.TextStyle,
      status: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      arrangementId,
      userId: '',
      version: 1,
    },
  })

  /**
   * Create a ZONE node — a resizable rectangle for organizing the canvas.
   * `box` is the bounding box in flow coords; width/height go on the node
   * (NodeResizer mutates them) and mirror into data for persistence.
   */
  export const createZone = (
    id: string,
    box: { x: number; y: number; width: number; height: number },
    arrangementId: string,
    color?: string | null,
    label?: string | null,
    layers?: string[],
  ): ReactFlowNode<ZoneData> => ({
    id,
    type: 'zone',
    position: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    data: {
      id,
      content: '',
      label: label ?? null,
      color: color ?? null,
      type: 'ZONE',
      tags: [],
      layers: layers ?? [],
      pinned: false,
      isMergePoint: false,
      ancestorOverride: [],
      scale: 1,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      style: null,
      status: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      arrangementId,
      userId: '',
      version: 1,
    },
  })

  /**
   * Create a DRAWING node — a freehand stroke or straight line. `box` is the
   * stroke's bounding box in flow coords; `drawing.points` are node-local
   * (relative to box top-left) so the path is position-independent.
   */
  export const createDrawing = (
    id: string,
    box: { x: number; y: number; width: number; height: number },
    arrangementId: string,
    drawing: Note.DrawingStyle,
    color?: string | null,
    layers?: string[],
  ): ReactFlowNode<DrawingData> => ({
    id,
    type: 'drawing',
    position: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    data: {
      id,
      content: '',
      label: null,
      color: color ?? null,
      type: 'DRAWING',
      tags: [],
      layers: layers ?? [],
      pinned: false,
      isMergePoint: false,
      ancestorOverride: [],
      scale: 1,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      style: drawing,
      status: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      arrangementId,
      userId: '',
      version: 1,
    },
  })

  /**
   * Check if a node is currently running
   */
  export const isRunning = (node: UI): boolean =>
    (node.status as string) === 'RUNNING' || (node.status as string) === 'running'

  /**
   * Check if a node has content
   */
  export const hasContent = (node: UI): boolean =>
    !!node.content?.trim()

  /**
   * Check if a node can be run as an AI action source. Needs content AND
   * must be allowed by the domain rules (TEXT annotations and infra nodes
   * are excluded — same decision table as the backend at Note.capabilities).
   */
  export const canRun = (node: UI): boolean =>
    hasContent(node) && Note.capabilities(node).canRunAction

  /**
   * Update node status
   */
  export const updateStatus = (node: UI, status: Note.Status): UI => ({
    ...node,
    status,
  })

  /**
   * Update node content
   */
  export const updateContent = (node: UI, content: string): UI => ({
    ...node,
    content,
    updatedAt: new Date(),
  })

  /**
   * Update node label
   */
  export const updateLabel = (node: UI, label: string | null): UI => ({
    ...node,
    label,
    updatedAt: new Date(),
  })

  /**
   * Update node color
   */
  export const updateColor = (node: UI, color: string | null): UI => ({
    ...node,
    color,
    updatedAt: new Date(),
  })

  /**
   * Create a new MACHINE node for canvas (before it's saved to backend)
   */
  export const createMachine = (
    id: string,
    position: { x: number; y: number },
    machineId: string,
    arrangementId: string,
    label?: string,
    parentMachineNodeId?: string,
    scale?: number,
    layers?: string[],
  ): ReactFlowNode<MachineData> => {
    const nodeScale = scale ?? 1.0
    return {
      id,
      type: 'machine',
      position,
      ...scaledDims(nodeScale),
      data: {
        id,
        content: '',
        label: label || 'Machine',
        machineId,
        daemonId: null,
        parentMachineNodeId: parentMachineNodeId || null,
        scale: nodeScale,
        tags: [],
        layers: layers ?? [],
        pinned: false,
        isMergePoint: false,
        status: null,
        type: 'MACHINE',
        createdAt: new Date(),
        updatedAt: new Date(),
        arrangementId,
        userId: '',
        x: position.x,
        y: position.y,
        version: 1,
      },
    }
  }

  /**
   * Create a TERMINAL node — a lightweight shell session attached to a machine.
   * Terminal nodes have no freeze/branch capabilities, only close.
   */
  export const createTerminal = (
    id: string,
    position: { x: number; y: number },
    machineId: string,
    machineNodeId: string,
    arrangementId: string,
    label?: string,
    scale?: number,
    layers?: string[],
  ): ReactFlowNode<TerminalData> => {
    const nodeScale = scale ?? 1.0
    return {
      id,
      type: 'terminal',
      position,
      ...scaledDims(nodeScale),
      data: {
        id,
        content: '',
        label: label || 'Terminal',
        machineId,
        daemonId: null,
        parentMachineNodeId: machineNodeId,
        scale: nodeScale,
        tags: [],
        layers: layers ?? [],
        pinned: false,
        isMergePoint: false,
        status: null,
        type: 'TERMINAL',
        createdAt: new Date(),
        updatedAt: new Date(),
        arrangementId,
        userId: '',
        x: position.x,
        y: position.y,
        version: 1,
      },
    }
  }
}

// ============================================
// MACHINE LABEL — branch naming algorithm
// ============================================

export namespace MachineLabel {
  const escapeRegex = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /**
   * Strip legacy "(branch)" suffixes a label may have accumulated. Older
   * versions appended this on every branch — collapse them so we work with
   * the bare family name.
   */
  const stripBranchSuffix = (label: string): string =>
    label.replace(/(\s*\(branch\))+$/i, '').trim()

  /**
   * Split a label like "Machine 4" into family ("Machine") and number (4).
   * A label without a trailing number gets `n = 1`.
   */
  const splitFamily = (label: string): { family: string; n: number } => {
    const stripped = stripBranchSuffix(label)
    const match = stripped.match(/^(.*?)\s+(\d+)$/)
    if (match) return { family: match[1].trim() || 'Machine', n: parseInt(match[2], 10) }
    return { family: stripped || 'Machine', n: 1 }
  }

  /**
   * Compute the next branch label from a parent label and the existing
   * machine labels in the arrangement. Picks `family (max + 1)` so branching
   * "Machine 4" while "Machine 5" exists yields "Machine 6".
   */
  export const nextBranchName = (parentLabel: string, allMachineLabels: string[]): string => {
    const { family } = splitFamily(parentLabel)
    const familyRe = new RegExp(`^${escapeRegex(family)}(?:\\s+(\\d+))?$`)
    let maxN = 1
    for (const raw of allMachineLabels) {
      const lbl = stripBranchSuffix(raw)
      const m = lbl.match(familyRe)
      if (m) {
        const v = m[1] ? parseInt(m[1], 10) : 1
        if (v > maxN) maxN = v
      }
    }
    return `${family} ${maxN + 1}`
  }

  /**
   * Like nextBranchName, but for spawning from a template (or any "fresh"
   * source). Difference: if no machine in the family exists yet, return the
   * bare base name. nextBranchName always returns `base N+1` because for
   * branching the parent is already on the canvas; here the source (a
   * template) isn't a canvas node, so the first spawn deserves the clean name.
   *
   *   nextLabelInFamily('foo', [])               → 'foo'
   *   nextLabelInFamily('foo', ['foo'])          → 'foo 2'
   *   nextLabelInFamily('foo', ['foo', 'foo 2']) → 'foo 3'
   */
  export const nextLabelInFamily = (family: string, allMachineLabels: string[]): string => {
    const familyRe = new RegExp(`^${escapeRegex(family)}(?:\\s+(\\d+))?$`)
    let exists = false
    let maxN = 0
    for (const raw of allMachineLabels) {
      const lbl = stripBranchSuffix(raw)
      const m = lbl.match(familyRe)
      if (m) {
        exists = true
        const v = m[1] ? parseInt(m[1], 10) : 1
        if (v > maxN) maxN = v
      }
    }
    return exists ? `${family} ${maxN + 1}` : family
  }
}

// ============================================
// CANVAS EDGE TYPES
// ============================================

export namespace CanvasEdge {
  /**
   * UI edge type (currently same as shared Edge.Model)
   */
  export type UI = Edge.Model

  /**
   * Transform from shared Edge.Model to React Flow edge
   */
  export const fromEdge = (edge: Edge.Model): ReactFlowEdge =>
    Edge.Transform.toRfEdge(edge)

  /**
   * Create a new edge for canvas
   */
  export const createNew = (
    id: string,
    source: string,
    target: string,
    _arrangementId: string
  ): ReactFlowEdge => ({
    id,
    source,
    target,
    type: 'smoothstep'
  })
}

// ============================================
// CANVAS STATE TYPES
// ============================================

export namespace CanvasState {
  /**
   * The complete canvas state including nodes and edges
   */
  export interface State {
    nodes: ReactFlowNode<CanvasNode.UI>[]
    edges: ReactFlowEdge[]
    selectedNodeId: string | null
    hasUnsavedChanges: boolean
  }

  /**
   * Find all ancestor nodes of a given node
   * Optimized: Build lookup map once instead of iterating edges on each recursive call
   */
  export const findAncestors = (
    nodeId: string,
    edges: ReactFlowEdge[]
  ): Set<string> => {
    // Build target->source lookup map once (O(n))
    const edgeByTarget = new Map<string, string>()
    for (const edge of edges) {
      edgeByTarget.set(edge.target, edge.source)
    }

    const ancestors = new Set<string>()
    let currentId: string | null = nodeId

    // Traverse up the tree (O(depth))
    while (currentId) {
      const parentId = edgeByTarget.get(currentId)
      if (parentId && !ancestors.has(parentId)) {
        ancestors.add(parentId)
        currentId = parentId
      } else {
        currentId = null
      }
    }

    return ancestors
  }

  /**
   * Find all edges that are part of the path from selected node to root
   * Optimized: Build lookup map once instead of repeated find() calls
   */
  export const findAncestorEdges = (
    nodeId: string,
    edges: ReactFlowEdge[]
  ): Set<string> => {
    // Build target->edge lookup map once (O(n))
    const edgeByTarget = new Map<string, ReactFlowEdge>()
    for (const edge of edges) {
      edgeByTarget.set(edge.target, edge)
    }

    const ancestorEdges = new Set<string>()
    let currentId: string | null = nodeId

    // Traverse up the tree from node to root, collecting edges (O(depth))
    while (currentId) {
      const parentEdge = edgeByTarget.get(currentId)
      if (parentEdge) {
        ancestorEdges.add(parentEdge.id)
        currentId = parentEdge.source
      } else {
        currentId = null
      }
    }

    return ancestorEdges
  }

  /**
   * Update node highlighting based on selection
   */
  export const updateHighlighting = (
    nodes: ReactFlowNode<CanvasNode.UI>[],
    selectedNodeId: string | null,
    edges: ReactFlowEdge[]
  ): ReactFlowNode<CanvasNode.UI>[] => {
    if (!selectedNodeId) {
      return nodes.map(node => ({
        ...node,
        data: { ...node.data, isAncestor: false }
      }))
    }

    const ancestors = findAncestors(selectedNodeId, edges)

    return nodes.map(node => ({
      ...node,
      data: {
        ...node.data,
        isAncestor: ancestors.has(node.id)
      }
    }))
  }

  /**
   * Update edge highlighting based on selection
   */
  export const updateEdgeHighlighting = (
    edges: ReactFlowEdge[],
    selectedNodeId: string | null
  ): ReactFlowEdge[] => {
    if (!selectedNodeId) {
      return edges.map(edge => {
        const currentStrokeWidth = edge.style?.strokeWidth || 2
        if (currentStrokeWidth === 2) {
          return edge // No change needed
        }
        return {
          ...edge,
          style: { ...edge.style, strokeWidth: 2 }
        }
      })
    }

    const ancestorEdges = findAncestorEdges(selectedNodeId, edges)

    return edges.map(edge => {
      const shouldBeBold = ancestorEdges.has(edge.id)
      const targetStrokeWidth = shouldBeBold ? 4 : 2
      const currentStrokeWidth = edge.style?.strokeWidth || 2

      if (currentStrokeWidth === targetStrokeWidth) {
        return edge // No change needed
      }

      return {
        ...edge,
        style: {
          ...edge.style,
          strokeWidth: targetStrokeWidth
        }
      }
    })
  }
}

// ============================================
// BULK OPERATIONS
// ============================================

export namespace BulkOperations {
  /**
   * Get all unique tags from a list of nodes
   */
  export const getAllTags = (nodes: ReactFlowNode<CanvasNode.UI>[]): string[] => {
    const tagSet = new Set<string>()
    nodes.forEach(node => {
      node.data.tags?.forEach(tag => tagSet.add(tag))
    })
    return Array.from(tagSet).sort()
  }

  /**
   * Filter nodes by tags (nodes that have ALL specified tags)
   */
  export const filterNodesByTags = (
    nodes: ReactFlowNode<CanvasNode.UI>[],
    tags: string[]
  ): ReactFlowNode<CanvasNode.UI>[] => {
    if (tags.length === 0) return []
    return nodes.filter(node =>
      tags.every(tag => node.data.tags?.includes(tag))
    )
  }

  /**
   * Filter nodes by ANY of the specified tags
   */
  export const filterNodesByAnyTag = (
    nodes: ReactFlowNode<CanvasNode.UI>[],
    tags: string[]
  ): ReactFlowNode<CanvasNode.UI>[] => {
    if (tags.length === 0) return []
    return nodes.filter(node =>
      tags.some(tag => node.data.tags?.includes(tag))
    )
  }

  /**
   * Get nodes that are not already parents of a given node
   */
  export const getNodesNotParents = (
    targetNodeId: string,
    candidateNodes: ReactFlowNode<CanvasNode.UI>[],
    edges: ReactFlowEdge[]
  ): ReactFlowNode<CanvasNode.UI>[] => {
    const parentIds = new Set(
      edges.filter(e => e.target === targetNodeId).map(e => e.source)
    )
    return candidateNodes.filter(node => !parentIds.has(node.id))
  }
}
