'use client'

/**
 * Universal "label above the node" widget. Every node type (note card,
 * machine, terminal, text…) used to render its label in a different
 * place — cards had it floating above, machines baked it into the
 * header row, terminals had it inline with a machine-name suffix.
 *
 * This component owns the single definition:
 *   - absolute-positioned above the node, on the canvas background
 *   - double-click to rename in place (Enter = save, Esc = cancel, blur = save)
 *
 * Colour rule:
 *   The label is a map label. It uses near-ink text plus a thin canvas-paper
 *   backing so it remains legible even when nodes overlap and the label sits
 *   over a machine, terminal, or answer surface.
 *
 * Typography rule (DESIGN.md §3.1 Barbell + §3.2 Hierarchy without Size):
 *   This is a workspace label, not a Hero-H1. 900/tracking-tighter crams
 *   letters so tight they fuse when the canvas is zoomed out — and
 *   legibility at distance is load-bearing for a canvas UI. So we stay
 *   on the "heavy" side of the barbell (font-bold / 700, strictly NOT
 *   500-600 which the guide calls катастрофически средний) but keep
 *   letter-spacing at 0 so glyphs breathe.
 */

import { useCallback, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '../store'

// Same magic numbers NoteCard used before the extraction. Keeping them
// here so the three node types match pixel-for-pixel; tune once, applies
// everywhere.
const LABEL_FONT_SIZE = 40
const LABEL_GAP = 60

interface NodeExternalLabelProps {
  nodeId: string
  label: string | null | undefined
  /** React Flow data.scale. Defaults to 1; every node type that has a scale
   *  (notes, machines, terminals) must pass it so the label tracks the node. */
  scale?: number
  /** If set, rendered in place of an empty label. Default: nothing. */
  placeholder?: string
}

export function NodeExternalLabel({
  nodeId,
  label,
  scale = 1,
  placeholder,
}: NodeExternalLabelProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [value, setValue] = useState(label || '')

  const save = useCallback(() => {
    useCanvasStore.getState().updateNodeLabel(nodeId, value.trim() || null)
    setIsEditing(false)
  }, [nodeId, value])

  const cancel = useCallback(() => {
    setIsEditing(false)
    setValue(label || '')
  }, [label])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        save()
      } else if (e.key === 'Escape') {
        cancel()
      }
    },
    [save, cancel],
  )

  if (!label && !isEditing && !placeholder) return null

  const fontSize = `${LABEL_FONT_SIZE * scale}px`
  const top = `${-LABEL_GAP * scale}px`

  return (
    <div
      className="absolute left-1/2 z-20"
      style={{ top, transform: 'translateX(-50%)' }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setValue(label || '')
        setIsEditing(true)
      }}
    >
      {isEditing ? (
        // inline-grid trick: measurement span shares the slot with the
        // input, so the input auto-sizes to its content without a ref
        // measurement round-trip.
        <div className="relative inline-grid rounded-[3px] bg-[#f4efe5]/95 px-2 py-0.5 shadow-[0_0_0_2px_rgba(244,239,229,0.78)] ring-1 ring-stone-900/10">
          <span
            className="invisible font-bold whitespace-pre col-start-1 row-start-1"
            style={{ fontSize }}
            aria-hidden="true"
          >
            {value || placeholder || 'Enter label...'}
          </span>
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={save}
            placeholder={placeholder || 'Enter label...'}
            className={cn(
              'font-bold bg-transparent border-none outline-none text-center',
              'col-start-1 row-start-1',
              'text-[#211a12] placeholder-stone-400',
            )}
            style={{ fontSize }}
            autoFocus
          />
        </div>
      ) : (
        <div
          className="rounded-[3px] bg-[#f4efe5]/92 px-2 py-0.5 text-center font-bold whitespace-nowrap text-[#211a12] shadow-[0_0_0_2px_rgba(244,239,229,0.78)] ring-1 ring-stone-900/10"
          style={{ fontSize }}
        >
          {label || placeholder}
        </div>
      )}
    </div>
  )
}
