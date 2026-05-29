import React, { createContext, useContext, useMemo, useCallback, ReactNode } from 'react'
import { Action, Arrangement } from '@piano/shared'
import { useActionsStore } from './store'
import { partitionByVisibility } from '@/lib/visibilityOrder'

// ActionsContext speaks the actions sub-slice only — the parent (Canvas) owns
// the full Arrangement.Config and is responsible for merging slice updates back.
type ActionsConfig = NonNullable<Arrangement.Config['actions']>

interface ActionsContextValue {
  actions: Action.Model[]
  allActions: Action.Model[]
  actionsConfig: ActionsConfig | null
  updateActionsConfig: (next: ActionsConfig | null) => void
  isLoading: boolean
}

const ActionsContext = createContext<ActionsContextValue | undefined>(undefined)

interface ActionsProviderProps {
  children: ReactNode
  actionsConfig?: ActionsConfig | null
  onActionsConfigChange?: (next: ActionsConfig | null) => void
}

export function ActionsProvider({ children, actionsConfig = null, onActionsConfigChange }: ActionsProviderProps) {
  const allActions = useActionsStore(state => state.actions)
  const isLoading = useActionsStore(state => state.isLoading)

  const actions = useMemo(
    () => partitionByVisibility(allActions, actionsConfig?.visibleIds).visible,
    [allActions, actionsConfig],
  )

  const updateActionsConfig = useCallback((next: ActionsConfig | null) => {
    onActionsConfigChange?.(next)
  }, [onActionsConfigChange])

  return (
    <ActionsContext.Provider value={{ actions, allActions, actionsConfig, updateActionsConfig, isLoading }}>
      {children}
    </ActionsContext.Provider>
  )
}

export function useActionsContext() {
  const context = useContext(ActionsContext)
  if (!context) {
    throw new Error('useActionsContext must be used within ActionsProvider')
  }
  return context
}
