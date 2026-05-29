'use client'

import { memo, useMemo } from 'react'
import { type NodeProps } from '@xyflow/react'
import getStroke from 'perfect-freehand'
import type { Note } from '@piano/shared'
import { CanvasNode } from '../types'
import { ShapeLockToggle } from './ShapeLockToggle'

const DEFAULT_COLOR = '#0f172a' // slate-900

// Standard perfect-freehand → SVG path: getStroke returns the OUTLINE of the
// stroke (a filled polygon), which we render as a smooth filled <path>.
const strokeToPath = (stroke: number[][]): string => {
  if (!stroke.length) return ''
  const d = stroke.reduce<(number | string)[]>((acc, [x0, y0], i, arr) => {
    const [x1, y1] = arr[(i + 1) % arr.length]
    acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
    return acc
  }, ['M', ...stroke[0], 'Q'])
  d.push('Z')
  return d.join(' ')
}

// A DRAWING node: renders its stroke (freehand or straight line) as SVG inside
// the node's bounding box. Points are node-local (relative to the box), so the
// path is correct wherever the node is dragged. The SVG itself is click-through
// (pointerEvents:none) — only the painted path is selectable, so the empty
// corners of the bounding box don't block clicks to nodes underneath.
function DrawingNodeComponent({ id, data, width, height, selected }: NodeProps) {
  const d = data as CanvasNode.DrawingData
  const style = (d.style ?? null) as (Note.DrawingStyle & { locked?: boolean }) | null
  const color = d.color || DEFAULT_COLOR
  const locked = CanvasNode.isLocked(d)
  const w = (width as number) || d.width || 1
  const h = (height as number) || d.height || 1

  const rendered = useMemo(() => {
    const pts = style?.points
    if (!pts || pts.length === 0) return null
    if (style!.tool === 'line') {
      const a = pts[0]
      const b = pts[pts.length - 1]
      if (!a || !b) return null
      return { kind: 'line' as const, path: `M ${a[0]} ${a[1]} L ${b[0]} ${b[1]}` }
    }
    const outline = getStroke(pts, {
      size: style!.strokeWidth ?? 5,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.5,
    })
    return { kind: 'freehand' as const, path: strokeToPath(outline) }
  }, [style])

  if (!rendered) return null

  // Wrapper is click-through (only the painted path is selectable); the lock
  // button re-enables pointer events on itself so a locked stroke can be
  // unlocked even though the surrounding box ignores clicks.
  return (
    <div style={{ position: 'relative', width: w, height: h, pointerEvents: 'none' }}>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        style={{ overflow: 'visible', pointerEvents: 'none' }}
      >
        {rendered.kind === 'freehand' ? (
          <path d={rendered.path} fill={color} style={{ pointerEvents: 'all' }} />
        ) : (
          <path
            d={rendered.path}
            fill="none"
            stroke={color}
            strokeWidth={style?.strokeWidth ?? 3}
            strokeLinecap="round"
            style={{ pointerEvents: 'stroke' }}
          />
        )}
      </svg>
      <ShapeLockToggle nodeId={id} locked={locked} visible={!!selected || locked} color={color} />
    </div>
  )
}

// Same memo discipline as every other node type (cf. areTextNodePropsEqual).
// width/height are included because the stroke is rendered into that box.
const areDrawingNodePropsEqual = (prev: NodeProps, next: NodeProps) =>
  prev.selected === next.selected &&
  prev.dragging === next.dragging &&
  prev.data === next.data &&
  prev.width === next.width &&
  prev.height === next.height

export const DrawingNode = memo(DrawingNodeComponent, areDrawingNodePropsEqual)
