'use client'

import React, { memo, useState, useCallback, useMemo, useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { type NodeProps } from '@xyflow/react'
import {
  MoreVertical,
  Copy,
  Trash2,
  Check,
  Plus,
  ClipboardPaste,
  Pencil,
  Palette,
  Pin,
  Tag,
  X as XIcon,
  GitMerge,
  Combine,
  Network,
  GitBranch,
  ArrowDownToLine,
  ArrowUpToLine,
  FolderClosed,
  FolderOpen,
} from 'lucide-react'
import { cn, copyToClipboard } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCanvasStore } from '../store'
import { Z } from '../lib/z-layers'
import { NodeActionsMenu, NodeActionsQuickBar, useNodeActionCtx } from '../lib/node-actions'
import { NodeExternalLabel } from './NodeExternalLabel'
import { NodeHandles } from './NodeHandles'
import { registerLodNode } from '../lib/lod'

// Reads the `[data-low-detail]` attribute that ZoomTracker toggles on this
// element. Subscribe is GATED on `active` — when false, observer is never
// attached and React never re-renders this component on attribute flip.
// getSnapshot still returns the current attribute value, so any re-render
// triggered by other state lands on the up-to-date bucket.
//
// Why this matters: NoteCard reads isLowDetail only for the hover-preview
// portal. A user hovers at most one node at a time; the other 499 don't
// care about bucket flips. Without gating, a single scroll-zoom past the
// LOD threshold re-renders 500 cards simultaneously — exactly the long
// task Chrome's profiler keeps surfacing.
function useDataLowDetail(ref: React.RefObject<HTMLElement | null>, active: boolean): boolean {
  return useSyncExternalStore(
    cb => {
      if (!active) return () => {}
      const el = ref.current
      if (!el) return () => {}
      const observer = new MutationObserver(cb)
      observer.observe(el, { attributes: true, attributeFilter: ['data-low-detail'] })
      return () => observer.disconnect()
    },
    () => ref.current?.hasAttribute('data-low-detail') ?? false,
    () => false // SSR snapshot — never low-detail on the server
  )
}
import { TagsEditor } from '@/components/TagsEditor'
import { CanvasNode } from '../types'
import { PlayDropdownButton } from './PlayDropdownButton'
import { useActionsContext } from '@/domain/action/ActionsContext'
import { useUnifiersStore } from '@/domain/unifier/store'
import { ArrangementService } from '@/domain/arrangement/services'
import { Union } from '@/lib/types'
import { Canvas, Edge, Unifier } from '@piano/shared'
import { Analytics } from '@/lib/analytics'

// React Flow's NodeProps is generic but expects data to be Record<string, unknown>
// We'll cast it internally to our specific type
type NoteCardProps = NodeProps
const EMPTY_UNIFIERS: Unifier.Model[] = []

// Color palettes for note customization
// Palette: strictly no purple (DESIGN.md intro literally lists
// "фиолетовый градиент" as the first symptom of visual garbage).
// Four calm paper-tone options, all driven by an honest 1px border.
const USER_COLORS = [
  { name: 'Light Blue', bg: 'bg-blue-50', border: 'border-blue-200' },
  { name: 'Light Green', bg: 'bg-green-50', border: 'border-green-200' },
  { name: 'Light Pink', bg: 'bg-pink-50', border: 'border-pink-200' },
  { name: 'Light Yellow', bg: 'bg-yellow-50', border: 'border-yellow-200' },
]

// Assistant answers are light "AI paper" by default, so custom colours stay
// in the same readable family instead of reintroducing dark blocks.
const ASSISTANT_COLORS = [
  { name: 'AI Citrine', bg: 'bg-amber-50', border: 'border-amber-300' },
  { name: 'AI Mint', bg: 'bg-emerald-50', border: 'border-emerald-300' },
  { name: 'AI Sky', bg: 'bg-sky-50', border: 'border-sky-300' },
  { name: 'AI Rose', bg: 'bg-rose-50', border: 'border-rose-300' },
]

// Label rendering is delegated to <NodeExternalLabel />; the font-size and
// gap constants live there so every node type (note, machine, terminal)
// uses identical spacing.

function NoteCardRunButton(props: Omit<React.ComponentProps<typeof PlayDropdownButton>, 'actions'>) {
  const { actions } = useActionsContext()
  return <PlayDropdownButton {...props} actions={actions} />
}

