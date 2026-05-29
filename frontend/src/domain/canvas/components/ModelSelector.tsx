'use client'

import React, { useCallback, useEffect, useMemo } from 'react'
import { useCanvasStore } from '../store'
import { useActiveModels } from '@/domain/settings/hooks/useSettings'
import { Arrangement, LLM } from '@piano/shared'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { Brain, ChevronDown, RotateCcw } from 'lucide-react'
import { ReorderableHotkeyList } from '@/lib/ReorderableHotkeyList'
import { partitionByVisibility } from '@/lib/visibilityOrder'
import Link from 'next/link'

type ModelsConfig = NonNullable<Arrangement.Config['models']>

// Top-4 visible models bind to q/w/e/r (paired with a/s/d/f for actions).
// Hotkey wiring lives in useArrangementHotkeys; this component just labels.
const HOTKEY_LABELS = ['q', 'w', 'e', 'r'] as const

interface Props {
  modelsConfig: ModelsConfig | null
  onModelsConfigChange: (next: ModelsConfig | null) => void
  disabled?: boolean
}

const ModelSelectorComponent = ({ modelsConfig, onModelsConfigChange, disabled }: Props) => {
  const selectedModel = useCanvasStore(state => state.selectedModel)
  const setSelectedModel = useCanvasStore(state => state.setSelectedModel)
  const { models: allModels, isLoading } = useActiveModels()

  const hasCustomConfig = modelsConfig !== null
  const { visible: visibleModels, hidden: hiddenModels } = useMemo(
    () => partitionByVisibility(allModels, modelsConfig?.visibleIds),
    [allModels, modelsConfig],
  )
  const visibleSet = useMemo(() => new Set(visibleModels.map(m => m.id)), [visibleModels])

  // Keep selection pointed at something that actually exists AND is visible.
  // If the user disabled their last key, or hid the currently-selected model,
  // fall back to the first visible model so the toolbar pill never lies.
  useEffect(() => {
    if (isLoading || allModels.length === 0) return
    if (allModels.some(m => m.id === selectedModel) && visibleSet.has(selectedModel)) return
    const fallback = visibleModels[0]?.id ?? allModels[0].id
    setSelectedModel(fallback as LLM.ModelId)
  }, [allModels, visibleSet, visibleModels, selectedModel, setSelectedModel, isLoading])

  const currentModel = allModels.find(m => m.id === selectedModel) ?? LLM.getModelById(selectedModel)
  const hasModels = allModels.length > 0

  const onReorder = useCallback((nextIds: string[]) => {
    onModelsConfigChange({ visibleIds: nextIds })
  }, [onModelsConfigChange])

  const onToggleVisibility = useCallback((id: string) => {
    const cur = modelsConfig?.visibleIds ?? allModels.map(m => m.id)
    const next = cur.includes(id) ? cur.filter(v => v !== id) : [...cur, id]
    onModelsConfigChange(next.length === 0 ? null : { visibleIds: next })
  }, [modelsConfig, allModels, onModelsConfigChange])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            'gap-2 text-xs font-medium min-w-[140px] justify-between',
            'border-gray-200 hover:bg-gray-50',
            hasCustomConfig && 'border-amber-300 bg-amber-50 hover:bg-amber-100',
          )}
        >
          <div className="flex items-center gap-1.5">
            <Brain className="w-3.5 h-3.5" />
            <span className="truncate">
              {hasModels ? (currentModel?.name ?? 'Select Model') : 'No models'}
            </span>
          </div>
          <ChevronDown className="w-3 h-3 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="p-0 w-72">
        <div className="px-3 py-2 flex items-center justify-between border-b">
          <span className="text-xs font-semibold text-gray-500">AI Model</span>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-normal text-gray-400">Alt + q w e r → top 4</span>
            {hasCustomConfig && (
              <button
                onClick={() => onModelsConfigChange(null)}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            )}
          </div>
        </div>

        {hasModels ? (
          <div className="max-h-[360px] overflow-y-auto">
            <ReorderableHotkeyList
              visibleItems={visibleModels}
              hiddenItems={hiddenModels}
              hotkeyLabels={HOTKEY_LABELS}
              onReorder={onReorder}
              onToggleVisibility={onToggleVisibility}
              onItemClick={(model) => setSelectedModel(model.id as LLM.ModelId)}
              isItemActive={(model) => model.id === selectedModel}
              renderItemBody={renderModelBody}
              renderHiddenItemBody={renderHiddenModelBody}
              hideTooltip="Hide model"
            />
          </div>
        ) : (
          <div className="p-3">
            <div className="text-sm text-gray-600 mb-2">Add a provider API key to unlock models.</div>
            <Link href="/settings" className="text-sm text-amber-600 hover:underline">
              Open Settings →
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// Hoisted out of the component so React.memo's identity comparisons aren't
// thrown off by re-created render functions on every parent render.
const renderModelBody = (model: LLM.Model) => {
  const viaRouter = model.provider === 'OPENROUTER'
  return (
    <>
      <Brain className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium truncate">{model.name}</span>
          {viaRouter && (
            <span
              title="Routed through OpenRouter"
              className="text-[9px] font-bold tracking-wider px-1 py-px rounded bg-violet-100 text-violet-700"
            >
              OR
            </span>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground truncate">
          {viaRouter ? 'via OpenRouter' : model.provider}
        </div>
      </div>
    </>
  )
}

const renderHiddenModelBody = (model: LLM.Model) => (
  <>
    <Brain className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />
    <span className="truncate flex-1 text-gray-400">{model.name}</span>
  </>
)

export const ModelSelector = React.memo(ModelSelectorComponent)
