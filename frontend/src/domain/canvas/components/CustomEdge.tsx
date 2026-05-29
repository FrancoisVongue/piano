'use client'

import { BaseEdge, EdgeLabelRenderer, EdgeProps, getBezierPath, useReactFlow, Position } from '@xyflow/react'
import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Canvas } from '@piano/shared'
import { useCanvasStore } from '../store'

/**
 * Custom edge that connects to the center of node borders regardless of scale,
 * and surfaces a delete affordance on hover so users never have to pixel-hunt
 * a thin line and press Backspace. The hitbox is a transparent wide stroke
 * sitting on top of the visible stroke: same Bezier path, but 24px wide, so
 * hovering the general region — not the 2px line — reveals the X button at
 * the midpoint.
 */
export function CustomEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
}: EdgeProps) {
  const { getNode } = useReactFlow()
  const onEdgesChange = useCanvasStore(s => s.onEdgesChange)
  // Single-click node selection sets `selectedNodeId` in the store but does
  // NOT mark incident edges as RF-selected. Subscribe to the derived boolean,
  // not the raw id: changing focus from node A to B should only re-render
  // edges incident to A or B, not every edge on a large canvas.
  const incidentToSelectedNode = useCanvasStore(s => s.selectedNodeId === source || s.selectedNodeId === target)
  // Two independent hover sources, OR'd together. A single shared
  // `hovered` would flicker when the mouse moves from the line to the
  // button: hitbox's onMouseLeave would fire before button's onMouseEnter,
  // briefly setting `hovered=false` and hiding the button mid-transit.
  // With separate flags each handler owns exactly one boolean and they
  // never fight.
  const [lineHovered, setLineHovered] = useState(false)
  const [buttonHovered, setButtonHovered] = useState(false)

  const { correctedSourceX, correctedSourceY, correctedTargetX, correctedTargetY, minScale } = useMemo(() => {
    const sourceNode = getNode(source)
    const targetNode = getNode(target)

    let correctedSourceX = sourceX
    let correctedSourceY = sourceY
    let correctedTargetX = targetX
    let correctedTargetY = targetY

    const sourceScale = (sourceNode?.data?.scale as number | undefined) ?? 1
    const targetScale = (targetNode?.data?.scale as number | undefined) ?? 1

    if (sourceNode && sourceScale !== 1.0) {
      const nodeWidth = Canvas.NODE_DIMENSIONS.WIDTH
      const nodeHeight = Canvas.NODE_DIMENSIONS.HEIGHT
      correctedSourceX = sourceNode.position.x + (nodeWidth * sourceScale) / 2
      correctedSourceY = sourceNode.position.y + nodeHeight * sourceScale
    }

    if (targetNode && targetScale !== 1.0) {
      const nodeWidth = Canvas.NODE_DIMENSIONS.WIDTH
      correctedTargetX = targetNode.position.x + (nodeWidth * targetScale) / 2
      correctedTargetY = targetNode.position.y
    }

    return {
      correctedSourceX,
      correctedSourceY,
      correctedTargetX,
      correctedTargetY,
      minScale: Math.min(sourceScale, targetScale),
    }
  }, [source, target, sourceX, sourceY, targetX, targetY, getNode])

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: correctedSourceX,
    sourceY: correctedSourceY,
    sourcePosition: Position.Bottom,
    targetX: correctedTargetX,
    targetY: correctedTargetY,
    targetPosition: Position.Top,
  })

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    onEdgesChange([{ id, type: 'remove' }])
  }

  const showAffordance = lineHovered || buttonHovered || selected || incidentToSelectedNode
  // Stroke scales with the smaller of the two endpoints — keeps the line
  // visually proportional to the node it's anchored to. DESIGN.md picks
  // #0a0a0a as the near-black for solid surfaces; red is reserved for the
  // delete affordance (hover / selected = "you're about to remove this").
  const strokeColor = showAffordance ? '#ef4444' : '#0a0a0a'
  const strokeWidth = (showAffordance ? 3 : 2) * minScale

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth,
          transition: 'stroke 120ms ease, stroke-width 120ms ease',
        }}
      />
      {/* Wide invisible hitbox so the "clickable region" is ~48px, not 2px. */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={48}
        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
        onMouseEnter={() => setLineHovered(true)}
        onMouseLeave={() => setLineHovered(false)}
      />
      {showAffordance && (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={handleDelete}
            onMouseEnter={() => setButtonHovered(true)}
            onMouseLeave={() => setButtonHovered(false)}
            aria-label="Delete edge"
            className="nodrag nopan flex h-6 w-6 items-center justify-center rounded-full bg-white text-red-500 shadow-md ring-1 ring-red-200 transition-colors hover:bg-red-500 hover:text-white"
            style={{
              position: 'absolute',
              // Order matters: scale runs first (innermost), so the button is
              // sized by minScale, then translated to the label point. Default
              // transform-origin (center) keeps the button centred on (labelX,
              // labelY) regardless of scale. translate(-50%,-50%) uses the
              // element's pre-scale size, which is exactly what we want — the
              // button visually shrinks/grows but stays anchored to the line.
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${minScale})`,
              pointerEvents: 'all',
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
