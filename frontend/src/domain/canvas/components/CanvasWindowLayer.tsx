'use client'

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { Crosshair, X } from 'lucide-react'
import type { ReactFlowInstance } from '@xyflow/react'
import { cn } from '@/lib/utils'
import { Note } from '@piano/shared'
import { useCanvasStore, useCanvasStoreEq, areNodesStructurallyEqual } from '../store'
import { Z, LAYER_RESERVED } from '../lib/z-layers'
import { readSavedWindows, writeSavedWindows, type SavedCanvasWindow } from '../lib/window-persistence'
import { NodeEditPanel } from './NodeEditPanel'
import { MachineEditPanel } from './MachineEditPanel'
import { WindowActionBar, type WindowActionHandlers } from './WindowActions'

interface Point {
  x: number
  y: number
}
interface Size {
  width: number
  height: number
}
interface Rect {
  x: number
  y: number
  width: number
  height: number
}

type WindowMode = 'open' | 'minimized' | 'maximized'

interface WindowState {
  id: string
  tabNodeIds: string[]
  activeNodeId: string
  position: Point // user-chosen position for 'open' state
  size: Size // user-chosen size for 'open' state
  state: WindowMode
  zIndex: number
  tabLayout: 'horizontal' | 'vertical'
  // Windows sharing a groupId minimize/restore together. When a grouped
  // window is restored, any non-group windows that are currently open get
  // minimized (Stage-Manager-style exclusivity).
  groupId: string | null
}

interface WindowBlueprint {
  size: Size
  position: Point
}

export interface CanvasWindowLayerStats {
  open: number
  minimized: number
  canGroup: boolean // 1+ open windows, not all already in the same group
  canUngroup: boolean // 1+ open windows, all in the same group
}

export interface CanvasWindowLayerHandle {
  toggleGroup: () => void
  minimizeAll: () => void
  openNode: (nodeId: string) => void
}

interface CanvasWindowLayerProps {
  arrangementId: string | null
  persistenceReady: boolean
  selectedNodeId: string | null
  reactFlowInstance?: ReactFlowInstance | null
  onStatsChange?: (stats: CanvasWindowLayerStats) => void
}

// Group outlines and labels are intentionally monochrome — colour-coding
// by groupId hash adds visual noise without helping the user (the group's
// NAME already carries the meaning). Outline border + label stay slate.
const GROUP_NAME_ADJECTIVES = ['quiet', 'brisk', 'amber', 'eager', 'silver', 'steady', 'lucky', 'rapid'] as const
const GROUP_NAME_NOUNS = ['otter', 'falcon', 'harbor', 'cedar', 'anchor', 'comet', 'meadow', 'thunder'] as const

function defaultGroupName(groupId: string): string {
  let hash = 0
  for (let i = 0; i < groupId.length; i++) hash = (hash * 33 + groupId.charCodeAt(i)) | 0
  const adjective = GROUP_NAME_ADJECTIVES[Math.abs(hash) % GROUP_NAME_ADJECTIVES.length]
  const noun = GROUP_NAME_NOUNS[Math.abs(hash >> 3) % GROUP_NAME_NOUNS.length]
  return `${adjective}-${noun}`
}

function sanitizeGroupName(label: string): string | null {
  const name = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16)
    .replace(/-+$/g, '')
  return name || null
}

