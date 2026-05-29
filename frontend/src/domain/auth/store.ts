// Only UI state for auth - server data is managed by hooks
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { User } from '@piano/shared'

interface AuthStore {
  // UI State only
  user: User.Session | null
  isAuthenticated: boolean

  // Actions for UI state
  setUser: (user: User.Session | null) => void
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      // Initial state
      user: null,
      isAuthenticated: false,

      // Set user in UI state
      setUser: (user) => set({
        user,
        isAuthenticated: !!user
      }),
    }),
    {
      name: 'piano-auth',
      partialize: (state) => ({ user: state.user }) // Only persist user
    }
  )
)