import { create } from 'zustand'
import { Unifier } from '@piano/shared'
import { unifersService } from '@/services/unifiers'
import { Union } from '@/lib/types'

interface UnifiersState {
  unifiers: Unifier.Model[]
  isLoading: boolean
  error: string | null
  isCreating: boolean
  isUpdating: boolean
  isDeleting: boolean

  // Actions
  fetchUnifiers: () => Promise<void>
  createUnifier: (data: Unifier.DTO.Create) => Promise<{ success: boolean; error?: string; unifier?: Unifier.Model }>
  updateUnifier: (id: string, data: Unifier.DTO.Update) => Promise<{ success: boolean; error?: string }>
  deleteUnifier: (id: string) => Promise<{ success: boolean; error?: string }>
  setUnifiers: (unifiers: Unifier.Model[]) => void
}

export const useUnifiersStore = create<UnifiersState>((set, get) => ({
  unifiers: [],
  isLoading: false,
  error: null,
  isCreating: false,
  isUpdating: false,
  isDeleting: false,

  fetchUnifiers: async () => {
    // Prevent duplicate fetches
    if (get().isLoading) return

    try {
      set({ isLoading: true, error: null })
      const result = await unifersService.getAll()
      Union.match({
        success: (data) => {
          set({ unifiers: data, isLoading: false })
        },
        error: (err) => {
          set({ error: err.message, isLoading: false })
          console.error('Error fetching unifiers:', err)
        }
      }, result)
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load unifiers',
        isLoading: false
      })
      console.error('Error fetching unifiers:', err)
    }
  },

  createUnifier: async (data: Unifier.DTO.Create) => {
    try {
      set({ isCreating: true })
      const result = await unifersService.create(data)
      return Union.match({
        success: (newUnifier) => {
          set(state => ({
            unifiers: [newUnifier, ...state.unifiers],
            isCreating: false
          }))
          return { success: true as const, unifier: newUnifier }
        },
        error: (err) => {
          set({ isCreating: false })
          console.error('Error creating unifier:', err)
          return { success: false as const, error: err.message }
        }
      }, result)
    } catch (err) {
      set({ isCreating: false })
      const errorMessage = err instanceof Error ? err.message : 'Failed to create unifier'
      console.error('Error creating unifier:', err)
      return { success: false as const, error: errorMessage }
    }
  },

  updateUnifier: async (id: string, data: Unifier.DTO.Update) => {
    try {
      set({ isUpdating: true })
      const result = await unifersService.update(id, data)
      return Union.match({
        success: (updatedUnifier) => {
          set(state => ({
            unifiers: state.unifiers.map(u => u.id === id ? updatedUnifier : u),
            isUpdating: false
          }))
          return { success: true as const }
        },
        error: (err) => {
          set({ isUpdating: false })
          console.error('Error updating unifier:', err)
          return { success: false as const, error: err.message }
        }
      }, result)
    } catch (err) {
      set({ isUpdating: false })
      const errorMessage = err instanceof Error ? err.message : 'Failed to update unifier'
      console.error('Error updating unifier:', err)
      return { success: false as const, error: errorMessage }
    }
  },

  deleteUnifier: async (id: string) => {
    try {
      set({ isDeleting: true })
      const result = await unifersService.delete(id)
      return Union.match({
        success: () => {
          set(state => ({
            unifiers: state.unifiers.filter(u => u.id !== id),
            isDeleting: false
          }))
          return { success: true as const }
        },
        error: (err) => {
          set({ isDeleting: false })
          console.error('Error deleting unifier:', err)
          return { success: false as const, error: err.message }
        }
      }, result)
    } catch (err) {
      set({ isDeleting: false })
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete unifier'
      console.error('Error deleting unifier:', err)
      return { success: false as const, error: errorMessage }
    }
  },

  setUnifiers: (unifiers: Unifier.Model[]) => set({ unifiers }),
}))
