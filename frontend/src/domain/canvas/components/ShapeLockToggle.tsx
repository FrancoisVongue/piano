'use client'

import { memo } from 'react'
import { Lock, Unlock } from 'lucide-react'
import { useCanvasStore } from '../store'

// Lock/unlock affordance for shape nodes (ZONE / DRAWING). Rendered by the node
// itself, pinned to the box's top-right corner. Visible while the shape is
// selected (so you can lock it) and stays visible while locked (so a locked
// shape advertises why it won't move — click to unlock). `nodrag`/`nopan` keep
// the click from starting a canvas drag/pan; stopPropagation keeps it from
// bubbling to node selection handlers.
function ShapeLockToggleComponent({
  nodeId,
  locked,
  visible,
  color,
}: {
  nodeId: string
  locked: boolean
  visible: boolean
  color?: string | null
}) {
  // Invariant #6 (canvas-performance-invariants.md): this badge is mounted once
  // per shape node, so it must NOT hold a store subscription just to get an
  // action — read it lazily via getState() inside the handler instead.
  if (!visible) return null

  const Icon = locked ? Lock : Unlock
  return (
    <button
      type="button"
      className="nodrag nopan absolute -right-2 -top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full border bg-white shadow-sm transition-colors hover:bg-gray-50"
      style={{
        borderColor: color || '#cbd5e1',
        pointerEvents: 'all',
        // The button lives in flow coords, so it shrinks with the canvas. A
        // zone can be huge and viewed from far out — counter-scale by 1/zoom
        // (via the inherited --canvas-zoom var) to hold a constant on-screen
        // size. Center origin keeps it pinned near the corner at any zoom.
        transform: 'scale(calc(1 / var(--canvas-zoom, 1)))',
        transformOrigin: 'center',
      }}
      title={locked ? 'Unlock — allow moving' : 'Lock position'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        useCanvasStore.getState().toggleNodeLocked(nodeId)
      }}
    >
      <Icon className="h-4 w-4" style={{ color: locked ? color || '#0f172a' : '#64748b' }} />
    </button>
  )
}

export const ShapeLockToggle = memo(ShapeLockToggleComponent)
