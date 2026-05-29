'use client'

import React, { useCallback, useMemo, useState } from 'react'
import { Pin, Pencil, Check, X, FileText } from 'lucide-react'
import { ReactFlowInstance } from '@xyflow/react'
import { areNodesStructurallyEqual, useCanvasStore, useCanvasStoreEq } from '../../store'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { InspectorColumn, InspectorRow } from './InspectorColumn'

interface NotesPanelProps {
  reactFlowInstance: ReactFlowInstance | null
  onAfterFocus?: () => void
}

export function NotesPanel({ reactFlowInstance, onAfterFocus }: NotesPanelProps) {
  const nodes = useCanvasStoreEq(state => state.nodes, areNodesStructurallyEqual)
  const updateNodeLabel = useCanvasStore(state => state.updateNodeLabel)
  const toggleNodePinned = useCanvasStore(state => state.toggleNodePinned)

  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  // Sort: pinned first, then most-recently visited (visit-time is local-only,
  // tracked in localStorage on focus), then alphabetical as the stable
  // fallback so cold-open ordering is predictable.
  const sortedNotes = useMemo(() => {
    const visitMap = readVisitMap()
    return nodes
      .filter(n => n.type !== 'machine' && n.type !== 'terminal')
      .map(n => {
        const label = (n.data.label as string | null | undefined) || null
        const content = (n.data.content as string) || ''
        const base = (label?.trim() || content.trim())
        return {
          id: n.id,
          pinned: n.data.pinned === true,
          displayText: base.length ? base : '(Empty note)',
          label,
          visitedAt: visitMap[n.id] ?? 0,
        }
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        if (a.visitedAt !== b.visitedAt) return b.visitedAt - a.visitedAt
        return a.displayText.localeCompare(b.displayText)
      })
  }, [nodes])

  const focusNode = useCallback((id: string) => {
    if (!reactFlowInstance) return
    const node = useCanvasStore.getState().nodes.find(n => n.id === id)
    if (!node) return
    const scale = (node.data.scale as number) || 1
    markVisited(id)
    const zoom = Math.min(3, Math.max(0.5, 1.2 / (scale * scale)))
    reactFlowInstance.setCenter(node.position.x, node.position.y, { duration: 800, zoom })
    onAfterFocus?.()
  }, [reactFlowInstance, onAfterFocus])

  const startEdit = (id: string, currentLabel: string | null) => {
    setEditingNodeId(id)
    setEditValue(currentLabel || '')
  }

  const saveEdit = (id: string) => {
    updateNodeLabel(id, editValue.trim() || null)
    setEditingNodeId(null)
    setEditValue('')
  }

  const cancelEdit = () => {
    setEditingNodeId(null)
    setEditValue('')
  }

  return (
    <InspectorColumn
      icon={<FileText className="h-3 w-3" />}
      accent="text-blue-600"
      title="Notes"
      count={sortedNotes.length}
      emptyHint="No notes yet."
      width={200}
    >
      {sortedNotes.map(n => (
        <div key={n.id} className="border-b border-stone-100 last:border-b-0">
          {editingNodeId === n.id ? (
            <div className="flex items-center gap-1 px-2 py-1.5">
              <Pin className={cn('h-3 w-3 flex-shrink-0', n.pinned ? 'text-blue-600 fill-current' : 'text-gray-400')} />
              <Input
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); saveEdit(n.id) }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                }}
                className="h-7 text-xs"
                autoFocus
              />
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => saveEdit(n.id)}>
                <Check className="h-3 w-3 text-green-600" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={cancelEdit}>
                <X className="h-3 w-3 text-red-600" />
              </Button>
            </div>
          ) : (
            <InspectorRow onClick={() => focusNode(n.id)}>
              <Pin
                className={cn(
                  'h-3 w-3 flex-shrink-0 cursor-pointer',
                  n.pinned ? 'text-blue-600 fill-current' : 'text-gray-300 hover:text-gray-500',
                )}
                onClick={e => { e.stopPropagation(); toggleNodePinned(n.id) }}
              />
              <span className="flex-1 truncate text-gray-700">{n.displayText}</span>
              <Pencil
                className="h-3 w-3 flex-shrink-0 cursor-pointer text-gray-300 hover:text-gray-600"
                onClick={e => { e.stopPropagation(); startEdit(n.id, n.label) }}
              />
            </InspectorRow>
          )}
        </div>
      ))}
    </InspectorColumn>
  )
}

const VISIT_KEY = 'canvas-inspector:notes-visited'

function readVisitMap(): Record<string, number> {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(VISIT_KEY) || '{}')
  } catch {
    return {}
  }
}

function markVisited(id: string) {
  if (typeof window === 'undefined') return
  const map = readVisitMap()
  map[id] = Date.now()
  try {
    localStorage.setItem(VISIT_KEY, JSON.stringify(map))
  } catch {
    /* localStorage full — non-fatal */
  }
}
