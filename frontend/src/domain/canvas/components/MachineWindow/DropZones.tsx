'use client'

import React, { memo, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { CanvasDragPayload } from '../../drag/payloads'

// DropZones overlays the workstation body during a drag of either a pane
// (intra-window move) or a canvas TERMINAL node (import). Four edge zones
// represent outer-split positions; a center zone represents "add as new
// tab". The overlay only renders while a relevant drag is in progress —
// outside of drag, it's invisible and pointer-events:none so it doesn't
// interfere with regular pane interaction.
//
// We listen for `dragenter` on the document; if the dataTransfer types
// include one of our two MIME types, we light up. The overlay handles
// dragover/drop locally; outside drops fall through to the canvas.

export type DropZone = 'top' | 'right' | 'bottom' | 'left' | 'tab'

// Drop zones activate for any drag payload that targets a window — pane
// moves and canvas-terminal imports. Files are NOT in this list: they're
// handled by the canvas-level drop handler, not by the window.
const isOurZoneSource = (dt: DataTransfer): boolean => {
  const types = Array.from(dt.types)
  return (
    types.includes(CanvasDragPayload.MIME['pane']) ||
    types.includes(CanvasDragPayload.MIME['canvas-terminal'])
  )
}

type Props = {
  onDrop: (zone: DropZone, dataTransfer: DataTransfer) => void
}

const DropZonesComponent = ({ onDrop }: Props) => {
  const [active, setActive] = useState(false)
  const [hovered, setHovered] = useState<DropZone | null>(null)

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (e.dataTransfer && isOurZoneSource(e.dataTransfer)) setActive(true)
    }
    const onDragEnd = () => {
      setActive(false)
      setHovered(null)
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragend', onDragEnd)
    document.addEventListener('drop', onDragEnd)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragend', onDragEnd)
      document.removeEventListener('drop', onDragEnd)
    }
  }, [])

  if (!active) return null

  const handleZoneDrop = (zone: DropZone) => (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setActive(false)
    setHovered(null)
    onDrop(zone, e.dataTransfer)
  }

  const allow = (zone: DropZone) => (e: React.DragEvent) => {
    if (isOurZoneSource(e.dataTransfer)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (hovered !== zone) setHovered(zone)
    }
  }

  // Edge thickness as percentage of the body. Big enough to hit easily,
  // small enough that the user can still drop on a pane's interior if they
  // want focused-split behavior (which we don't expose in V1, but leaving
  // pane interior as a non-zone is the simplest way to keep it open).
  const edgeBase =
    'absolute z-30 flex items-center justify-center text-xs font-medium uppercase tracking-wider'
  const edgeIdle = 'border-2 border-dashed border-sky-400/40 bg-sky-100/10 text-sky-700/0'
  const edgeHover = 'border-2 border-sky-500 bg-sky-100/40 text-sky-800'

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <div
        onDragOver={allow('top')}
        onDragLeave={() => setHovered(h => (h === 'top' ? null : h))}
        onDrop={handleZoneDrop('top')}
        className={cn(
          edgeBase,
          'left-[20%] right-[20%] top-0 h-[20%] pointer-events-auto rounded-b-lg',
          hovered === 'top' ? edgeHover : edgeIdle,
        )}
      >
        Top
      </div>
      <div
        onDragOver={allow('right')}
        onDragLeave={() => setHovered(h => (h === 'right' ? null : h))}
        onDrop={handleZoneDrop('right')}
        className={cn(
          edgeBase,
          'top-[20%] bottom-[20%] right-0 w-[20%] pointer-events-auto rounded-l-lg',
          hovered === 'right' ? edgeHover : edgeIdle,
        )}
      >
        Right
      </div>
      <div
        onDragOver={allow('bottom')}
        onDragLeave={() => setHovered(h => (h === 'bottom' ? null : h))}
        onDrop={handleZoneDrop('bottom')}
        className={cn(
          edgeBase,
          'left-[20%] right-[20%] bottom-0 h-[20%] pointer-events-auto rounded-t-lg',
          hovered === 'bottom' ? edgeHover : edgeIdle,
        )}
      >
        Bottom
      </div>
      <div
        onDragOver={allow('left')}
        onDragLeave={() => setHovered(h => (h === 'left' ? null : h))}
        onDrop={handleZoneDrop('left')}
        className={cn(
          edgeBase,
          'top-[20%] bottom-[20%] left-0 w-[20%] pointer-events-auto rounded-r-lg',
          hovered === 'left' ? edgeHover : edgeIdle,
        )}
      >
        Left
      </div>
      <div
        onDragOver={allow('tab')}
        onDragLeave={() => setHovered(h => (h === 'tab' ? null : h))}
        onDrop={handleZoneDrop('tab')}
        className={cn(
          edgeBase,
          'top-[28%] bottom-[28%] left-[28%] right-[28%] pointer-events-auto rounded-lg',
          hovered === 'tab' ? edgeHover : edgeIdle,
        )}
      >
        New tab
      </div>
    </div>
  )
}

export const DropZones = memo(DropZonesComponent)
