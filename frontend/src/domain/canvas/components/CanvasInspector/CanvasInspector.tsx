'use client'

import React, { useMemo, useState } from 'react'
import { Layers, ChevronDown, CheckSquare, FileText, Tag as TagIcon, Server } from 'lucide-react'
import { ReactFlowInstance } from '@xyflow/react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { areNodesStructurallyEqual, useCanvasStoreEq } from '../../store'
import { BulkOperations, CanvasNode } from '../../types'
import type { Node as ReactFlowNode } from '@xyflow/react'
import { NotesPanel } from './NotesPanel'
import { SelectedPanel } from './SelectedPanel'
import { TagsPanel } from './TagsPanel'
import { MachinesPanel } from './MachinesPanel'

interface CanvasInspectorProps {
  reactFlowInstance: ReactFlowInstance | null
  onStartSetParent: (nodeIds: string[]) => void
  disabled?: boolean
}

/**
 * Single inspector that replaces the five separate dropdowns
 * (Notes / Selected / By-tag / Machines / Sort) with one composed
 * column-based panel. Column 1 morphs: when nothing is selected it
 * shows Notes; the moment selection becomes non-empty it switches
 * to Selected (which absorbs the Sort and bulk-op affordances).
 *
 * Column widths are explicit so Selected — which carries the most
 * functionality (actions, unifiers, bulk-ops, sliders) — gets the
 * room it needs without squeezing the others. On screens too small
 * to hold the whole strip the popover scrolls horizontally rather
 * than mashing content into unreadable widths.
 */
export function CanvasInspector({
  reactFlowInstance,
  onStartSetParent,
  disabled,
}: CanvasInspectorProps) {
  const nodes = useCanvasStoreEq(state => state.nodes, areNodesStructurallyEqual)
  const [open, setOpen] = useState(false)

  const counts = useMemo(() => {
    let notesC = 0, selected = 0, machines = 0, terminals = 0
    for (const n of nodes) {
      if (n.selected) selected++
      const data = n.data as any
      if (n.type === 'terminal' || data.type === 'TERMINAL') terminals++
      else if (n.type === 'machine' || data.type === 'MACHINE') machines++
      else notesC++
    }
    const tags = BulkOperations.getAllTags(nodes as ReactFlowNode<CanvasNode.UI>[]).length
    return { notes: notesC, selected, machines, terminals, tags }
  }, [nodes])

  const hasSelection = counts.selected > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            'h-8 min-w-[220px] justify-between gap-2 bg-white px-3 shadow-sm',
            hasSelection && 'border-emerald-400 bg-emerald-50 hover:bg-emerald-100',
          )}
          title={hasSelection ? `${counts.selected} selected` : 'Browse notes, tags, machines'}
        >
          <div className="flex items-center gap-2">
            {hasSelection ? (
              <CheckSquare className="h-3.5 w-3.5 flex-shrink-0 text-emerald-600" />
            ) : (
              <Layers className="h-3.5 w-3.5 flex-shrink-0 text-stone-700" />
            )}
            <span className="text-xs font-medium">
              {hasSelection ? `Selected ${counts.selected}` : 'Browse'}
            </span>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-stone-500">
            <TriggerCount icon={<FileText className="h-3 w-3" />} n={counts.notes} />
            <TriggerCount icon={<TagIcon className="h-3 w-3" />} n={counts.tags} />
            <TriggerCount icon={<Server className="h-3 w-3" />} n={counts.machines + counts.terminals} />
            <ChevronDown className="ml-0.5 h-3 w-3 text-gray-400" />
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-fit max-w-[95vw] overflow-hidden p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div
          className={cn(
            'flex h-[520px] divide-x divide-stone-200 overflow-x-auto bg-white',
          )}
        >
          {hasSelection ? (
            <SelectedPanel
              reactFlowInstance={reactFlowInstance}
              onStartSetParent={onStartSetParent}
              onAfterFocus={() => setOpen(false)}
            />
          ) : (
            <NotesPanel
              reactFlowInstance={reactFlowInstance}
              onAfterFocus={() => setOpen(false)}
            />
          )}
          <TagsPanel
            reactFlowInstance={reactFlowInstance}
            onAfterFocus={() => setOpen(false)}
          />
          <MachinesPanel
            reactFlowInstance={reactFlowInstance}
            onAfterFocus={() => setOpen(false)}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TriggerCount({ icon, n }: { icon: React.ReactNode; n: number }) {
  if (n === 0) return null
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-stone-100 px-1 py-0.5 tabular-nums">
      {icon}
      {n}
    </span>
  )
}
