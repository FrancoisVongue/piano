import { useState, useEffect, useCallback } from 'react'
import { Action } from '@piano/shared'
import { actionsService } from '@/services/actions'
import { Union } from '@/lib/types'

interface UseActionsOptions {
  enabled?: boolean
}

interface UseActionsReturn {
  actions: Action.Model[]
  isLoading: boolean
  error: string | null
  createAction: (data: Action.DTO.Create) => Promise<{ success: boolean; error?: string; action?: Action.Model }>
  updateAction: (id: string, data: Action.DTO.Update) => Promise<{ success: boolean; error?: string }>
  deleteAction: (id: string) => Promise<{ success: boolean; error?: string }>
  refreshActions: () => Promise<void>
  isCreating: boolean
  isUpdating: boolean
  isDeleting: boolean
}

export function useActions(options: UseActionsOptions = {}): UseActionsReturn {
  const { enabled = true } = options
  const [actions, setActions] = useState<Action.Model[]>([])
  const [isLoading, setIsLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const fetchActions = useCallback(async () => {
    if (!enabled) return
    
    try {
      setIsLoading(true)
      setError(null)
      const result = await actionsService.getAll()
      Union.match({
        success: (data) => {
          setActions(data)
        },
        error: (err) => {
          setError(err.message)
          console.error('Error fetching actions:', err)
        }
      }, result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load actions')
      console.error('Error fetching actions:', err)
    } finally {
      setIsLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (enabled) {
      fetchActions()
    }
  }, [fetchActions, enabled])

  const createAction = useCallback(async (data: Action.DTO.Create): Promise<{ success: boolean; error?: string; action?: Action.Model }> => {
    try {
      setIsCreating(true)
      const result = await actionsService.create(data)
      return Union.match({
        success: (newAction) => {
          setActions(prev => [newAction, ...prev])
          return { success: true as const, action: newAction }
        },
        error: (err) => {
          console.error('Error creating action:', err)
          return { success: false as const, error: err.message }
        }
      }, result)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to create action'
      console.error('Error creating action:', err)
      return { success: false as const, error: errorMessage }
    } finally {
      setIsCreating(false)
    }
  }, [])

  const updateAction = useCallback(async (id: string, data: Action.DTO.Update): Promise<{ success: boolean; error?: string }> => {
    try {
      setIsUpdating(true)
      const result = await actionsService.update(id, data)
      return Union.match({
        success: (updatedAction) => {
          setActions(prev => prev.map(a => a.id === id ? updatedAction : a))
          return { success: true as const }
        },
        error: (err) => {
          console.error('Error updating action:', err)
          return { success: false as const, error: err.message }
        }
      }, result)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update action'
      console.error('Error updating action:', err)
      return { success: false as const, error: errorMessage }
    } finally {
      setIsUpdating(false)
    }
  }, [])

  const deleteAction = useCallback(async (id: string): Promise<{ success: boolean; error?: string }> => {
    try {
      setIsDeleting(true)
      const result = await actionsService.delete(id)
      return Union.match({
        success: () => {
          setActions(prev => prev.filter(a => a.id !== id))
          return { success: true as const }
        },
        error: (err) => {
          console.error('Error deleting action:', err)
          return { success: false as const, error: err.message }
        }
      }, result)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete action'
      console.error('Error deleting action:', err)
      return { success: false as const, error: errorMessage }
    } finally {
      setIsDeleting(false)
    }
  }, [])

  return {
    actions,
    isLoading,
    error,
    createAction,
    updateAction,
    deleteAction,
    refreshActions: fetchActions,
    isCreating,
    isUpdating,
    isDeleting,
  }
}
