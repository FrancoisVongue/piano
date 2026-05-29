'use client'

import { useEffect, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import getStroke from 'perfect-freehand'
import { useCanvasStore } from '../store'

// Full-pane overlay that turns pointer gestures into ZONE / DRAWING nodes while
// a draw tool is active. It captures all pointer events (so React Flow doesn't
// pan/select underneath), previews the shape live in screen space, and commits
// it in flow coordinates on pointer-up. In 'select' mode it renders nothing,
// so the canvas behaves exactly as before.

type Pt = { x: number; y: number }

const PEN_SIZE = 6
const LINE_WIDTH = 3
const STROKE_COLOR = '#0f172a'
const ZONE_COLOR = '#64748b'

// Standard perfect-freehand outline → smooth filled SVG path.
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

const bbox = (pts: Pt[]) => {
  const xs = pts.map(p => p.x)
  const ys = pts.map(p => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(Math.max(...xs) - x, 1), height: Math.max(Math.max(...ys) - y, 1) }
}
const toLocal = (pts: Pt[], origin: Pt): Array<[number, number]> =>
  pts.map(p => [p.x - origin.x, p.y - origin.y])
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

export function DrawingLayer() {
  const tool = useCanvasStore(s => s.activeTool)
  const setActiveTool = useCanvasStore(s => s.setActiveTool)
  const createZone = useCanvasStore(s => s.createZone)
  const createDrawing = useCanvasStore(s => s.createDrawing)
  const { screenToFlowPosition } = useReactFlow()

  const overlayRef = useRef<HTMLDivElement>(null)
  const drawing = useRef(false)
  const [pts, setPts] = useState<Pt[]>([]) // client coords during a gesture

  // Esc always returns to select.
  useEffect(() => {
    if (tool === 'select') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveTool('select')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, setActiveTool])

  if (tool === 'select') return null

  const commit = (clientPts: Pt[]) => {
    if (clientPts.length === 0) return
    const flow = clientPts.map(p => screenToFlowPosition(p))
    const first = flow[0]
    const last = flow[flow.length - 1]

    if (tool === 'zone') {
      const box = bbox([first, last])
      if (box.width < 8 && box.height < 8) return // ignore a stray click
      createZone(box)
      setActiveTool('select') // one-shot: select it to resize/label
      return
    }
    if (tool === 'line') {
      if (dist(first, last) < 4) return
      const box = bbox([first, last])
      createDrawing(box, { tool: 'line', points: toLocal([first, last], box), strokeWidth: LINE_WIDTH })
      return
    }
    // pen (freehand)
    if (flow.length < 2) return
    const box = bbox(flow)
    createDrawing(box, { tool: 'freehand', points: toLocal(flow, box), strokeWidth: PEN_SIZE })
  }

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    drawing.current = true
    overlayRef.current?.setPointerCapture(e.pointerId)
    setPts([{ x: e.clientX, y: e.clientY }])
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current) return
    const p = { x: e.clientX, y: e.clientY }
    // zone/line need only the start + current corner; pen accumulates.
    setPts(prev => (tool === 'pen' ? [...prev, p] : [prev[0] ?? p, p]))
  }
  const onUp = (e: React.PointerEvent) => {
    if (!drawing.current) return
    drawing.current = false
    overlayRef.current?.releasePointerCapture?.(e.pointerId)
    commit(pts)
    setPts([])
  }

  // Live preview in overlay-local coords.
  const rect = overlayRef.current?.getBoundingClientRect()
  const local: Pt[] = rect ? pts.map(p => ({ x: p.x - rect.left, y: p.y - rect.top })) : []
  const zoneBox = tool === 'zone' && local.length >= 2 ? bbox(local) : null

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0"
      style={{ zIndex: 9999, cursor: 'crosshair', touchAction: 'none' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    >
      {local.length > 0 && (
        <svg className="pointer-events-none h-full w-full" style={{ overflow: 'visible' }}>
          {zoneBox && (
            <rect
              x={zoneBox.x}
              y={zoneBox.y}
              width={zoneBox.width}
              height={zoneBox.height}
              rx={8}
              fill={`color-mix(in srgb, ${ZONE_COLOR} 9%, transparent)`}
              stroke={ZONE_COLOR}
              strokeWidth={2}
              strokeDasharray="6 4"
            />
          )}
          {tool === 'line' && local.length >= 2 && (
            <line
              x1={local[0].x}
              y1={local[0].y}
              x2={local[local.length - 1].x}
              y2={local[local.length - 1].y}
              stroke={STROKE_COLOR}
              strokeWidth={LINE_WIDTH}
              strokeLinecap="round"
            />
          )}
          {tool === 'pen' && local.length >= 2 && (
            <path
              d={strokeToPath(getStroke(local.map(p => [p.x, p.y]), { size: PEN_SIZE, thinning: 0.6, smoothing: 0.5, streamline: 0.5 }))}
              fill={STROKE_COLOR}
            />
          )}
        </svg>
      )}
    </div>
  )
}
