'use client'

import { ConnectionLineComponentProps, getBezierPath, Position } from '@xyflow/react'
import { Canvas } from '@piano/shared'

/**
 * Live connection-line preview shown while dragging a new edge.
 *
 * Why this exists: React Flow's default ConnectionLine starts at the handle
 * position it computed internally, which for scaled nodes can be off (the
 * default math assumes the node is at its declared base dimensions, not
 * dimensions × scale). The result is the line "missing" the handle until
 * the connection lands and CustomEdge runs its own correction.
 *
 * This mirrors that correction (CustomEdge.tsx) so the preview line and
 * the final edge both anchor at the same spot — the visual centre of the
 * scaled handle. Without scale correction (scale === 1), RF's defaults are
 * already correct and we leave fromX/fromY untouched.
 */
export function ConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromNode,
  fromPosition,
  toNode,
  toPosition,
}: ConnectionLineComponentProps) {
  const W = Canvas.NODE_DIMENSIONS.WIDTH
  const H = Canvas.NODE_DIMENSIONS.HEIGHT

  // Source-side correction. RF's fromX/fromY come from cached handleBounds
  // that don't always reflect a scaled node's true handle position.
  let sourceX = fromX
  let sourceY = fromY
  const fromScale = (fromNode?.data?.scale as number | undefined) ?? 1
  if (fromNode && fromScale !== 1) {
    sourceX = fromNode.position.x + (W * fromScale) / 2
    sourceY = fromPosition === Position.Top
      ? fromNode.position.y
      : fromNode.position.y + H * fromScale
  }

  // Target-side correction. Only kicks in when RF has snapped the drag to
  // a candidate target node (toNode set). For a free pointer (toNode null)
  // we trust toX/toY verbatim — that's the cursor in flow coords.
  let targetX = toX
  let targetY = toY
  const toScale = (toNode?.data?.scale as number | undefined) ?? 1
  if (toNode && toScale !== 1) {
    targetX = toNode.position.x + (W * toScale) / 2
    targetY = toPosition === Position.Top
      ? toNode.position.y
      : toNode.position.y + H * toScale
  }

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: fromPosition ?? Position.Bottom,
    targetX,
    targetY,
    targetPosition: toPosition ?? (fromPosition === Position.Top ? Position.Bottom : Position.Top),
  })

  // Match the committed CustomEdge: stroke scales with min(fromScale, toScale).
  // When dragging into empty space (no toNode), fall back to source scale so
  // the line doesn't visually "snap" thicker as the cursor leaves a target.
  const minScale = Math.min(fromScale, toNode ? toScale : fromScale)

  return (
    <g>
      <path
        d={edgePath}
        fill="none"
        stroke="#0a0a0a"
        strokeWidth={2 * minScale}
        style={{ pointerEvents: 'none' }}
      />
    </g>
  )
}
