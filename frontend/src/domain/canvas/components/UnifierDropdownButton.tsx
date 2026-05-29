'use client'

import React, { useCallback, useMemo, useState, useEffect } from 'react'
import { Combine, ChevronDown, Play } from 'lucide-react'
import { useCanvasStore, useCanvasStoreEq, areNodesStructurallyEqual } from '../store'
import { useUnifiersStore } from '@/domain/unifier/store'
import { ArrangementService } from '@/domain/arrangement/services'
import { Union } from '@/lib/types'
import { Note } from '@piano/shared'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Analytics } from '@/lib/analytics'

interface UnifierDropdownButtonProps {
  className?: string
}

const UnifierDropdownButtonComponent = ({ className }: UnifierDropdownButtonProps) => {
  const nodes = useCanvasStoreEq(state => state.nodes, areNodesStructurallyEqual)
  const addNodes = useCanvasStore(state => state.addNodes)
  const arrangementId = useCanvasStore(state => state.arrangementId)
  const selectedModel = useCanvasStore(state => state.selectedModel)

  const unifiers = useUnifiersStore(state => state.unifiers)
  const fetchUnifiers = useUnifiersStore(state => state.fetchUnifiers)

  const [isOpen, setIsOpen] = useState(false)
  const [selectedUnifierId, setSelectedUnifierId] = useState<string | null>(null)
  const [userPrompt, setUserPrompt] = useState('')
  const [isExecuting, setIsExecuting] = useState(false)

  // Fetch unifiers on mount
  useEffect(() => {
    fetchUnifiers()
  }, [fetchUnifiers])

  // Selected IDs eligible for unification. TEXT annotations are excluded
  // (visual labels, not content). Infra nodes (machine logs / terminal
  // output) stay — they're legitimate content for aggregation.
  const selectedNodeIds = useMemo(() => {
    return nodes
      .filter(node => node.selected === true && Note.capabilities(node.data as { type?: Note.Type } | undefined).canBeUnifierSource)
      .map(node => node.id)
  }, [nodes])

  // Get selected unifier
  const selectedUnifier = useMemo(() => {
    if (!selectedUnifierId) return null
    return unifiers.find(u => u.id === selectedUnifierId) || null
  }, [unifiers, selectedUnifierId])

  // Auto-select first unifier if none selected
  useEffect(() => {
    if (!selectedUnifierId && unifiers.length > 0) {
      setSelectedUnifierId(unifiers[0].id)
    }
  }, [unifiers, selectedUnifierId])

  const handleExecute = useCallback(async () => {
    if (!arrangementId || !selectedUnifierId || selectedNodeIds.length === 0) return

    setIsExecuting(true)

    try {
      const result = await ArrangementService.executeUnifier(
        arrangementId,
        selectedUnifierId,
        {
          noteIds: selectedNodeIds,
          userPrompt: userPrompt.trim() || undefined,
          model: selectedModel,
        }
      )

      Union.match({
        success: (data) => {
          Analytics.track('unifier_run_started', {
            arrangementId,
            unifierId: selectedUnifierId,
            selectedNoteCount: selectedNodeIds.length,
            model: selectedModel,
            hasUserPrompt: !!userPrompt.trim(),
          })
          if (data.responseNode) {
            addNodes([data.responseNode])
          }
          setUserPrompt('')
          setIsOpen(false)
        },
        error: (err) => {
          console.error('Error executing unifier:', err.message)
        }
      }, result)
    } finally {
      setIsExecuting(false)
    }
  }, [
    arrangementId,
    selectedUnifierId,
    selectedNodeIds,
    userPrompt,
    selectedModel,
    addNodes
  ])

  // Don't show if no nodes selected or no unifiers available
  if (selectedNodeIds.length === 0 || unifiers.length === 0) {
    return null
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "bg-white shadow-sm min-w-[120px] justify-between",
            className
          )}
        >
          <div className="flex items-center gap-2">
            <Combine className="w-3 h-3 text-green-600" />
            <span className="font-medium text-sm">
              {selectedUnifier?.name || 'Unify'}
            </span>
          </div>
          <ChevronDown className="w-3 h-3 text-gray-400" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-80" align="start">
        <DropdownMenuLabel>
          Unify {selectedNodeIds.length} selected note{selectedNodeIds.length !== 1 ? 's' : ''}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Unifier Selection */}
        <div className="p-2">
          <label className="text-xs font-medium text-gray-500 mb-1 block">
            Select Unifier
          </label>
          <select
            value={selectedUnifierId || ''}
            onChange={(e) => setSelectedUnifierId(e.target.value)}
            className="w-full px-3 py-2 border rounded-md text-sm"
          >
            {unifiers.map((unifier) => (
              <option key={unifier.id} value={unifier.id}>
                {unifier.name}
              </option>
            ))}
          </select>
        </div>

        {/* User Prompt Input */}
        <div className="p-2 pt-0">
          <label className="text-xs font-medium text-gray-500 mb-1 block">
            Additional Context (optional)
          </label>
          <Textarea
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            placeholder="Add specific instructions for this execution..."
            className="min-h-[80px] text-sm"
          />
        </div>

        <DropdownMenuSeparator />

        {/* Execute Button */}
        <div className="p-2">
          <Button
            onClick={handleExecute}
            disabled={isExecuting || !selectedUnifierId}
            className="w-full gap-2"
            size="sm"
          >
            <Play className="w-3 h-3" />
            {isExecuting ? 'Executing...' : 'Execute Unifier'}
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const UnifierDropdownButton = React.memo(UnifierDropdownButtonComponent)
