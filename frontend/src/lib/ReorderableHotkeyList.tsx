'use client'

import React, { useCallback, useState } from 'react'
import { Eye, EyeOff, GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The drag-to-reorder + visibility-toggle list pattern shared by
 * ModelSelector and ActionConfigButton (and any future "user-pinned list").
 *
 * The first N visible items get a colored letter chip — the consumer
 * passes the labels (e.g. ['q','w','e','r']) and a separate hotkey hook
 * binds Alt+letter to those positions. The list itself doesn't bind keys;
 * it just renders the affordance so users see what's bound where.
 *
 * Consumers only own:
 *   - what each row LOOKS like inside (renderItemBody)
 *   - whether row click selects something (onItemClick + isItemActive)
 *   - the data slicing (visibleItems / hiddenItems / labels)
 * Everything else — drag wiring, eye toggles, chip rendering, layout —
 * lives here once.
 */

interface Item {
  id: string
}

export interface ReorderableHotkeyListProps<T extends Item> {
  visibleItems: T[]
  hiddenItems: T[]
  /** Letter labels for the top N rows. Top-`labels.length` items render with a chip. */
  hotkeyLabels: readonly string[]
  /** Called with the new visible-id ordering after a drag-drop. */
  onReorder: (visibleIds: string[]) => void
  /** Called when user clicks the eye toggle (visible rows) OR a hidden row. */
  onToggleVisibility: (id: string) => void
  /** Optional: row body click selects the item (e.g. ModelSelector → setSelectedModel). */
  onItemClick?: (item: T) => void
  /** Optional: highlight the row whose item is "active" (currently selected). */
  isItemActive?: (item: T) => boolean
  /** Render the body content of a visible row — between the hotkey chip and the eye. */
  renderItemBody: (item: T) => React.ReactNode
  /**
   * Optional: render hidden rows differently (e.g. greyed-out icon). Falls back
   * to renderItemBody — most consumers won't need to override.
   */
  renderHiddenItemBody?: (item: T) => React.ReactNode
  /** Used for a11y title on the eye toggle ("Hide model" vs "Hide action"). */
  hideTooltip?: string
}

export function ReorderableHotkeyList<T extends Item>({
  visibleItems,
  hiddenItems,
  hotkeyLabels,
  onReorder,
  onToggleVisibility,
  onItemClick,
  isItemActive,
  renderItemBody,
  renderHiddenItemBody,
  hideTooltip = 'Hide',
}: ReorderableHotkeyListProps<T>) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)

  const visibleIds = visibleItems.map(item => item.id)

  const onDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggedId(id)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const onDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverIdx(idx)
  }, [])

  const onDrop = useCallback((e: React.DragEvent, targetIdx: number) => {
    e.preventDefault()
    setDraggedId(null)
    setOverIdx(null)
    if (!draggedId) return
    const next = [...visibleIds]
    const fromIdx = next.indexOf(draggedId)
    if (fromIdx < 0 || fromIdx === targetIdx) return
    next.splice(fromIdx, 1)
    next.splice(targetIdx, 0, draggedId)
    onReorder(next)
  }, [draggedId, visibleIds, onReorder])

  const onDragEnd = useCallback(() => {
    setDraggedId(null)
    setOverIdx(null)
  }, [])

  return (
    <>
      <div className="p-1">
        {visibleItems.map((item, idx) => {
          const active = isItemActive?.(item)
          const label = idx < hotkeyLabels.length ? hotkeyLabels[idx] : null
          return (
            <div
              key={item.id}
              draggable
              onDragStart={(e) => onDragStart(e, item.id)}
              onDragOver={(e) => onDragOver(e, idx)}
              onDrop={(e) => onDrop(e, idx)}
              onDragEnd={onDragEnd}
              onClick={() => onItemClick?.(item)}
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm select-none transition-colors',
                onItemClick && 'cursor-pointer',
                'hover:bg-gray-50',
                active && 'bg-amber-50 ring-1 ring-amber-200',
                draggedId === item.id && 'opacity-40',
                overIdx === idx && draggedId !== item.id && 'border-t-2 border-amber-400',
              )}
            >
              <GripVertical
                className="w-4 h-4 text-gray-300 cursor-grab flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              />
              {label ? (
                <span className="font-mono text-[10px] font-bold text-amber-600 bg-amber-100 rounded px-1 py-px w-4 text-center flex-shrink-0">
                  {label}
                </span>
              ) : (
                <span className="w-4 flex-shrink-0" />
              )}
              {renderItemBody(item)}
              <button
                onClick={(e) => { e.stopPropagation(); onToggleVisibility(item.id) }}
                className="p-1 text-gray-400 hover:text-red-500 rounded hover:bg-gray-100"
                title={hideTooltip}
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
            </div>
          )
        })}
      </div>

      {hiddenItems.length > 0 && (
        <>
          <div className="border-t mx-2" />
          <div className="p-1">
            {hiddenItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm opacity-50 hover:opacity-80 hover:bg-gray-50 cursor-pointer"
                onClick={() => onToggleVisibility(item.id)}
              >
                <div className="w-4 flex-shrink-0" />
                {(renderHiddenItemBody ?? renderItemBody)(item)}
                <EyeOff className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
