'use client'

import React, { memo, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Canvas } from '@piano/shared'
import { CanvasNode } from '../types'
import { NodeExternalLabel } from './NodeExternalLabel'
import { NodeHandles } from './NodeHandles'
import { registerLodNode } from '../lib/lod'

/**
 * Shared outer shell for all infra node types (Machine, Terminal, future kinds).
 *
 * LOD is CSS-only here — both full-detail children and the low-detail icon
 * are always in the DOM tree, and a single `[data-low-detail]` attribute
 * decides which one the browser paints. No per-node React subscription,
 * no re-render on zoom-bucket flip.
 *
 * `registerLodNode` gives the canvas-level updater the element + scale so
 * zoom changes can update only nodes that cross the LOD threshold instead
 * of querying and touching every node every frame.
 */

interface NodeShellProps {
  nodeData: CanvasNode.UI
  selected: boolean
  rounded?: string
  lowDetailIcon: React.ReactNode
  children: React.ReactNode
}

const NodeShellComponent = ({
  nodeData,
  selected,
  rounded = 'rounded-sm',
  lowDetailIcon,
  children,
}: NodeShellProps) => {
  const scale = (nodeData.scale as number) || 1
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    return registerLodNode(el, scale)
  }, [scale])

  return (
    <div
      ref={rootRef}
      className="relative"
      data-piano-node
      data-node-scale={scale}
    >
      <NodeExternalLabel nodeId={nodeData.id} label={nodeData.label} scale={scale} />
      {/* Outer wrapper: layout-sized to scaled dimensions so React Flow's
          ResizeObserver sees the same size that the store wrote into
          node.width/height. */}
      <div
        className="relative"
        style={{ width: Canvas.NODE_DIMENSIONS.WIDTH * scale, height: Canvas.NODE_DIMENSIONS.HEIGHT * scale }}
      >
        {/* Inner: rendered at base dimensions, then visually scaled via
            transform. Layout, gaps, icons compute at scale=1 → no sub-pixel
            rounding artifacts at small scales (the bug `zoom: scale` had).
            transform-origin top-left aligns the visual with React Flow's
            node-position coordinates. NodeHandles live here so they scale
            visually with the card. */}
        <div
          className={cn(
            'piano-node-frame absolute top-0 left-0',
            rounded,
            selected ? 'border-[3px] border-emerald-500' : 'border border-stone-700',
          )}
          style={{
            width: Canvas.NODE_DIMENSIONS.WIDTH,
            height: Canvas.NODE_DIMENSIONS.HEIGHT,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          {/* Both layers always mounted. CSS in globals.css picks one
              based on the closest [data-piano-node] ancestor's
              [data-low-detail] attribute. Switching is a single attribute
              toggle by the canvas updater — no React work. */}
          <div className="piano-node-full absolute inset-0">{children}</div>
          <div className="piano-node-low absolute inset-0 flex items-center justify-center bg-[#e8ecea]">
            {lowDetailIcon}
          </div>
          <NodeHandles />
        </div>
      </div>
    </div>
  )
}

export const NodeShell = memo(NodeShellComponent)
