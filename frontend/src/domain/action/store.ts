import { create } from 'zustand'
import { Action } from '@piano/shared'
import { actionsService } from '@/services/actions'
import { Union } from '@/lib/types'

interface ActionsState {
  actions: Action.Model[]
  isLoading: boolean
  error: string | null
  isCreating: boolean
  isUpdating: boolean
  isDeleting: boolean
  
  // Actions
  fetchActions: () => Promise<void>
  createAction: (data: Action.DTO.Create) => Promise<{ success: boolean; error?: string; action?: Action.Model }>
  updateAction: (id: string, data: Action.DTO.Update) => Promise<{ success: boolean; error?: string }>
  deleteAction: (id: string) => Promise<{ success: boolean; error?: string }>
  setActions: (actions: Action.Model[]) => void
}

export const useActionsStore = create<ActionsState>((set, get) => ({
  actions: [],
  isLoading: false,
  error: null,
  isCreating: false,
  isUpdating: false,
  isDeleting: false,

  fetchActions: async () => {
    // Prevent duplicate fetches
    if (get().isLoading) return
    
    try {
      set({ isLoading: true, error: null })
      const result = await actionsService.getAll()
      Union.match({
        success: (data) => {
          set({ actions: data, isLoading: false })
        },
        error: (err) => {
          set({ error: err.message, isLoading: false })
          console.error('Error fetching actions:', err)
        }
      }, result)
    } catch (err) {
      set({ 
        error: err instanceof Error ? err.message : 'Failed to load actions',
        isLoading: false 
      })
      console.error('Error fetching actions:', err)
    }
  },

  createAction: async (data: Action.DTO.Create) => {
    try {
      set({ isCreating: true })
      const result = await actionsService.create(data)
      return Union.match({
        success: (newAction) => {
          set(state => ({ 
            actions: [newAction, ...state.actions],
            isCreating: false
          }))
          return { success: true as const, action: newAction }
        },
        error: (err) => {
          set({ isCreating: false })
          console.error('Error creating action:', err)
          return { success: false as const, error: err.message }
        }
      }, result)
    } catch (err) {
      set({ isCreating: false })
      const errorMessage = err instanceof Error ? err.message : 'Failed to create action'
      console.error('Error creating action:', err)
      return { success: false as const, error: errorMessage }
    }
  },

  updateAction: async (id: string, data: Action.DTO.Update) => {
    try {
      set({ isUpdating: true })
      const result = await actionsService.update(id, data)
      return Union.match({
        success: (updatedAction) => {
          set(state => ({ 
            actions: state.actions.map(a => a.id === id ? updatedAction : a),
            isUpdating: false
          }))
          return { success: true as const }
        },
        error: (err) => {
          set({ isUpdating: false })
          console.error('Error updating action:', err)
          return { success: false as const, error: err.message }
        }
      }, result)
    } catch (err) {
      set({ isUpdating: false })
      const errorMessage = err instanceof Error ? err.message : 'Failed to update action'
      console.error('Error updating action:', err)
      return { success: false as const, error: errorMessage }
    }
  },

  deleteAction: async (id: string) => {
    try {
      set({ isDeleting: true })
      const result = await actionsService.delete(id)
      return Union.match({
        success: () => {
          set(state => ({ 
            actions: state.actions.filter(a => a.id !== id),
            isDeleting: false
          }))
          return { success: true as const }
        },
        error: (err) => {
          set({ isDeleting: false })
          console.error('Error deleting action:', err)
          return { success: false as const, error: err.message }
        }
      }, result)
    } catch (err) {
      set({ isDeleting: false })
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete action'
      console.error('Error deleting action:', err)
      return { success: false as const, error: errorMessage }
    }
  },

  setActions: (actions: Action.Model[]) => set({ actions }),
}))
