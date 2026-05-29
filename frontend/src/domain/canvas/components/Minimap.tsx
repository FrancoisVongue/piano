'use client'

/**
 * Canvas-based minimap.
 *
 * Repaint trigger: a 60Hz RAF loop reads React Flow's TRANSIENT viewport
 * (reactFlow.getViewport()) and repaints only when it changed since last
 * frame. Bypasses our own ZoomTracker debounce+idle path so the indicator
 * follows the cursor in lockstep instead of lagging 150ms+ behind. Idle
 * cost is one cheap object read per frame.
 *
 * Why React Flow's transient viewport instead of any of our own state:
 * single source of truth. React Flow already tracks the canvas viewport
 * frame-by-frame; mirroring it elsewhere just creates synchronisation
 * problems (and historically did — see git history for the debounce +
 * idle gymnastics that lived here).
 *
 * Interaction: pointerdown anywhere on the map sets the canvas viewport
 * centered on that world point. Dragging keeps re-centering — so the
 * cursor effectively *is* the viewport center while held. Click = drag
 * of length zero. One semantic for click and drag.
 */

import { useEffect, useRef } from 'react'
import { useReactFlow, type Node as RfNode } from '@xyflow/react'
import { Canvas as CanvasConst } from '@piano/shared'
import { useCanvasStore } from '../store'

const MAP_W = 200
const MAP_H = 150
const PADDING_WORLD = 200   // breathing room around node bbox so the user can pan past nodes
const MIN_WORLD = 800       // floor for the projected world size (single-node bbox is degenerate)

type Projection = { scale: number; originX: number; originY: number }

// Pure: derive a fit-to-map projection from current nodes. Returns null when
// the canvas has no nodes yet — caller hides the minimap in that case.
function projectionFor(nodes: RfNode[]): Projection | null {
  if (nodes.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) {
    const w = n.width ?? CanvasConst.NODE_DIMENSIONS.WIDTH
    const h = n.height ?? CanvasConst.NODE_DIMENSIONS.HEIGHT
    if (n.position.x < minX) minX = n.position.x
    if (n.position.y < minY) minY = n.position.y
    if (n.position.x + w > maxX) maxX = n.position.x + w
    if (n.position.y + h > maxY) maxY = n.position.y + h
  }
  const worldW = Math.max(maxX - minX + 2 * PADDING_WORLD, MIN_WORLD)
  const worldH = Math.max(maxY - minY + 2 * PADDING_WORLD, MIN_WORLD)
  const scale = Math.min(MAP_W / worldW, MAP_H / worldH)
  return { scale, originX: minX - PADDING_WORLD, originY: minY - PADDING_WORLD }
}

// Pure: paint one frame. Background → nodes → viewport indicator on top.
function paint(
  ctx: CanvasRenderingContext2D,
  projection: Projection,
  nodes: RfNode[],
  viewport: { x: number; y: number; width: number; height: number },
) {
  ctx.clearRect(0, 0, MAP_W, MAP_H)
  ctx.fillStyle = 'rgba(15, 15, 20, 0.85)'
  ctx.fillRect(0, 0, MAP_W, MAP_H)

  ctx.fillStyle = 'rgba(180, 190, 220, 0.85)'
  for (const n of nodes) {
    const w = n.width ?? CanvasConst.NODE_DIMENSIONS.WIDTH
    const h = n.height ?? CanvasConst.NODE_DIMENSIONS.HEIGHT
    const px = (n.position.x - projection.originX) * projection.scale
    const py = (n.position.y - projection.originY) * projection.scale
    // Tiny rects vanish into a single pixel and stop being readable; floor
    // to 2×2 so a swarm of small nodes still looks like a swarm.
    const pw = Math.max(2, w * projection.scale)
    const ph = Math.max(2, h * projection.scale)
    ctx.fillRect(px, py, pw, ph)
  }

  const vx = (viewport.x - projection.originX) * projection.scale
  const vy = (viewport.y - projection.originY) * projection.scale
  const vw = viewport.width * projection.scale
  const vh = viewport.height * projection.scale
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  ctx.lineWidth = 1.5
  ctx.fillRect(vx, vy, vw, vh)
  ctx.strokeRect(vx, vy, vw, vh)
}

export function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const projectionRef = useRef<Projection | null>(null)
  const reactFlow = useReactFlow()

  // Boolean-only selector. Re-renders the component on the 0↔1+ transition
  // (first node created, last one removed) and nothing else. Crucially we
  // do NOT subscribe to the nodes array itself — that would re-render on
  // every drag tick when positions update.
  const hasNodes = useCanvasStore(s => s.nodes.length > 0)

  // DPI setup runs once on mount.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = MAP_W * dpr
    canvas.height = MAP_H * dpr
    const ctx = canvas.getContext('2d')
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  }, [hasNodes])

  // RAF loop reads BOTH transient viewport (React Flow) and current nodes
  // (Zustand getState — no subscription). Reference comparison decides
  // whether to recompute projection. Repaint runs when either changed.
  // Zero React renders during drag/pan — the component is essentially
  // static between empty/non-empty transitions.
  useEffect(() => {
    if (!hasNodes) return

    let lastNodesRef: unknown = null
    let lastViewportKey = ''
    let frame = 0

    const tick = () => {
      const state = useCanvasStore.getState()
      const v = reactFlow.getViewport()
      const viewportKey = `${v.x}|${v.y}|${v.zoom}`
      const nodesChanged = state.nodes !== lastNodesRef
      const viewportChanged = viewportKey !== lastViewportKey

      if (nodesChanged || viewportChanged) {
        if (nodesChanged) {
          projectionRef.current = projectionFor(state.nodes)
          lastNodesRef = state.nodes
        }
        lastViewportKey = viewportKey

        const ctx = canvasRef.current?.getContext('2d')
        const projection = projectionRef.current
        if (ctx && projection) {
          // React Flow's transform is in screen pixels at zoom=1; we want
          // the world-coord rectangle of what's currently visible.
          paint(ctx, projection, state.nodes, {
            x: -v.x / v.zoom,
            y: -v.y / v.zoom,
            width: window.innerWidth / v.zoom,
            height: window.innerHeight / v.zoom,
          })
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(frame)
  }, [hasNodes, reactFlow])

  // Pointer event → world coord → setCenter. Same handler used for click
  // (mousedown without movement) and drag (continuous mousemove). React
  // Flow's onViewportChange then re-paints the indicator via the subscriber
  // above — round-trip is honest, no separate "predicted" indicator state.
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const projection = projectionRef.current
    const canvas = canvasRef.current
    if (!projection || !canvas) return

    const recenter = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      const worldX = projection.originX + (clientX - rect.left) / projection.scale
      const worldY = projection.originY + (clientY - rect.top) / projection.scale
      reactFlow.setCenter(worldX, worldY, { duration: 0, zoom: reactFlow.getViewport().zoom })
    }

    recenter(e.clientX, e.clientY)

    const onMove = (m: PointerEvent) => recenter(m.clientX, m.clientY)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (!hasNodes) return null

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      className="absolute bottom-4 right-4 cursor-crosshair rounded-lg border border-white/10 shadow-lg"
      style={{ width: MAP_W, height: MAP_H, zIndex: 10 }}
    />
  )
}