// GroupId is an in-memory marker, not a security-sensitive identifier.
// crypto.randomUUID() needs a Secure Context (HTTPS/localhost); non-secure
// HTTP pages throw here. A timestamp + random suffix gives enough entropy
// to collision-avoid across a user session, which is all we need.
function newGroupId(): string {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// WindowState ids are stable per-window identifiers, INDEPENDENT of the
// node(s) they host. Deriving id from a nodeId breaks once a tab detaches
// (source window keeps its old id, detached window receives the same one)
// → React sees two siblings with the same key → crash.
function newWindowId(): string {
  return `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const MARGIN = 16
const MIN_SIZE: Size = { width: 360, height: 280 }

// Z-index layering for windows, dock thumbnails and group outlines is
// centralised in `../lib/z-layers.ts`. Within a layer we use bounded integer
// deltas (user bumpZ for open windows, dock index for thumbnails) that must
// stay under LAYER_RESERVED so they don't bleed into the next layer.

// All docked windows share the same height. Their widths differ to preserve
// each window's aspect ratio: w_dock = w_open * TARGET_DOCK_HEIGHT / h_open.
// The thumbnail IS the real window, visually shrunk via CSS transform — no
// re-styling, no re-rendering, no mini-preview. A black terminal stays
// black, a markdown panel stays white, etc.
const TARGET_DOCK_HEIGHT = 130
const DOCK_MAX_WIDTH_RATIO = 0.75
const DOCK_HOVER_SCALE = 1.04
const DOCK_GAP = 8
const DOCK_BOTTOM = 18
// Reserved space below open/maximized windows so they don't overlap the dock.
const DOCK_RESERVED = TARGET_DOCK_HEIGHT + DOCK_BOTTOM + 12

// 300ms, strong end-deceleration. Minimize/restore animates only `transform`
// (scale + translate). Open↔maximized additionally animates `width`/`height`.
const EASE = 'cubic-bezier(0.25, 1, 0.4, 1)'
const DURATION = 300
const TRANSITION = `transform ${DURATION}ms ${EASE}, width ${DURATION}ms ${EASE}, height ${DURATION}ms ${EASE}, opacity 180ms ease-out`
// Border radius for open/maximized windows. When minimized the outer div is
// CSS-scaled, so the radius shrinks proportionally — no extra calculation.
const WINDOW_RADIUS = 8

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max)

const isMachineLike = (node: any) => node?.type === 'machine' || node?.type === 'terminal'

const titleOf = (node: any) =>
  (node?.data?.label as string | undefined)?.trim() ||
  (node?.type === 'machine' ? 'Machine' : node?.type === 'terminal' ? 'Terminal' : node?.type === 'text' ? 'Text node' : 'Note')

const kindOf = (node: any) =>
  node?.type === 'machine' ? 'Machine' : node?.type === 'terminal' ? 'Terminal' : node?.type === 'text' ? 'Text' : 'Note'

const defaultSize = (node: any): Size => (isMachineLike(node) ? { width: 760, height: 560 } : { width: 560, height: 640 })

function spawnPosition(size: Size, container: Size, count: number): Point {
  const cascade = (count % 6) * 28
  return {
    x: clamp(80 + cascade, MARGIN, Math.max(MARGIN, container.width - size.width - MARGIN)),
    y: clamp(60 + cascade, MARGIN, Math.max(MARGIN, container.height - size.height - DOCK_RESERVED)),
  }
}

function offsetPosition(position: Point, size: Size, container: Size, steps: number): Point {
  const offset = 28 * (steps % 6)
  return {
    x: clamp(position.x + offset, MARGIN, Math.max(MARGIN, container.width - size.width - MARGIN)),
    y: clamp(position.y + offset, MARGIN, Math.max(MARGIN, container.height - size.height - DOCK_RESERVED)),
  }
}

/**
 * Two windows "occupy the same spot" when their top-left corners are
 * within this many pixels of each other. We don't use full rect
 * intersection because partial overlap is fine and common; only near-
 * identical placement would look like a stacked dupe that needs cascading.
 */
const POSITION_COLLISION_THRESHOLD = 40

function spotTaken(p: Point, windows: WindowState[]): boolean {
  return windows.some(
    (w) =>
      w.state !== 'minimized' &&
      Math.abs(w.position.x - p.x) < POSITION_COLLISION_THRESHOLD &&
      Math.abs(w.position.y - p.y) < POSITION_COLLISION_THRESHOLD,
  )
}

function clampWindowPosition(position: Point, size: Size, container: Size): Point {
  return {
    x: clamp(position.x, MARGIN, Math.max(MARGIN, container.width - size.width - MARGIN)),
    y: clamp(position.y, MARGIN, Math.max(MARGIN, container.height - size.height - DOCK_RESERVED)),
  }
}

/**
 * Pick a landing spot for a new window. If `desired` is free, use it
 * verbatim — this lets a closed window reopen exactly where it was. If
 * that spot is already taken by another open window, cascade-offset
 * until we find a free one (or give up after six steps and take it
 * anyway; by then the user moved something).
 */
function resolvePosition(desired: Point, size: Size, container: Size, windows: WindowState[]): Point {
  let candidate = clampWindowPosition(desired, size, container)
  for (let step = 1; step <= 6 && spotTaken(candidate, windows); step++) {
    candidate = offsetPosition(desired, size, container, step)
  }
  return candidate
}

/**
 * The whole visual model in one function. Given a window's state and — if
 * minimized — its precomputed dock rect, return the concrete {x, y, w, h}.
 * The outer <div> binds transform/width/height to this, and CSS transitions
 * morph smoothly between any two states. No separate dock component — the
 * dock IS the set of windows in the 'minimized' state.
 */
function windowRect(ws: WindowState, dockRect: Rect | null, hasDock: boolean, container: Size): Rect {
  switch (ws.state) {
    case 'maximized': {
      const bottomReserve = hasDock ? DOCK_RESERVED : MARGIN
      return {
        x: MARGIN,
        y: MARGIN,
        width: Math.max(MIN_SIZE.width, container.width - MARGIN * 2),
        height: Math.max(MIN_SIZE.height, container.height - MARGIN - bottomReserve),
      }
    }
    case 'minimized':
      // dockRect is guaranteed to exist when state === 'minimized' because the
      // layer computes one rect per minimized window; fall back defensively.
      return dockRect ?? { x: 0, y: container.height, width: 100, height: TARGET_DOCK_HEIGHT }
    case 'open':
      return { x: ws.position.x, y: ws.position.y, width: ws.size.width, height: ws.size.height }
  }
}

function scaleRectFromTopLeft(rect: Rect, scale: number): Rect {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width * scale,
    height: rect.height * scale,
  }
}

function scaleRectFromCenter(rect: Rect, scale: number): Rect {
  const width = rect.width * scale
  const height = rect.height * scale
  return {
    x: rect.x - (width - rect.width) / 2,
    y: rect.y - (height - rect.height) / 2,
    width,
    height,
  }
}

function dockHoverKey(window: WindowState): string {
  return window.groupId ?? `solo:${window.id}`
}

/**
 * Compute the dock layout. All slots share TARGET_DOCK_HEIGHT; each slot's
 * width preserves its window's aspect ratio (so square windows stay square,
 * wide windows stay wide, tall windows stay tall in the dock). Slots are
 * sorted left→right by the horizontal center of each window's saved position
 * — stable, click doesn't reorder. The whole row is centered in the
 * container and sits DOCK_BOTTOM px above the bottom edge.
 */
function computeDockLayout(
  windows: WindowState[],
  container: Size,
): {
  rects: Map<string, Rect>
  /**
   * Left-to-right index of each dock slot (0, 1, 2…). Used as a small,
   * bounded z-index offset so the stacking order matches the visual order
   * without embedding pixel coordinates into z-space.
   */
  orderIndex: Map<string, number>
  hasDock: boolean
} {
  const minimized = windows.filter((w) => w.state === 'minimized')

  const groups = new Map<string, WindowState[]>()
  for (const window of minimized) {
    const key = window.groupId ?? `solo:${window.id}`
    const list = groups.get(key) ?? []
    list.push(window)
    groups.set(key, list)
  }

  const minimizedOrdered = [...groups.values()]
    .map((group) => [...group].sort((a, b) => a.position.x + a.size.width / 2 - (b.position.x + b.size.width / 2)))
    .sort((a, b) => {
      const ax = Math.min(...a.map((w) => w.position.x + w.size.width / 2))
      const bx = Math.min(...b.map((w) => w.position.x + w.size.width / 2))
      return ax - bx
    })
    .flat()

  if (minimizedOrdered.length === 0) {
    return { rects: new Map(), orderIndex: new Map(), hasDock: false }
  }

  const baseSlots = minimizedOrdered.map((w) => ({
    id: w.id,
    // Aspect-preserving: height is fixed, width follows from window's aspect.
    width: Math.max(80, w.size.width * (TARGET_DOCK_HEIGHT / w.size.height)),
  }))

  const baseTotalWidth = baseSlots.reduce((s, x) => s + x.width, 0) + (baseSlots.length - 1) * DOCK_GAP
  const maxDockWidth = Math.max(1, container.width * DOCK_MAX_WIDTH_RATIO)
  const dockScale = Math.min(1, maxDockWidth / baseTotalWidth)
  const dockHeight = TARGET_DOCK_HEIGHT * dockScale
  const dockGap = DOCK_GAP * dockScale
  const slots = baseSlots.map((slot) => ({ ...slot, width: slot.width * dockScale, height: dockHeight }))
  const totalWidth = baseTotalWidth * dockScale
  const startX = Math.max(MARGIN, (container.width - totalWidth) / 2)
  const baseY = container.height - dockHeight - DOCK_BOTTOM

  const rects = new Map<string, Rect>()
  const orderIndex = new Map<string, number>()
  let cursorX = startX
  slots.forEach((slot, i) => {
    rects.set(slot.id, { x: cursorX, y: baseY, width: slot.width, height: slot.height })
    orderIndex.set(slot.id, i)
    cursorX += slot.width + dockGap
  })

  return { rects, orderIndex, hasDock: true }
}

// Window actions (close / minimize / maximize / add-tab / toggle tabs)
// are declared once in ./WindowActions.tsx and rendered by the shared
// <WindowActionBar>. Both the open-window header and the docked
// thumbnail use the same bar — full parity, single source of truth.

interface CanvasWindowProps {
  windowState: WindowState
  rect: Rect
  dockHoverScale: number
  node: any
  tabNodes: any[]
  container: Size
  selected: boolean
  collectingTabs: boolean
  effectiveZIndex: number
  onBringToFront: () => void
  onDockHoverChange: (hovered: boolean) => void
  onClose: () => void
  onCloseWindow: () => void
  onMinimize: () => void
  onMaximize: () => void
  onRestore: () => void
  onCommitPosition: (p: Point) => void
  onCommitGeometry: (p: Point, s: Size) => void
  onBeginAddTab: () => void
  onActivateTab: (nodeId: string) => void
  onCloseTab: (nodeId: string) => void
  onDetachTab: (nodeId: string) => void
  onFocusTab: (nodeId: string) => void
  onToggleTabLayout: () => void
}

function CanvasWindow({
  windowState,
  rect,
  dockHoverScale,
  node,
  tabNodes,
  container,
  selected,
  collectingTabs,
  effectiveZIndex,
  onBringToFront,
  onDockHoverChange,
  onClose,
  onCloseWindow,
  onMinimize,
  onMaximize,
  onRestore,
  onCommitPosition,
  onCommitGeometry,
  onBeginAddTab,
  onActivateTab,
  onCloseTab,
  onDetachTab,
  onFocusTab,
  onToggleTabLayout,
}: CanvasWindowProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  const [interacting, setInteracting] = useState(false)

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const isMinimized = windowState.state === 'minimized'
  const isMaximized = windowState.state === 'maximized'
  const minimizedScale = rect.height / windowState.size.height
  const effectiveMinimizedScale = minimizedScale * dockHoverScale

  const startDrag = useCallback(
    (e: ReactMouseEvent) => {
      if (e.button !== 0 || isMaximized || isMinimized) return
      e.preventDefault()
      onBringToFront()

      const el = ref.current
      if (!el) return

      const offsetX = e.clientX - windowState.position.x
      const offsetY = e.clientY - windowState.position.y
      const maxX = Math.max(MARGIN, container.width - windowState.size.width - MARGIN)
      const maxY = Math.max(MARGIN, container.height - windowState.size.height - DOCK_RESERVED)
      let last = windowState.position

      setInteracting(true)
      const onMove = (ev: MouseEvent) => {
        last = {
          x: clamp(ev.clientX - offsetX, MARGIN, maxX),
          y: clamp(ev.clientY - offsetY, MARGIN, maxY),
        }
        el.style.transform = `translate3d(${last.x}px, ${last.y}px, 0)`
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setInteracting(false)
        onCommitPosition(last)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [container.height, container.width, isMaximized, isMinimized, onBringToFront, onCommitPosition, windowState.position, windowState.size],
  )

  type ResizeEdge = 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

  const startResize = useCallback(
    (edge: ResizeEdge, e: ReactMouseEvent) => {
      if (e.button !== 0 || isMaximized || isMinimized) return
      e.preventDefault()
      e.stopPropagation()
      onBringToFront()

      const el = ref.current
      if (!el) return

      const mouseX0 = e.clientX
      const mouseY0 = e.clientY
      const w0 = windowState.size.width
      const h0 = windowState.size.height
      const x0 = windowState.position.x
      const y0 = windowState.position.y

      const fromLeft = edge === 'left' || edge === 'top-left' || edge === 'bottom-left'
      const fromRight = edge === 'right' || edge === 'top-right' || edge === 'bottom-right'
      const fromTop = edge === 'top' || edge === 'top-left' || edge === 'top-right'
      const fromBottom = edge === 'bottom' || edge === 'bottom-left' || edge === 'bottom-right'

      let lastSize = { width: w0, height: h0 }
      let lastPos = { x: x0, y: y0 }

      setInteracting(true)
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - mouseX0
        const dy = ev.clientY - mouseY0
        let w = w0,
          h = h0,
          x = x0,
          y = y0

        if (fromRight) {
          w = clamp(w0 + dx, MIN_SIZE.width, Math.max(MIN_SIZE.width, container.width - x0 - MARGIN))
        } else if (fromLeft) {
          w = clamp(w0 - dx, MIN_SIZE.width, Math.max(MIN_SIZE.width, x0 + w0 - MARGIN))
          x = x0 + w0 - w
        }
        if (fromTop) {
          h = clamp(h0 - dy, MIN_SIZE.height, Math.max(MIN_SIZE.height, y0 + h0 - MARGIN))
          y = y0 + h0 - h
        }
        if (fromBottom) {
          h = clamp(h0 + dy, MIN_SIZE.height, Math.max(MIN_SIZE.height, container.height - y0 - DOCK_RESERVED))
        }

        lastSize = { width: w, height: h }
        lastPos = { x, y }
        el.style.width = `${w}px`
        el.style.height = `${h}px`
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setInteracting(false)
        onCommitGeometry(lastPos, lastSize)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [
      container.height,
      container.width,
      isMaximized,
      isMinimized,
      onBringToFront,
      onCommitGeometry,
      windowState.position,
      windowState.size,
    ],
  )

  // Tabs are always present because a single-tab window still needs the same
  // per-tab affordances (focus/close) as a multi-tab window.
  const hasTabs = tabNodes.length >= 1 || collectingTabs
  const shellTint = isMachineLike(node) ? 'from-slate-50 via-white to-slate-100' : 'from-amber-50 via-white to-orange-50'

  // Single source of truth for every window action. Same `ctx` + `handlers`
  // feed both the open-window header bar and the docked-thumbnail overlay.
  const actionCtx = {
    state: windowState.state,
    tabCount: tabNodes.length,
    tabLayout: windowState.tabLayout,
    collectingTabs,
  }
  const actionHandlers: WindowActionHandlers = {
    onClose,
    onMinimize,
    onMaximize,
    onRestore,
    onBeginAddTab,
    onToggleTabLayout,
  }

  const renderTab = (tabNode: any) => {
    const active = tabNode.id === windowState.activeNodeId
    return (
      <div
        key={tabNode.id}
        className={cn(
          'flex items-center gap-1 rounded-full border text-xs transition-colors',
          windowState.tabLayout === 'vertical' ? 'max-w-full px-2 py-1' : 'h-7 max-w-[220px] pr-1 pl-3',
          active
            ? 'border-stone-300 bg-stone-100 text-stone-900'
            : 'border-transparent bg-stone-50 text-stone-600 hover:border-stone-200 hover:bg-stone-100',
        )}
        onMouseDown={(event) => {
          if (event.button === 1) {
            event.preventDefault()
            onCloseTab(tabNode.id)
          }
          event.stopPropagation()
        }}
      >
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left"
          onClick={(e) => {
            e.stopPropagation()
            onActivateTab(tabNode.id)
          }}
          title={titleOf(tabNode)}
        >
          {titleOf(tabNode)}
        </button>
        <button
          type="button"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-stone-400 hover:bg-black/5 hover:text-stone-700"
          onClick={(e) => {
            e.stopPropagation()
            onFocusTab(tabNode.id)
          }}
          title={`Focus ${titleOf(tabNode)} on canvas`}
        >
          <Crosshair className="h-3 w-3" />
        </button>
        {tabNodes.length > 1 && (
          <button
            type="button"
            className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-stone-400 hover:bg-black/5 hover:text-stone-700"
            onClick={(e) => {
              e.stopPropagation()
              onDetachTab(tabNode.id)
            }}
            title={`Pop out ${titleOf(tabNode)}`}
          >
            Pop
          </button>
        )}
        <button
          type="button"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-stone-400 hover:bg-black/5 hover:text-stone-700"
          onClick={(e) => {
            e.stopPropagation()
            onCloseTab(tabNode.id)
          }}
          title={`Close ${titleOf(tabNode)}`}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className={cn(
        'group/window pointer-events-auto absolute top-0 left-0 flex flex-col overflow-hidden border border-black/10 bg-white/95',
        selected && 'ring-2 ring-amber-300/80',
        collectingTabs && 'ring-2 ring-sky-300/80',
        isMinimized && 'cursor-pointer',
      )}
      style={{
        transform: isMinimized
          ? `translate3d(${rect.x + (rect.width * (1 - dockHoverScale)) / 2}px, ${rect.y + (rect.height * (1 - dockHoverScale)) / 2}px, 0) scale(${effectiveMinimizedScale})`
          : `translate3d(${rect.x}px, ${rect.y}px, 0)`,
        transformOrigin: 'top left',
        width: isMinimized ? windowState.size.width : rect.width,
        height: isMinimized ? windowState.size.height : rect.height,
        borderRadius: WINDOW_RADIUS,
        opacity: mounted ? 1 : 0,
        zIndex: effectiveZIndex,
        transition: interacting ? 'none' : TRANSITION,
        boxShadow: selected ? '0 14px 32px rgba(15, 23, 42, 0.14)' : '0 8px 18px rgba(15, 23, 42, 0.07)',
      }}
      // Minimized windows don't bringToFront on mousedown: they live in the
      // `windowDock` z-layer (see ../lib/z-layers.ts), and bumping their
      // zIndex would perturb anything that depends on it. More importantly,
      // a re-render between mousedown
      // and click would slide the element away from the cursor and swallow
      // the click — that was the bug where clicking the left dock icon
      // teleported it to the right instead of restoring it.
      onMouseDownCapture={isMinimized ? undefined : onBringToFront}
      onClick={isMinimized ? onRestore : undefined}
      title={isMinimized ? `Restore ${titleOf(node)}` : undefined}
      onMouseEnter={isMinimized ? () => onDockHoverChange(true) : undefined}
      onMouseLeave={isMinimized ? () => onDockHoverChange(false) : undefined}
    >
      {/* The real window UI — no mini-preview, no re-styling. When minimized,
          the outer box retains its full layout size (windowState.size) and is
          visually shrunk via `transform: scale(s)`. Only `transform` animates,
          never layout dimensions — so ResizeObserver inside the terminal never
          fires during minimize/restore, preventing resize storms and display
          corruption. overflow:hidden clips any sub-pixel overshoot. */}
      <div className={cn('absolute inset-0 flex flex-col', isMinimized && 'pointer-events-none')}>
        <div
          className={cn(
            'flex cursor-grab items-center justify-between gap-3 border-b border-black/5 bg-gradient-to-r px-3 py-2 select-none active:cursor-grabbing',
            shellTint,
          )}
          onMouseDown={startDrag}
          onDoubleClick={onMaximize}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <WindowActionBar ctx={actionCtx} handlers={actionHandlers} />
            {hasTabs && windowState.tabLayout === 'horizontal' ? (
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-0.5">
                {tabNodes.map(renderTab)}
                {collectingTabs && (
                  <div className="rounded-full border border-dashed border-sky-300 bg-sky-50 px-3 py-1 text-[11px] whitespace-nowrap text-sky-700">
                    Click a node on the canvas to add as tab
                  </div>
                )}
              </div>
            ) : (
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-900">{titleOf(node)}</div>
                <div className="truncate text-[11px] text-slate-500">
                  {kindOf(node)}
                  {tabNodes.length > 1 ? ` • ${tabNodes.length} tabs` : ''}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden bg-white/95">
          {hasTabs && windowState.tabLayout === 'vertical' && (
            <div className="flex w-44 flex-col gap-2 overflow-y-auto border-r border-black/5 bg-white/90 px-2 py-3">
              {tabNodes.map(renderTab)}
              {collectingTabs && (
                <div className="rounded-2xl border border-dashed border-sky-300 bg-sky-50 px-3 py-2 text-[11px] text-sky-700">
                  Click a node on the canvas to add as tab
                </div>
              )}
            </div>
          )}
          <div className="relative flex-1 overflow-hidden">
            {isMachineLike(node) ? (
              <MachineEditPanel nodeId={windowState.activeNodeId} embedded onClose={onClose} />
            ) : (
              <NodeEditPanel nodeId={windowState.activeNodeId} embedded onClose={onClose} />
            )}
          </div>
        </div>

        {!isMaximized && !isMinimized && (
          <>
            <div
              className="absolute top-0 right-3 left-3 h-[5px] -translate-y-px cursor-row-resize"
              onMouseDown={(e) => startResize('top', e)}
            />
            <div
              className="absolute top-8 bottom-3 left-0 w-[5px] -translate-x-px cursor-col-resize"
              onMouseDown={(e) => startResize('left', e)}
            />
            <div
              className="absolute top-8 right-0 bottom-3 w-[5px] translate-x-px cursor-col-resize"
              onMouseDown={(e) => startResize('right', e)}
            />
            <div
              className="absolute right-3 bottom-0 left-3 h-[5px] translate-y-px cursor-row-resize"
              onMouseDown={(e) => startResize('bottom', e)}
            />
            <div className="absolute top-0 left-0 h-3.5 w-3.5 cursor-nwse-resize" onMouseDown={(e) => startResize('top-left', e)} />
            <div className="absolute top-0 right-0 h-3.5 w-3.5 cursor-nesw-resize" onMouseDown={(e) => startResize('top-right', e)} />
            <div className="absolute bottom-0 left-0 h-3.5 w-3.5 cursor-nesw-resize" onMouseDown={(e) => startResize('bottom-left', e)} />
            <div className="absolute right-0 bottom-0 h-3.5 w-3.5 cursor-nwse-resize" onMouseDown={(e) => startResize('bottom-right', e)} />
          </>
        )}
      </div>

      {isMinimized && (
        <button
          type="button"
          className="pointer-events-auto absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-full border border-black/10 bg-white/95 text-slate-500 opacity-0 shadow-md backdrop-blur transition-opacity hover:bg-red-50 hover:text-red-600 group-hover/window:opacity-100"
          style={{
            transform: `scale(${1 / minimizedScale})`,
            transformOrigin: 'top right',
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onCloseWindow()
          }}
          title={`Close ${titleOf(node)}`}
          aria-label={`Close ${titleOf(node)}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

const bumpZ = (list: WindowState[]) => list.reduce((m, w) => Math.max(m, w.zIndex), 0) + 1

const sameWindowBlueprint = (a: WindowBlueprint | null, b: WindowBlueprint) =>
  !!a &&
  a.size.width === b.size.width &&
  a.size.height === b.size.height &&
  a.position.x === b.position.x &&
  a.position.y === b.position.y

const copyWindowBlueprint = (blueprint: WindowBlueprint): WindowBlueprint => ({
  size: { ...blueprint.size },
  position: { ...blueprint.position },
})

function CanvasWindowLayerComponent(
  { arrangementId, persistenceReady, selectedNodeId, reactFlowInstance, onStatsChange }: CanvasWindowLayerProps,
  ref: React.Ref<CanvasWindowLayerHandle>,
) {
  const clearSelectedNode = useCanvasStore((state) => state.clearSelectedNode)
  // Subscribe internally with the position-skipping equality fn so that a
  // node drag (60Hz position updates) doesn't re-render this 1500-line
  // component. Only id / data / hidden changes — the things `nodesById`
  // actually consumes — trip the equality check.
  const nodes = useCanvasStoreEq((state) => state.nodes, areNodesStructurallyEqual)
  const overlayRef = useRef<HTMLDivElement>(null)
  const seenSelectedRef = useRef<string | null>(null)
  const arrangementWindowsKeyRef = useRef<string | null | undefined>(undefined)
  const hydratedWindowsForArrangementIdRef = useRef<string | null>(null)
  const skipNextWindowPersistRef = useRef(false)
  const lastWindowBlueprintRef = useRef<WindowBlueprint | null>(null)
  const deferredSelectionTimerRef = useRef<number | null>(null)

  const [containerSize, setContainerSize] = useState<Size>({ width: 1280, height: 720 })
  const [windows, setWindows] = useState<WindowState[]>([])
  const [activeWindowId, setActiveWindowId] = useState<string | null>(null)
  const [groupNames, setGroupNames] = useState<Record<string, string>>({})
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [hoveredDockKey, setHoveredDockKey] = useState<string | null>(null)
  const [lastWindowBlueprint, setLastWindowBlueprint] = useState<WindowBlueprint | null>(null)
  const [pendingTabTargetId, setPendingTabTargetId] = useState<string | null>(null)

  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const selectCanvasNode = useCallback((nodeId: string | null, options?: { defer?: boolean }) => {
    const apply = () => {
      deferredSelectionTimerRef.current = null
      if (useCanvasStore.getState().selectedNodeId === nodeId) return
      useCanvasStore.setState({ selectedNodeId: nodeId })
    }

    if (deferredSelectionTimerRef.current !== null) {
      window.clearTimeout(deferredSelectionTimerRef.current)
      deferredSelectionTimerRef.current = null
    }

    if (options?.defer) {
      // Restoring a docked window should let the transform commit before the
      // global canvas selection wakes every node/edge store subscriber.
      deferredSelectionTimerRef.current = window.setTimeout(apply, DURATION)
      return
    }

    apply()
  }, [])

  useEffect(() => {
    return () => {
      if (deferredSelectionTimerRef.current !== null) {
        window.clearTimeout(deferredSelectionTimerRef.current)
      }
    }
  }, [])

  const rememberWindowBlueprint = useCallback((blueprint: WindowBlueprint) => {
    const next = copyWindowBlueprint(blueprint)
    if (sameWindowBlueprint(lastWindowBlueprintRef.current, next)) return
    lastWindowBlueprintRef.current = next
    setLastWindowBlueprint((prev) => {
      if (sameWindowBlueprint(prev, next)) return prev
      return next
    })
  }, [])

  useEffect(() => {
    if (arrangementWindowsKeyRef.current === arrangementId) return
    arrangementWindowsKeyRef.current = arrangementId
    hydratedWindowsForArrangementIdRef.current = null
    setWindows([])
    setActiveWindowId(null)
    setGroupNames({})
    setEditingGroupId(null)
    setHoveredDockKey(null)
    lastWindowBlueprintRef.current = null
    setLastWindowBlueprint(null)
    setPendingTabTargetId(null)
  }, [arrangementId])

  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const update = () => setContainerSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    setWindows((prev) => {
      let changed = false
      const next = prev.flatMap((ws) => {
        const tabs = ws.tabNodeIds.filter((id) => nodesById.has(id))
        if (tabs.length === 0) {
          changed = true
          return []
        }
        const activeNodeId = tabs.includes(ws.activeNodeId) ? ws.activeNodeId : tabs[0]
        if (tabs.length === ws.tabNodeIds.length && activeNodeId === ws.activeNodeId) return [ws]
        changed = true
        return [{ ...ws, tabNodeIds: tabs, activeNodeId }]
      })
      return changed ? next : prev
    })
  }, [nodesById])

  useEffect(() => {
    if (!pendingTabTargetId) return
    if (windows.some((w) => w.id === pendingTabTargetId)) return
    setPendingTabTargetId(null)
  }, [pendingTabTargetId, windows])

  useEffect(() => {
    const liveGroupIds = new Set(windows.map((window) => window.groupId).filter((groupId): groupId is string => !!groupId))
    setGroupNames((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([groupId]) => liveGroupIds.has(groupId)))
      return Object.keys(next).length === Object.keys(prev).length ? prev : next
    })
  }, [windows])

  useEffect(() => {
    if (!activeWindowId) return
    if (windows.some((window) => window.id === activeWindowId)) return
    const fallback =
      windows.filter((window) => window.state !== 'minimized').sort((a, b) => b.zIndex - a.zIndex)[0] ?? windows[windows.length - 1] ?? null
    setActiveWindowId(fallback?.id ?? null)
  }, [activeWindowId, windows])

  useEffect(() => {
    if (!arrangementId || !persistenceReady) return
    if (hydratedWindowsForArrangementIdRef.current === arrangementId) return

    const saved = readSavedWindows(arrangementId)
    const liveContainer = overlayRef.current
      ? { width: overlayRef.current.clientWidth, height: overlayRef.current.clientHeight }
      : containerSize
    const restoredWindows = (saved?.windows ?? [])
      .map((window): WindowState | null => {
        const tabNodeIds = window.tabNodeIds.filter((id) => nodesById.has(id))
        if (tabNodeIds.length === 0) return null
        const activeNodeId = tabNodeIds.includes(window.activeNodeId) ? window.activeNodeId : tabNodeIds[0]
        return {
          id: window.id,
          tabNodeIds,
          activeNodeId,
          position: {
            x: clamp(window.position.x, MARGIN, Math.max(MARGIN, liveContainer.width - window.size.width - MARGIN)),
            y: clamp(window.position.y, MARGIN, Math.max(MARGIN, liveContainer.height - window.size.height - DOCK_RESERVED)),
          },
          size: {
            width: clamp(window.size.width, MIN_SIZE.width, Math.max(MIN_SIZE.width, liveContainer.width - MARGIN * 2)),
            height: clamp(window.size.height, MIN_SIZE.height, Math.max(MIN_SIZE.height, liveContainer.height - MARGIN - DOCK_RESERVED)),
          },
          state: window.state,
          zIndex: window.zIndex,
          tabLayout: window.tabLayout,
          groupId: window.groupId,
        }
      })
      .filter((window): window is WindowState => !!window)
    const liveGroupIds = new Set(restoredWindows.map((window) => window.groupId).filter((groupId): groupId is string => !!groupId))
    const activeWindowId =
      restoredWindows.find((window) => window.id === saved?.activeWindowId)?.id ??
      restoredWindows.filter((window) => window.state !== 'minimized').sort((a, b) => b.zIndex - a.zIndex)[0]?.id ??
      restoredWindows[0]?.id ??
      null

    skipNextWindowPersistRef.current = true
    setWindows(restoredWindows)
    setActiveWindowId(activeWindowId)
    setGroupNames(Object.fromEntries(Object.entries(saved?.groupNames ?? {}).filter(([groupId]) => liveGroupIds.has(groupId))))
    lastWindowBlueprintRef.current = saved?.lastWindowBlueprint ? copyWindowBlueprint(saved.lastWindowBlueprint) : null
    setLastWindowBlueprint(lastWindowBlueprintRef.current)
    hydratedWindowsForArrangementIdRef.current = arrangementId
  }, [arrangementId, containerSize, nodesById, persistenceReady])

  useEffect(() => {
    if (!arrangementId || hydratedWindowsForArrangementIdRef.current !== arrangementId) return
    if (skipNextWindowPersistRef.current) {
      skipNextWindowPersistRef.current = false
      return
    }
    writeSavedWindows(arrangementId, {
      windows: windows.map((window): SavedCanvasWindow => ({
        id: window.id,
        tabNodeIds: window.tabNodeIds,
        activeNodeId: window.activeNodeId,
        position: window.position,
        size: window.size,
        state: window.state,
        zIndex: window.zIndex,
        tabLayout: window.tabLayout,
        groupId: window.groupId,
      })),
      activeWindowId,
      groupNames,
      lastWindowBlueprint,
    })
  }, [activeWindowId, arrangementId, groupNames, lastWindowBlueprint, windows])

  const commitGroupName = useCallback((groupId: string, raw: string) => {
    const trimmed = raw.trim()
    setGroupNames((prev) => ({
      ...prev,
      [groupId]: trimmed || defaultGroupName(groupId),
    }))
    setEditingGroupId(null)
  }, [])

  const spawnWindowState = useCallback(
    (nodeId: string, node: any, prev: WindowState[], options?: { position?: Point; size?: Size; id?: string }): WindowState => {
      const blueprint = lastWindowBlueprintRef.current
      const fallbackSize = defaultSize(node)
      const size = options?.size
        ? {
            width: clamp(options.size.width, MIN_SIZE.width, Math.max(MIN_SIZE.width, containerSize.width - MARGIN * 2)),
            height: clamp(options.size.height, MIN_SIZE.height, Math.max(MIN_SIZE.height, containerSize.height - MARGIN - DOCK_RESERVED)),
          }
        : blueprint?.size
          ? {
              width: clamp(blueprint.size.width, MIN_SIZE.width, Math.max(MIN_SIZE.width, containerSize.width - MARGIN * 2)),
              height: clamp(
                blueprint.size.height,
                MIN_SIZE.height,
                Math.max(MIN_SIZE.height, containerSize.height - MARGIN - DOCK_RESERVED),
              ),
            }
          : fallbackSize

      // Desired landing = explicit caller override ▸ last interacted/closed
      // window shape ▸ cascade default.
      const desiredPosition =
        options?.position ??
        blueprint?.position ??
        spawnPosition(size, containerSize, prev.filter((w) => w.state !== 'minimized').length)
      const basePosition = resolvePosition(desiredPosition, size, containerSize, prev)

      return {
        id: options?.id ?? newWindowId(),
        tabNodeIds: [nodeId],
        activeNodeId: nodeId,
        position: basePosition,
        size,
        state: 'open',
        zIndex: bumpZ(prev),
        tabLayout: 'horizontal',
        groupId: null,
      }
    },
    [containerSize],
  )

  useEffect(() => {
    const open = windows.filter((w) => w.state !== 'minimized')
    const firstGroupId = open[0]?.groupId ?? null
    const allSameGroup = open.length >= 1 && firstGroupId !== null && open.every((w) => w.groupId === firstGroupId)
    onStatsChange?.({
      open: open.length,
      minimized: windows.length - open.length,
      canGroup: open.length >= 1 && !allSameGroup,
      canUngroup: allSameGroup,
    })
  }, [windows, onStatsChange])

  const bringToFront = useCallback(
    (id: string) => {
      const target = windows.find((w) => w.id === id)
      if (target) rememberWindowBlueprint(target)
      setActiveWindowId(id)
      setWindows((prev) => {
        const z = bumpZ(prev)
        return prev.map((w) => (w.id === id ? { ...w, zIndex: z } : w))
      })
    },
    [rememberWindowBlueprint, windows],
  )

  const activateTab = useCallback(
    (id: string, nodeId: string) => {
      const target = windows.find((w) => w.id === id)
      if (target) rememberWindowBlueprint(target)
      setActiveWindowId(id)
      setWindows((prev) => {
        const z = bumpZ(prev)
        return prev.map((w) =>
          w.id === id
            ? {
                ...w,
                activeNodeId: nodeId,
                state: w.state === 'minimized' ? 'open' : w.state,
                zIndex: z,
              }
            : w,
        )
      })
      selectCanvasNode(nodeId, { defer: target?.state === 'minimized' })
    },
    [rememberWindowBlueprint, selectCanvasNode, windows],
  )

  const addNodeAsTab = useCallback(
    (targetId: string, nodeId: string) => {
      if (!nodesById.get(nodeId)) return
      const target = windows.find((w) => w.id === targetId)
      if (target) rememberWindowBlueprint(target)
      setActiveWindowId(targetId)
      setWindows((prev) => {
        const z = bumpZ(prev)
        let found = false
        const next = prev.flatMap((w) => {
          if (w.id === targetId) {
            found = true
            const tabs = w.tabNodeIds.includes(nodeId) ? w.tabNodeIds : [...w.tabNodeIds, nodeId]
            return [
              {
                ...w,
                tabNodeIds: tabs,
                activeNodeId: nodeId,
                state: w.state === 'minimized' ? ('open' as WindowMode) : w.state,
                zIndex: z,
              },
            ]
          }
          if (w.tabNodeIds.includes(nodeId)) {
            const tabs = w.tabNodeIds.filter((t) => t !== nodeId)
            if (tabs.length === 0) return []
            return [
              {
                ...w,
                tabNodeIds: tabs,
                activeNodeId: w.activeNodeId === nodeId ? tabs[0] : w.activeNodeId,
              },
            ]
          }
          return [w]
        })
        return found ? next : prev
      })
      selectCanvasNode(nodeId, { defer: target?.state === 'minimized' })
      setPendingTabTargetId(null)
    },
    [nodesById, rememberWindowBlueprint, selectCanvasNode, windows],
  )

  const openOrFocus = useCallback(
    (nodeId: string) => {
      const node = nodesById.get(nodeId)
      if (!node) return
      if (!Note.capabilities(node?.data as { type?: Note.Type } | undefined).canOpenEditPanel) return
      if (pendingTabTargetId) {
        addNodeAsTab(pendingTabTargetId, nodeId)
        return
      }
      const existing = windows.find((window) => window.tabNodeIds.includes(nodeId))
      if (existing) {
        rememberWindowBlueprint(existing)
        setActiveWindowId(existing.id)
        // If the node's window is part of a HIDDEN (minimized) group, restore
        // the whole group — same cascade as clicking the group's restore —
        // instead of surfacing just this one window out of its group. Solo or
        // already-open windows keep the plain focus behaviour (don't disturb
        // other windows, don't un-maximize).
        const restoringGroup = existing.state === 'minimized' && existing.groupId !== null
        const groupMembers = restoringGroup
          ? new Set(windows.filter((w) => w.groupId === existing.groupId).map((w) => w.id))
          : new Set([existing.id])
        setWindows((prev) => {
          const z = bumpZ(prev)
          return prev.map((w) => {
            if (w.id === existing.id) {
              return { ...w, activeNodeId: nodeId, state: w.state === 'minimized' ? 'open' : w.state, zIndex: z }
            }
            if (groupMembers.has(w.id)) {
              return { ...w, state: w.state === 'minimized' ? 'open' : w.state, zIndex: z }
            }
            // Stage-Manager exclusivity, but only when actually un-hiding a group.
            if (restoringGroup && w.state !== 'minimized') {
              return { ...w, state: 'minimized' as WindowMode }
            }
            return w
          })
        })
        return
      }
      // Generate the new window's id up front so we can set it as active
      // without guessing. Window ids are self-referential (see newWindowId).
      const newId = newWindowId()
      setWindows((prev) => [...prev, spawnWindowState(nodeId, node, prev, { id: newId })])
      setActiveWindowId(newId)
    },
    [addNodeAsTab, nodesById, pendingTabTargetId, rememberWindowBlueprint, spawnWindowState, windows],
  )

  // Selection no longer auto-opens a window. Opening is an explicit gesture
  // (double-click on the node, see Canvas.tsx → openNode on the handle).
  // Exception: when tab-collection is in progress, a single click should add
  // the clicked node as a tab to the target window — keep that path live.
  useEffect(() => {
    if (!selectedNodeId) {
      seenSelectedRef.current = null
      return
    }
    if (!pendingTabTargetId) return
    if (seenSelectedRef.current === selectedNodeId) return
    seenSelectedRef.current = selectedNodeId
    openOrFocus(selectedNodeId)
  }, [openOrFocus, selectedNodeId, pendingTabTargetId])

  // IMPORTANT: cross-store side-effects (clearSelectedNode, setState on
  // useCanvasStore) must NOT happen inside a setWindows updater. Running a
  // Zustand setState inside a React state reducer synchronously notifies
  // subscribers (e.g. SyncStatusIndicator reading selectedNodeId), which
  // then schedule their own renders while CanvasWindowLayer is still in its
  // render/reducer phase — React flags that as "setState during render".
  // Pattern: decide with a snapshot of current state, call setWindows with
  // a PURE updater, then perform cross-store effects separately.

  const closeTab = useCallback(
    (id: string, nodeId: string) => {
      const target = windows.find((w) => w.id === id)
      if (!target) return
      const tabs = target.tabNodeIds.filter((t) => t !== nodeId)
      if (tabs.length === 0) {
        rememberWindowBlueprint(target)
        setWindows((prev) => prev.filter((w) => w.id !== id))
        if (selectedNodeId === nodeId) clearSelectedNode()
        return
      }
      const active = target.activeNodeId === nodeId ? tabs[0] : target.activeNodeId
      setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, tabNodeIds: tabs, activeNodeId: active } : w)))
      if (selectedNodeId === nodeId) selectCanvasNode(active)
    },
    [clearSelectedNode, rememberWindowBlueprint, selectCanvasNode, selectedNodeId, windows],
  )

  const closeActiveTabOrWindow = useCallback(
    (id: string) => {
      const target = windows.find((w) => w.id === id)
      if (!target) return
      if (target.tabNodeIds.length <= 1) {
        const shouldClear = target.tabNodeIds.includes(selectedNodeId || '')
        rememberWindowBlueprint(target)
        setWindows((prev) => prev.filter((w) => w.id !== id))
        if (shouldClear) clearSelectedNode()
        return
      }
      const tabs = target.tabNodeIds.filter((t) => t !== target.activeNodeId)
      const active = tabs[0]
      const shouldRetarget = selectedNodeId === target.activeNodeId
      setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, tabNodeIds: tabs, activeNodeId: active } : w)))
      if (shouldRetarget) selectCanvasNode(active)
    },
    [clearSelectedNode, rememberWindowBlueprint, selectCanvasNode, selectedNodeId, windows],
  )

  const closeWindow = useCallback(
    (id: string) => {
      const target = windows.find((w) => w.id === id)
      if (!target) return
      const shouldClear = target.tabNodeIds.includes(selectedNodeId || '')
      rememberWindowBlueprint(target)
      setWindows((prev) => prev.filter((w) => w.id !== id))
      if (shouldClear) clearSelectedNode()
    },
    [clearSelectedNode, rememberWindowBlueprint, selectedNodeId, windows],
  )

  const minimize = useCallback(
    (id: string) => {
      const target = windows.find((w) => w.id === id)
      if (!target) return
      rememberWindowBlueprint(target)
      // Cascade: if grouped, every member of the group minimizes together.
      const ids = target.groupId ? new Set(windows.filter((w) => w.groupId === target.groupId).map((w) => w.id)) : new Set([id])
      const shouldClear = [...ids].some((mid) => {
        const w = windows.find((x) => x.id === mid)
        return !!w?.tabNodeIds.includes(selectedNodeId || '')
      })
      setWindows((prev) => prev.map((w) => (ids.has(w.id) ? { ...w, state: 'minimized' as WindowMode } : w)))
      if (shouldClear) clearSelectedNode()
    },
    [clearSelectedNode, rememberWindowBlueprint, selectedNodeId, windows],
  )

  const restore = useCallback(
    (id: string) => {
      const target = windows.find((w) => w.id === id)
      if (!target) return
      rememberWindowBlueprint(target)
      setActiveWindowId(id)
      // Cascade: restore every group member. If the window is grouped, minimize
      // every non-member that is currently open (Stage Manager exclusivity).
      const groupMembers = target.groupId ? new Set(windows.filter((w) => w.groupId === target.groupId).map((w) => w.id)) : new Set([id])
      const isGrouped = target.groupId !== null
      setWindows((prev) => {
        const z = bumpZ(prev)
        return prev.map((w) => {
          if (groupMembers.has(w.id)) return { ...w, state: 'open' as WindowMode, zIndex: z }
          if (isGrouped && w.state !== 'minimized') return { ...w, state: 'minimized' as WindowMode }
          return w
        })
      })
      selectCanvasNode(target.activeNodeId, { defer: target.state === 'minimized' })
    },
    [rememberWindowBlueprint, selectCanvasNode, windows],
  )

  // Toggle grouping across currently-open windows. If all open windows share
  // one non-null groupId, dissolve their grouping. Otherwise, tag them all
  // with a fresh groupId (regrouping any that were in other groups). Single-
  // member groups are valid because they carry an explicit name and can later
  // absorb more windows without losing their identity.
  const toggleGroup = useCallback(() => {
    const open = windows.filter((w) => w.state !== 'minimized')
    if (open.length < 1) return
    const firstGroupId = open[0]?.groupId ?? null
    const allSameGroup = firstGroupId !== null && open.every((w) => w.groupId === firstGroupId)
    if (allSameGroup) {
      const openIds = new Set(open.map((w) => w.id))
      setWindows((prev) => prev.map((w) => (openIds.has(w.id) ? { ...w, groupId: null } : w)))
      return
    }
    const gid = newGroupId()
    const openIds = new Set(open.map((w) => w.id))
    const seed = [...open]
      .sort((a, b) => a.position.x - b.position.x)
      .flatMap((w) => w.tabNodeIds)
      .map((id) => sanitizeGroupName((nodesById.get(id)?.data?.label as string | undefined) ?? ''))
      .find(Boolean)
    setGroupNames((prev) => ({ ...prev, [gid]: prev[gid] ?? seed ?? defaultGroupName(gid) }))
    setWindows((prev) => prev.map((w) => (openIds.has(w.id) ? { ...w, groupId: gid } : w)))
  }, [nodesById, windows])

  const toggleMaximize = useCallback(
    (id: string) => {
      const target = windows.find((w) => w.id === id)
      if (target) rememberWindowBlueprint(target)
      setActiveWindowId(id)
      setWindows((prev) =>
        prev.map((w) => {
          if (w.id !== id) return w
          return {
            ...w,
            state: w.state === 'maximized' ? ('open' as WindowMode) : ('maximized' as WindowMode),
          }
        }),
      )
    },
    [rememberWindowBlueprint, windows],
  )

  const commitPosition = useCallback(
    (id: string, position: Point) => {
      const target = windows.find((w) => w.id === id)
      if (target) rememberWindowBlueprint({ size: target.size, position })
      setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, position } : w)))
    },
    [rememberWindowBlueprint, windows],
  )

  const commitGeometry = useCallback(
    (id: string, position: Point, size: Size) => {
      rememberWindowBlueprint({ size, position })
      setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, position, size } : w)))
    },
    [rememberWindowBlueprint],
  )

  const toggleTabLayout = useCallback((id: string) => {
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, tabLayout: w.tabLayout === 'horizontal' ? 'vertical' : 'horizontal' } : w)))
  }, [])

  const detachTab = useCallback(
    (id: string, nodeId: string) => {
      const target = windows.find((window) => window.id === id)
      const node = nodesById.get(nodeId)
      if (!target || !node || target.tabNodeIds.length <= 1) return

      // Generate detached window id outside the updater so we can set it as
      // active. Self-referential ids (see newWindowId) — never derive from
      // nodeId, or the source window (whose id used to include this nodeId)
      // collides with the detached one and React throws on duplicate keys.
      const detachedId = newWindowId()

      setWindows((prev) =>
        prev.flatMap((w) => {
          if (w.id !== id) return [w]
          const nextTabs = w.tabNodeIds.filter((tabId) => tabId !== nodeId)
          const updatedSource: WindowState = {
            ...w,
            tabNodeIds: nextTabs,
            activeNodeId: w.activeNodeId === nodeId ? (nextTabs[0] ?? w.activeNodeId) : w.activeNodeId,
          }
          const detachedWindow: WindowState = {
            id: detachedId,
            tabNodeIds: [nodeId],
            activeNodeId: nodeId,
            position: offsetPosition(w.position, w.size, containerSize, prev.length + 1),
            size: w.size,
            state: 'open',
            zIndex: bumpZ(prev),
            tabLayout: w.tabLayout,
            groupId: w.groupId,
          }
          return [updatedSource, detachedWindow]
        }),
      )

      setActiveWindowId(detachedId)
      selectCanvasNode(nodeId)
    },
    [containerSize, nodesById, selectCanvasNode, windows],
  )

  const beginAddTab = useCallback(
    (id: string) => {
      const target = windows.find((w) => w.id === id)
      if (!target) return
      if (pendingTabTargetId === id) {
        setPendingTabTargetId(null)
        return
      }
      if (selectedNodeId && !target.tabNodeIds.includes(selectedNodeId)) {
        addNodeAsTab(id, selectedNodeId)
        return
      }
      bringToFront(id)
      setPendingTabTargetId(id)
    },
    [addNodeAsTab, bringToFront, pendingTabTargetId, selectedNodeId, windows],
  )

  // Center the ReactFlow viewport on the given node without changing the
  // current zoom. Mirrors the Inspector's machine-focus semantics
  // (setCenter with a short tween) so jumping from a tab and from the
  // Inspector feels identical.
  const focusTab = useCallback(
    (nodeId: string) => {
      if (!reactFlowInstance) return
      const node = nodesById.get(nodeId)
      if (!node?.position) return
      const { zoom } = reactFlowInstance.getViewport()
      const nodeWidth = node.measured?.width ?? node.width ?? 0
      const nodeHeight = node.measured?.height ?? node.height ?? 0
      reactFlowInstance.setCenter(node.position.x + nodeWidth / 2, node.position.y + nodeHeight / 2, { duration: 500, zoom })
    },
    [nodesById, reactFlowInstance],
  )

  const minimizeAll = useCallback(() => {
    setWindows((prev) => prev.map((window) => ({ ...window, state: 'minimized' as WindowMode })))
    setActiveWindowId(null)
    clearSelectedNode()
  }, [clearSelectedNode])

  const dockLayout = useMemo(() => computeDockLayout(windows, containerSize), [windows, containerSize])
  const hasDock = dockLayout.rects.size > 0

  const GROUP_OUTLINE_PADDING = 7
  const GROUP_OUTLINE_PADDING_DOCKED = 1
  const groupOutlines = useMemo(() => {
    const byGroup = new Map<string, { rects: Rect[]; allDocked: boolean }>()
    for (const ws of windows) {
      if (!ws.groupId) continue
      const rawRect = windowRect(ws, dockLayout.rects.get(ws.id) ?? null, hasDock, containerSize)
      const rect = ws.state === 'minimized' && hoveredDockKey === dockHoverKey(ws)
        ? scaleRectFromCenter(rawRect, DOCK_HOVER_SCALE)
        : rawRect
      const entry = byGroup.get(ws.groupId) ?? { rects: [], allDocked: true }
      entry.rects.push(rect)
      if (ws.state !== 'minimized') entry.allDocked = false
      byGroup.set(ws.groupId, entry)
    }
    const out: Array<{ id: string; rect: Rect; radius: number; zIndex: number }> = []
    for (const [gid, { rects, allDocked }] of byGroup) {
      const x = Math.min(...rects.map((r) => r.x))
      const y = Math.min(...rects.map((r) => r.y))
      const right = Math.max(...rects.map((r) => r.x + r.width))
      const bottom = Math.max(...rects.map((r) => r.y + r.height))
      // When the group is fully docked, hug the thumbnails tightly — the big
      // open-state padding looks like an empty box around the dock row.
      const pad = allDocked ? GROUP_OUTLINE_PADDING_DOCKED : GROUP_OUTLINE_PADDING
      out.push({
        id: gid,
        rect: {
          x: x - pad,
          y: y - pad,
          width: right - x + pad * 2,
          height: bottom - y + pad * 2,
        },
        radius: WINDOW_RADIUS,
        // Named z layers, see ../lib/z-layers.ts.
        zIndex: allDocked ? Z.groupOutlineDock : Z.groupOutlineOpen,
      })
    }
    return out
  }, [containerSize, dockLayout, hasDock, hoveredDockKey, windows])

  // Labels above minimized SOLO windows (groups get their own label via the
  // group outline). Lets the user identify a docked thumbnail without
  // hovering. Hover-scaled in sync with the thumbnail itself.
  const soloDockLabels = useMemo(() => {
    return windows.flatMap((ws) => {
      if (ws.state !== 'minimized' || ws.groupId) return []
      const node = nodesById.get(ws.activeNodeId)
      const label = (node?.data?.label as string | undefined)?.trim()
      if (!label) return []
      const rawRect = windowRect(ws, dockLayout.rects.get(ws.id) ?? null, hasDock, containerSize)
      const rect = hoveredDockKey === dockHoverKey(ws) ? scaleRectFromCenter(rawRect, DOCK_HOVER_SCALE) : rawRect
      return [{ id: ws.id, label, rect }]
    })
  }, [containerSize, dockLayout, hasDock, hoveredDockKey, nodesById, windows])

  useImperativeHandle(ref, () => ({ toggleGroup, minimizeAll, openNode: openOrFocus }), [minimizeAll, toggleGroup, openOrFocus])

  return (
    <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {groupOutlines.map((g) => (
        <div
          key={g.id}
          className="absolute top-0 left-0 border-[1.5px] border-dashed border-slate-300"
          style={{
            transform: `translate3d(${g.rect.x}px, ${g.rect.y}px, 0)`,
            width: g.rect.width,
            height: g.rect.height,
            borderRadius: `${g.radius}px`,
            zIndex: g.zIndex,
            transition: TRANSITION,
          }}
        >
          {editingGroupId === g.id ? (
            <input
              autoFocus
              defaultValue={groupNames[g.id] ?? defaultGroupName(g.id)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => commitGroupName(g.id, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                else if (e.key === 'Escape') {
                  // Cancel: restore current name and exit edit mode without committing.
                  e.currentTarget.value = groupNames[g.id] ?? defaultGroupName(g.id)
                  setEditingGroupId(null)
                }
              }}
              className="pointer-events-auto absolute -top-3 left-1/2 w-40 -translate-x-1/2 rounded-full border border-slate-300 bg-white px-3 py-0.5 text-center text-xs font-medium text-slate-800 shadow-sm outline-none"
            />
          ) : (
            <button
              type="button"
              className="pointer-events-auto absolute -top-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-slate-300 bg-white/95 px-3 py-0.5 text-xs font-medium text-slate-800 shadow-sm backdrop-blur hover:border-slate-400"
              title="Rename group"
              onClick={() => setEditingGroupId(g.id)}
            >
              {groupNames[g.id] ?? defaultGroupName(g.id)}
            </button>
          )}
        </div>
      ))}
      {soloDockLabels.map((item) => (
        <div
          key={item.id}
          className="absolute top-0 left-0 flex items-center justify-center rounded-full border border-slate-300 bg-white/95 px-3 py-0.5 text-xs font-medium text-slate-800 shadow-sm backdrop-blur"
          style={{
            transform: `translate3d(${item.rect.x + item.rect.width / 2}px, ${Math.max(4, item.rect.y - 13)}px, 0) translateX(-50%)`,
            maxWidth: Math.max(80, Math.min(200, item.rect.width + 24)),
            zIndex: Z.windowDockLabel,
            transition: TRANSITION,
          }}
          title={item.label}
        >
          <span className="min-w-0 truncate">{item.label}</span>
        </div>
      ))}
      {windows.map((ws) => {
        const node = nodesById.get(ws.activeNodeId)
        if (!node) return null
        const tabNodes = ws.tabNodeIds.map((id) => nodesById.get(id)).filter(Boolean)
        const dockRect = dockLayout.rects.get(ws.id) ?? null
        const rect = windowRect(ws, dockRect, hasDock, containerSize)
        // Dock thumbnails stack left→right via their dock INDEX (small,
        // bounded) rather than pixel x — which used to bleed into z-space
        // and fight outline/label layers on wide screens. `ws.zIndex` is the
        // bumpZ counter for open-window ordering; both deltas must stay
        // under LAYER_RESERVED (see ../lib/z-layers.ts).
        const dockOrderIndex = dockLayout.orderIndex.get(ws.id) ?? 0
        const effectiveZIndex =
          ws.state === 'minimized' ? Z.windowDock + (dockOrderIndex % LAYER_RESERVED) : Z.windowOpen + (ws.zIndex % LAYER_RESERVED)
        const hoverKey = dockHoverKey(ws)
        const dockHoverScale = ws.state === 'minimized' && hoveredDockKey === hoverKey ? DOCK_HOVER_SCALE : 1
        return (
          <CanvasWindow
            key={ws.id}
            windowState={ws}
            rect={rect}
            dockHoverScale={dockHoverScale}
            node={node}
            tabNodes={tabNodes}
            container={containerSize}
            selected={activeWindowId === ws.id}
            collectingTabs={pendingTabTargetId === ws.id}
            effectiveZIndex={effectiveZIndex}
            onBringToFront={() => bringToFront(ws.id)}
            onDockHoverChange={(hovered) => {
              setHoveredDockKey((current) => hovered ? hoverKey : current === hoverKey ? null : current)
            }}
            onClose={() => closeActiveTabOrWindow(ws.id)}
            onCloseWindow={() => closeWindow(ws.id)}
            onMinimize={() => minimize(ws.id)}
            onMaximize={() => toggleMaximize(ws.id)}
            onRestore={() => restore(ws.id)}
            onCommitPosition={(p) => commitPosition(ws.id, p)}
            onCommitGeometry={(p, s) => commitGeometry(ws.id, p, s)}
            onBeginAddTab={() => beginAddTab(ws.id)}
            onActivateTab={(nid) => activateTab(ws.id, nid)}
            onCloseTab={(nid) => closeTab(ws.id, nid)}
            onDetachTab={(nid) => detachTab(ws.id, nid)}
            onFocusTab={(nid) => focusTab(nid)}
            onToggleTabLayout={() => toggleTabLayout(ws.id)}
          />
        )
      })}
    </div>
  )
}

// Nodes are now read internally via useCanvasStoreEq + areNodesStructurallyEqual,
// so the drag-tick filter happens at the store subscription level. The default
// shallow memo equality (===) on the remaining props is exactly right: every
// surviving prop is a stable ref between renders.
export const CanvasWindowLayer = memo(
  forwardRef<CanvasWindowLayerHandle, CanvasWindowLayerProps>(CanvasWindowLayerComponent),
)
