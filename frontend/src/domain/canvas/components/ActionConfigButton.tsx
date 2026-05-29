'use client'

import React, { useCallback } from 'react'
import { Zap, ChevronDown, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useActionsContext } from '@/domain/action/ActionsContext'
import { ReorderableHotkeyList } from '@/lib/ReorderableHotkeyList'
import { partitionByVisibility } from '@/lib/visibilityOrder'

// Top-4 visible actions bind to a/s/d/f (home row, left hand). Pairs with
// q/w/e/r for models in ModelSelector. Hotkey wiring lives in
// useArrangementHotkeys; this component just labels the rows.
const HOTKEY_LABELS = ['a', 's', 'd', 'f'] as const

interface Props {
  disabled?: boolean
}

const ActionConfigButtonComponent = ({ disabled }: Props) => {
  const { allActions, actionsConfig, updateActionsConfig } = useActionsContext()
  const hasCustomConfig = actionsConfig !== null
  const { visible, hidden } = partitionByVisibility(allActions, actionsConfig?.visibleIds)

  const onReorder = useCallback((nextIds: string[]) => {
    updateActionsConfig({ visibleIds: nextIds })
  }, [updateActionsConfig])

  const onToggleVisibility = useCallback((id: string) => {
    const cur = actionsConfig?.visibleIds ?? allActions.map(a => a.id)
    const next = cur.includes(id) ? cur.filter(v => v !== id) : [...cur, id]
    updateActionsConfig(next.length === 0 ? null : { visibleIds: next })
  }, [actionsConfig, allActions, updateActionsConfig])

  if (allActions.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            'gap-1.5 text-xs font-medium',
            'border-gray-200 hover:bg-gray-50',
            hasCustomConfig && 'border-amber-300 bg-amber-50 hover:bg-amber-100',
          )}
        >
          <Zap className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Actions</span>
          {hasCustomConfig && (
            <span className="text-[10px] bg-amber-200 text-amber-800 rounded-full px-1.5 py-0.5 leading-none">
              {visible.length}/{allActions.length}
            </span>
          )}
          <ChevronDown className="w-3 h-3 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="p-0">
        <div className="px-3 py-2 flex items-center justify-between border-b">
          <span className="text-xs font-semibold text-gray-500">Actions on nodes</span>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-normal text-gray-400">Alt + a s d f → top 4</span>
            {hasCustomConfig && (
              <button
                onClick={() => updateActionsConfig(null)}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[300px] overflow-y-auto">
          <ReorderableHotkeyList
            visibleItems={visible}
            hiddenItems={hidden}
            hotkeyLabels={HOTKEY_LABELS}
            onReorder={onReorder}
            onToggleVisibility={onToggleVisibility}
            renderItemBody={(action) => (
              <>
                <Zap className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                <span className="truncate flex-1">{action.name}</span>
              </>
            )}
            renderHiddenItemBody={(action) => (
              <>
                <Zap className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />
                <span className="truncate flex-1 text-gray-400">{action.name}</span>
              </>
            )}
            hideTooltip="Hide action"
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

export const ActionConfigButton = React.memo(ActionConfigButtonComponent)
