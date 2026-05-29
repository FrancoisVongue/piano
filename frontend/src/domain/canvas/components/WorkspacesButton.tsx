'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlowInstance } from '@xyflow/react'
import { ChevronDown, MapPin, Pencil, Plus, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { SlotKey } from '../hooks/useWorkspacesStore'

interface Props {
  arrangementId: string | null
  reactFlowInstance: ReactFlowInstance | null
  disabled?: boolean
}

const WorkspacesButtonComponent = ({ arrangementId, reactFlowInstance, disabled }: Props) => {
  const { slots, save, jump, rename, reset, getActiveSlot } = useWorkspaces({ arrangementId, reactFlowInstance })
  const [open, setOpen] = useState(false)
  const [editingSlot, setEditingSlot] = useState<SlotKey | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Recompute on every render of the popover content — pan/zoom doesn't
  // trigger re-renders here, but the popover only opens occasionally so
  // a fresh check on open is enough.
  const activeSlot = open ? getActiveSlot() : null

  const filledCount = useMemo(() => slots.filter(s => s.workspace).length, [slots])

  const beginRename = useCallback((key: SlotKey, currentName: string | undefined) => {
    setEditingSlot(key)
    setEditingValue(currentName ?? '')
  }, [])

  const commitRename = useCallback(() => {
    if (!editingSlot) return
    rename(editingSlot, editingValue)
    setEditingSlot(null)
  }, [editingSlot, editingValue, rename])

  useEffect(() => {
    if (editingSlot && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingSlot])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={filledCount > 0 ? 'secondary' : 'outline'}
          size="sm"
          className="h-8 gap-1.5 rounded-full px-3 text-xs"
          disabled={disabled || !arrangementId}
          title="Workspaces — 1..9 to jump, Alt+1..9 to save"
        >
          <MapPin className="h-3.5 w-3.5" />
          <span>WS</span>
          {filledCount > 0 && (
            <span className="text-[10px] tabular-nums opacity-70">·{filledCount}</span>
          )}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="p-0 w-72">
        <div className="px-3 py-2 border-b text-xs font-semibold text-gray-500 flex items-center justify-between">
          <span>Workspaces</span>
          <span className="text-[10px] font-normal text-gray-400">1..9 jump · ⌥/Alt+N save · dbl-click to overwrite</span>
        </div>

        <div className="p-1 max-h-[360px] overflow-y-auto">
          {slots.map(({ key, workspace }) => {
            const isFilled = workspace !== null
            const isActive = activeSlot === key
            const isEditing = editingSlot === key

            return (
              <div
                key={key}
                className={cn(
                  'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors cursor-pointer hover:bg-gray-50',
                  isActive && 'bg-amber-50 ring-1 ring-amber-200',
                )}
                onClick={() => {
                  if (isEditing) return
                  if (isFilled) jump(key)
                  else save(key)
                }}
                // Double-click on a filled slot overwrites it with the current
                // viewport — single-click already does jump, so this gives
                // power users a no-modifier "save over" without conflicting.
                onDoubleClick={(e) => {
                  if (isEditing || !isFilled) return
                  e.preventDefault()
                  e.stopPropagation()
                  save(key)
                }}
              >
                <span className="font-mono text-[11px] text-gray-400 w-4 text-center">{key}</span>

                {isFilled ? (
                  <MapPin className={cn('h-3.5 w-3.5 flex-shrink-0', isActive ? 'text-amber-500' : 'text-gray-400')} />
                ) : (
                  <Plus className="h-3.5 w-3.5 flex-shrink-0 text-gray-300" />
                )}

                {isEditing ? (
                  <input
                    ref={inputRef}
                    value={editingValue}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitRename()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditingSlot(null)
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    placeholder={`Workspace ${key}`}
                    className="flex-1 bg-transparent outline-none text-sm placeholder-gray-400"
                  />
                ) : (
                  <span className={cn('flex-1 truncate', !isFilled && 'text-gray-400 italic text-xs')}>
                    {isFilled
                      ? (workspace.name?.trim() || `Workspace ${key}`)
                      : 'Empty — click to set current view'}
                  </span>
                )}

                {isFilled && !isEditing && (
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); beginRename(key, workspace.name) }}
                      className="p-1 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100"
                      title="Rename"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); reset(key) }}
                      className="p-1 text-gray-400 hover:text-red-500 rounded hover:bg-gray-100"
                      title="Clear workspace"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export const WorkspacesButton = React.memo(WorkspacesButtonComponent)