const NoteCardComponent = ({ data, selected, dragging }: NoteCardProps) => {
  // Cast the generic data to our specific CanvasNode.UI type
  const noteData = data as CanvasNode.UI
  const content = noteData.content || ''
  const [copySuccess, setCopySuccess] = useState(false)
  const [pasteSuccess, setPasteSuccess] = useState(false)
  // Label rename (inline double-click) is now handled by <NodeExternalLabel />.
  // The 3-dot menu's "Edit label" item still goes through <NodeDialogsHost>.
  const [isHovered, setIsHovered] = useState(false)
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Check if this is an assistant node for inverted styling
  const isAssistantNode = noteData.type === 'ASSISTANT'

  // LOD bucket — read from the DOM attribute ZoomTracker toggles. Subscription
  // only attaches while hovered: the hover-preview portal is the only
  // consumer of this value, and nobody hovers 500 nodes at once. When zoom
  // crosses an LOD threshold, hover-gated subscribe keeps non-hovered cards
  // out of React's render path.
  const isLowDetail = useDataLowDetail(rootRef, isHovered)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    return registerLodNode(el, noteData.scale || 1)
  }, [noteData.scale])

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    if (!isHovered || !isLowDetail) return

    // In low-detail mode the card is tiny — native mouseleave on its outer
    // div fires too eagerly when the user is heading toward the hover
    // preview portal (which is on document.body, outside the node). The
    // pointermove fallback keeps the preview alive while the cursor stays
    // within a 12px halo of the node rect.
    const onPointerMove = (event: PointerEvent) => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const pad = 12
      const inside =
        event.clientX >= rect.left - pad &&
        event.clientX <= rect.right + pad &&
        event.clientY >= rect.top - pad &&
        event.clientY <= rect.bottom + pad
      if (!inside) {
        if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
        setIsHovered(false)
      }
    }

    document.addEventListener('pointermove', onPointerMove)
    return () => document.removeEventListener('pointermove', onPointerMove)
  }, [isHovered, isLowDetail])

  // The old creation-flash (emerald box-shadow glow) has been removed —
  // DESIGN.md intro literally calls out "мягкое свечение" as the disease.
  // The node appearing in the canvas is itself the creation signal.

  // Color picker / tags editor / ancestor dialog popovers now live in
  // the global <NodeDialogsHost>, not per-card. Nothing to wire here.

  // PERFORMANCE: Only subscribe to values that actually change and require re-render
  // For stable functions, use useCanvasStore.getState() in handlers instead
  const isRunning = useCanvasStore(state => state.runningNodes.has(noteData.id))
  const shouldTrackMergeControls = isHovered && noteData.isMergePoint

  // The merge-point controls are hidden until hover. Keep the O(edges)
  // count out of every store update for non-hovered cards.
  const parentCount = useCanvasStore(state =>
    shouldTrackMergeControls ? state.edges.reduce((count, e) => count + (e.target === noteData.id ? 1 : 0), 0) : 0
  )

  // Unifier store access
  const unifiers = useUnifiersStore(state => (noteData.isMergePoint ? state.unifiers : EMPTY_UNIFIERS))
  const fetchUnifiers = useUnifiersStore(state => state.fetchUnifiers)

  // Fetch unifiers on mount if merge point
  useEffect(() => {
    if (noteData.isMergePoint && unifiers.length === 0) {
      fetchUnifiers()
    }
  }, [noteData.isMergePoint, unifiers.length, fetchUnifiers])

  // PERFORMANCE: All handlers use getState() instead of subscriptions
  // This prevents re-renders when store functions change (they don't, but React checks)

  const handleDelete = useCallback(() => {
    useCanvasStore.getState().deleteNode(noteData.id)
  }, [noteData.id])

  const handleDuplicate = useCallback(() => {
    useCanvasStore.getState().duplicateNode(noteData.id)
  }, [noteData.id])

  const handleRun = useCallback(
    (actionId?: string) => {
      useCanvasStore.getState().runNode(noteData.id, actionId)
    },
    [noteData.id]
  )

  const handleCopy = useCallback(async () => {
    await copyToClipboard(content || '')
    useCanvasStore.getState().setCopiedContent(content)
    setCopySuccess(true)
    setTimeout(() => setCopySuccess(false), 2000)
  }, [content])

  const handleCopyBranch = useCallback(async () => {
    await useCanvasStore.getState().copyBranchText(noteData.id)
  }, [noteData.id])

  const handleSelectChildren = useCallback(() => {
    useCanvasStore.getState().selectDescendants(noteData.id, true)
  }, [noteData.id])

  const handleSelectAncestors = useCallback(() => {
    useCanvasStore.getState().selectAncestors(noteData.id, true)
  }, [noteData.id])

  const handlePaste = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const { copiedContent, updateNodeContent } = useCanvasStore.getState()
      if (copiedContent) {
        updateNodeContent(noteData.id, noteData.arrangementId, copiedContent)
        setPasteSuccess(true)
        setTimeout(() => setPasteSuccess(false), 2000)
      }
    },
    [noteData.id, noteData.arrangementId]
  )

  const handleAddNodeBelow = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      useCanvasStore.getState().addChildBelow(noteData.id)
    },
    [noteData.id]
  )

  // Label rename handlers moved to <NodeExternalLabel /> which owns both
  // the inline input and the save/cancel keystrokes.

  // Color, tags, and ancestor pickers are opened through the unified
  // node-actions registry + global <NodeDialogsHost>. No local handlers
  // needed here anymore.

  // Unifier execution for merge points
  const handleRunUnifier = useCallback(
    async (unifierId: string) => {
      const { arrangementId, edges, selectedModel, addNodes } = useCanvasStore.getState()
      if (!arrangementId || !noteData.isMergePoint) return

      // Get incoming edges for this node
      const incomingEdges = edges.filter(e => e.target === noteData.id)
      const edgeModels = incomingEdges.map(e => ({
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
      }))

      const parentNodeIds = Edge.findParents(noteData.id, edgeModels)

      if (parentNodeIds.length === 0) {
        console.warn('Merge point has no parents')
        return
      }

      try {
        const result = await ArrangementService.executeUnifier(arrangementId, unifierId, {
          noteIds: parentNodeIds,
          model: selectedModel,
        })

        Union.match(
          {
            success: data => {
              Analytics.track('unifier_run_started', {
                arrangementId,
                unifierId,
                selectedNoteCount: parentNodeIds.length,
                model: selectedModel,
                hasUserPrompt: false,
              })
              if (data.responseNode) {
                addNodes([data.responseNode])
              }
            },
            error: err => {
              console.error('Error executing unifier on merge point:', err.message)
            },
          },
          result
        )
      } catch (error) {
        console.error('Error executing unifier:', error)
      }
    },
    [noteData.id, noteData.isMergePoint]
  )

  // Tag editing flows through the shared TagsEditor component — see showTagsInput
  // popover below. No per-node handlers needed here.

  // Check node states using domain functions
  const nodeIsRunning = CanvasNode.isRunning(noteData) || isRunning
  const isSaving = noteData.status === 'saving'
  const hasContent = CanvasNode.hasContent(noteData)
  const canRun = CanvasNode.canRun(noteData)

  // Parse stored color configuration
  const colorConfig = useMemo(() => {
    if (!noteData.color) return null
    const [bg, border] = noteData.color.split('|')
    return { bg, border }
  }, [noteData.color])

  // Determine available color palette based on note type
  const availableColors = isAssistantNode ? ASSISTANT_COLORS : USER_COLORS

  // Label font size now handled by CSS using --canvas-zoom variable
  // No more zoom dependency, no more recalculations!

  // Three distinct materials:
  //   - USER      = white paper
  //   - ASSISTANT = warm AI paper, not a black surface
  //   - Color config (user-chosen palette) wins over both.
  const getBackgroundClass = () => {
    if (colorConfig) return colorConfig.bg
    if (isAssistantNode) return 'bg-[#fff7d6]'
    return 'bg-white'
  }

  const getBorderClass = () => {
    // Symmetric 1px frame everywhere (asymmetric side-strips were
    // bolt-on decals, not architectural). Assistant identity is
    // carried by the paper tint + border, not by a black fill.
    // Selected state thickens the border to 3px
    // emerald — the single accent colour of the whole app.
    if (selected) return 'border-[3px] border-emerald-500'
    if (isAssistantNode) return 'border border-amber-300'
    if (colorConfig) return `${colorConfig.border} border`
    return 'border border-gray-900'
  }

  // ==================== Unified node actions (registry-driven) ====================
  // Same NODE_ACTIONS drive both the inline toolbar AND the ⋮ dropdown,
  // and — by construction — the menu in NodeEditPanel/MachineEditPanel.
  // Surface callbacks here are feedback-only (copy flash); label/color/
  // tags/ancestors are handled by the global <NodeDialogsHost>.
  const nodeActionCtx = useNodeActionCtx(
    isHovered ? noteData : null,
    {
      onCopiedContent: () => {
        setCopySuccess(true)
        setTimeout(() => setCopySuccess(false), 2000)
      },
    },
    { copiedContent: copySuccess }
  )

  // Actions are registry-driven. NodeActionsQuickBar renders pinned ones
  // as icon buttons; NodeActionsMenu renders the full 3-dot dropdown with
  // a pin sidecar per item. Both read the global usePinnedToolsStore, so
  // pinning on a card also toggles it in the edit panel and vice versa.

  const nodeScale = noteData.scale || 1
  const previewText = content.length > 400 ? content.slice(0, 400) + '…' : content

  return (
    <div
      ref={rootRef}
      className="group relative"
      data-piano-node
      data-node-scale={nodeScale}
      onMouseEnter={() => {
        if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
        setIsHovered(true)
      }}
      onMouseLeave={() => {
        hoverTimeoutRef.current = setTimeout(() => setIsHovered(false), 150)
      }}
    >
      {/* Label — shared component. Double-click to rename. */}
      <NodeExternalLabel nodeId={noteData.id} label={noteData.label} scale={nodeScale} />

      {/* Main card — DESIGN.md §3.3 HTML Brutalism + §Checklist:
          - rounded (4px): honest geometry, not 8px bubble
          - border width owned by getBorderClass() (1px default, 3px selected)
          - no ring/ring-offset/box-shadow: soft glows are chartjunk
          - NO overflow-hidden on OUTER: React Flow Handles translate
            half outside the box, and the bottom add-button sits 60px
            below the edge — both would be clipped. Grain overlay is
            bounded by its own `absolute inset-0`, so removing
            overflow-hidden doesn't leak the texture anywhere visible.
          OUTER / INNER split — see NodeShell.tsx for the rationale.
          OUTER carries the scaled layout box (so ReactFlow / ResizeObserver
          measure the same size the store wrote into node.width). INNER
          is rendered at base dimensions and transform-scaled, which avoids
          the sub-pixel rounding `zoom: scale` introduces at small scales. */}
      <div
        className="relative"
        style={{
          width: `${Canvas.NODE_DIMENSIONS.WIDTH * nodeScale}px`,
          height: `${Canvas.NODE_DIMENSIONS.HEIGHT * nodeScale}px`,
        }}
      >
        <div
          className={cn(
            'absolute top-0 left-0 flex cursor-pointer flex-col rounded border-solid',
            getBackgroundClass(),
            getBorderClass(),
            nodeIsRunning && !selected && 'border-blue-400',
            isSaving && !selected && 'border-yellow-400',
            // Merge-point = dashed stroke only; the dashing itself is the
            // signal, colour is inherited from the base border. No purple.
            noteData.isMergePoint && !selected && !nodeIsRunning && !isSaving && 'border-dashed'
          )}
          style={{
            width: `${Canvas.NODE_DIMENSIONS.WIDTH}px`,
            height: `${Canvas.NODE_DIMENSIONS.HEIGHT}px`,
            transform: `scale(${nodeScale})`,
            transformOrigin: 'top left',
          }}
        >
          {/* Full-detail subtree. `display: contents` lets the inner flex
            layout (header/content/footer rows) keep working without an
            extra layer; CSS in globals.css collapses the whole subtree
            with `display: none` when [data-low-detail] is set on the
            ancestor [data-piano-node]. NodeHandles stay outside this
            wrapper because edges still need to attach to a low-detail
            node. */}
          <div className="piano-node-full contents">
            {/* Header - fixed height, buttons only rendered on hover */}
            <div
              className={cn(
                'relative flex h-10 flex-shrink-0 items-center justify-between border-b px-3 py-2',
                isAssistantNode ? 'border-amber-200' : 'border-gray-100'
              )}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <div
                  className={cn(
                    'h-2 w-2 flex-shrink-0 rounded-full',
                    nodeIsRunning
                      ? 'bg-blue-500'
                      : isSaving
                        ? 'bg-yellow-500'
                        : noteData.status === 'error'
                          ? 'bg-red-500'
                          : noteData.status === 'completed'
                            ? 'bg-green-500'
                            : 'bg-gray-400'
                  )}
                />
                {/* Status micro-badge — same mono/tracked treatment used by
                MachineNode and TerminalNode so the four node kinds read
                as one typographic family despite their different colours. */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          'cursor-default truncate font-mono text-[10px] tracking-[0.12em] uppercase',
                          isAssistantNode ? 'text-stone-500' : 'text-gray-500'
                        )}
                      >
                        {isSaving ? 'saving' : noteData.status || (isAssistantNode && noteData.assistantProvider) || 'idle'}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{isSaving ? 'Saving...' : noteData.status || (isAssistantNode && noteData.assistantProvider) || 'Idle'}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>

              {isHovered && (
                // Two siblings on ONE flex row: QuickBar (wraps internally) on the
                // left, the 3-dot Menu pinned at top-right. NO `flex-wrap` here —
                // wrapping happens inside QuickBar itself, never between QuickBar
                // and Menu, so Menu can't get pushed onto a second row. `self-start`
                // anchors the whole block to the top of the header (parent is
                // items-center). 60% = 60% of the card header width.
                <div className="flex max-w-[60%] min-w-0 items-start justify-end gap-1 self-start">
                  <NodeActionsQuickBar ctx={nodeActionCtx} />
                  <NodeActionsMenu
                    ctx={nodeActionCtx}
                    pinnable={true}
                    trigger={
                      <Button
                        variant="ghost"
                        size="sm"
                        // flex-shrink-0 so when QuickBar fills the row Menu can't
                        // be squeezed sub-pixel and pushed off-axis — it always
                        // keeps its 24x24 anchor at top-right.
                        className={cn('h-6 w-6 flex-shrink-0 p-0', isAssistantNode && 'text-stone-700 hover:bg-amber-100')}
                        onClick={e => e.stopPropagation()}
                      >
                        <MoreVertical className={cn('h-4 w-4', isAssistantNode && 'text-stone-600')} />
                      </Button>
                    }
                  />
                </div>
              )}

              {/* Color picker / tags editor / ancestor info popovers are no
              longer rendered here — they're opened globally via
              <NodeDialogsHost> so the edit panel shows the same UI.  */}
            </div>

            {/* Content - Preview only, no scrolling, aligned to top */}
            <div className="flex flex-1 items-start justify-center overflow-hidden p-3">
              {nodeIsRunning ? (
                // Show loading spinner for running nodes
                <Spinner size="md" className={isAssistantNode ? 'text-stone-800' : 'text-gray-900'} />
              ) : content ? (
                <div
                  className={cn('w-full text-sm leading-relaxed whitespace-pre-wrap', isAssistantNode ? 'text-stone-900' : 'text-gray-900')}
                >
                  {content.length > 150 ? content.slice(0, 150) + '...' : content}
                </div>
              ) : (
                <span className={cn('text-sm italic', isAssistantNode ? 'text-stone-500' : 'text-gray-400')}>
                  {noteData.status === 'error' ? 'Failed to generate content' : 'Click to add content...'}
                </span>
              )}
            </div>

            {/* Footer - fixed height, content only rendered on hover */}
            <div
              className={cn(
                'flex h-12 flex-shrink-0 items-center justify-between border-t px-3 py-2',
                isAssistantNode ? 'border-amber-200' : 'border-gray-100'
              )}
            >
              {isHovered && (
                <>
                  <div className="flex items-center gap-2">
                    <NoteCardRunButton onPlay={handleRun} disabled={!canRun} variant={isAssistantNode ? 'outline' : 'default'} size="sm" />

                    {/* Unifier button for merge points */}
                    {noteData.isMergePoint && parentCount > 0 && unifiers.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant={isAssistantNode ? 'outline' : 'default'}
                            size="sm"
                            className="gap-1.5"
                            title={`Synthesize ${parentCount} parent${parentCount !== 1 ? 's' : ''}`}
                          >
                            <Combine className="h-3 w-3" />
                            <span className="text-xs">{parentCount}</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          {unifiers.map(unifier => (
                            <DropdownMenuItem key={unifier.id} onClick={() => handleRunUnifier(unifier.id)} className="cursor-pointer">
                              <Combine className="mr-2 h-3.5 w-3.5" />
                              {unifier.name}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>

                  <span className={cn('ml-2 flex-shrink-0 text-xs', isAssistantNode ? 'text-stone-500' : 'text-gray-400')}>
                    {new Date(noteData.updatedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </>
              )}
            </div>

            {/* Add node button — INSIDE the transformed inner so it scales
            with the card (it's part of the visual affordance, not a
            connection control). */}
            {isHovered && (
              <button
                className={cn(
                  'absolute -bottom-[60px] left-1/2 -translate-x-1/2',
                  'h-10 w-10 rounded-full',
                  'flex items-center justify-center',
                  'z-10',
                  isAssistantNode
                    ? 'border border-amber-300 bg-amber-100 hover:bg-amber-200'
                    : 'border border-gray-300 bg-gray-100 hover:bg-emerald-50'
                )}
                onClick={handleAddNodeBelow}
                onMouseEnter={() => {
                  if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
                }}
                onMouseLeave={() => {
                  hoverTimeoutRef.current = setTimeout(() => setIsHovered(false), 150)
                }}
                title="Add node below"
              >
                <Plus
                  className={cn(
                    'h-6 w-6',
                    isAssistantNode ? 'text-stone-600 hover:text-stone-900' : 'text-gray-500 hover:text-emerald-600'
                  )}
                />
              </button>
            )}
          </div>
          {/* End of .piano-node-full. NodeHandles live OUTSIDE so edges can
            still attach to a low-detail node. */}

          {/* Handles inside the transformed INNER so they scale visually with
            the card. */}
          <NodeHandles />
        </div>
      </div>

      {/* Hover preview portal — only meaningful in low-detail mode (full
          card already shows content). Renders into document.body so it
          escapes React Flow's stacking contexts. */}
      {isLowDetail &&
        isHovered &&
        (previewText || noteData.label) &&
        createPortal(
          <HoverPreview nodeRef={rootRef} isAssistant={isAssistantNode} label={noteData.label} text={previewText} />,
          document.body
        )}
    </div>
  )
}

function stringArraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// Custom comparison function for memo to prevent unnecessary re-renders
const arePropsEqual = (prevProps: NoteCardProps, nextProps: NoteCardProps) => {
  if (prevProps.selected === nextProps.selected && prevProps.dragging === nextProps.dragging && prevProps.data === nextProps.data) {
    return true
  }

  // Cast data to our specific type
  const prevData = prevProps.data as CanvasNode.UI
  const nextData = nextProps.data as CanvasNode.UI

  // Only re-render if these specific things change:
  return (
    prevProps.selected === nextProps.selected &&
    prevProps.dragging === nextProps.dragging &&
    prevData.id === nextData.id &&
    prevData.content === nextData.content &&
    prevData.label === nextData.label &&
    prevData.color === nextData.color &&
    prevData.scale === nextData.scale &&
    prevData.pinned === nextData.pinned &&
    prevData.isMergePoint === nextData.isMergePoint &&
    stringArraysEqual(prevData.tags, nextData.tags) &&
    prevData.status === nextData.status &&
    prevData.updatedAt === nextData.updatedAt &&
    prevData.type === nextData.type &&
    prevData.assistantProvider === nextData.assistantProvider
    // Note: We intentionally don't check position changes here
    // Position is handled by React Flow internally
  )
}

/** Portaled hover preview — renders into document.body to escape React Flow's stacking contexts. */
function HoverPreview({
  nodeRef,
  isAssistant,
  label,
  text,
}: {
  nodeRef: React.RefObject<HTMLDivElement | null>
  isAssistant: boolean
  label: string | null | undefined
  text: string | null | undefined
}) {
  const rect = nodeRef.current?.getBoundingClientRect()
  if (!rect) return null
  return (
    <div
      className={cn(
        'pointer-events-none fixed rounded-lg border px-3 py-2 shadow-lg',
        isAssistant ? 'border-amber-300 bg-[#fff7d6] text-stone-900' : 'border-gray-300 bg-white text-gray-900'
      )}
      style={{
        zIndex: Z.nodeTooltip,
        left: rect.left + rect.width / 2,
        top: rect.top - 12,
        transform: 'translate(-50%, -100%)',
        width: 360,
        maxHeight: 280,
        overflow: 'hidden',
      }}
    >
      {label && <div className="mb-1 text-xs font-bold tracking-wide uppercase opacity-70">{label}</div>}
      <div className="text-sm leading-relaxed whitespace-pre-wrap">{text || <span className="italic opacity-50">(empty)</span>}</div>
    </div>
  )
}

export const NoteCard = memo(NoteCardComponent, arePropsEqual)
