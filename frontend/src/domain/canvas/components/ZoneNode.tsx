'use client'

import { memo } from 'react'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import { CanvasNode } from '../types'
import { ShapeLockToggle } from './ShapeLockToggle'

const DEFAULT_COLOR = '#64748b' // slate-500 — neutral, reads as "organizational"

// A ZONE: a resizable rectangle used to group/organize the canvas. It sits
// behind content nodes (zIndex handled in Canvas), so other nodes float on top.
// Border in the zone color, a faint same-hue fill (color-mix works for any CSS
// color), and an optional label pinned top-left. NodeResizer (built into
// @xyflow/react) gives the drag-handles when selected.
function ZoneNodeComponent({ id, data, selected }: NodeProps) {
  const d = data as CanvasNode.ZoneData
  const color = d.color || DEFAULT_COLOR
  const locked = CanvasNode.isLocked(d)

  return (
    <>
      {/* Locked zones can't be resized — hide the drag-handles. */}
      <NodeResizer color={color} isVisible={!!selected && !locked} minWidth={60} minHeight={40} />
      <div
        className="relative h-full w-full rounded-lg border-2"
        style={{
          borderColor: color,
          backgroundColor: `color-mix(in srgb, ${color} 9%, transparent)`,
        }}
      >
        <ShapeLockToggle nodeId={id} locked={locked} visible={!!selected || locked} color={color} />
        {d.label && (
          <span
            className="pointer-events-none absolute left-2 top-1 select-none text-[11px] font-semibold uppercase tracking-wide"
            style={{ color }}
          >
            {d.label}
          </span>
        )}
      </div>
    </>
  )
}

// Same memo discipline as every other node type (cf. areTextNodePropsEqual):
// React Flow hands a fresh props object on many ticks, so compare only the
// fields that actually affect render. width/height matter here because
// NodeResizer mutates them.
const areZoneNodePropsEqual = (prev: NodeProps, next: NodeProps) =>
  prev.selected === next.selected &&
  prev.dragging === next.dragging &&
  prev.data === next.data &&
  prev.width === next.width &&
  prev.height === next.height

export const ZoneNode = memo(ZoneNodeComponent, areZoneNodePropsEqual)
