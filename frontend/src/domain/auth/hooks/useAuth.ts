import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { AuthService } from '../services'
import { useAuthStore } from '../store'
import { Union } from '@/lib/types'
import { Analytics } from '@/lib/analytics'

export function useAuth() {
  const router = useRouter()
  const { user, isAuthenticated, setUser } = useAuthStore()
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const checkAuth = useCallback(async () => {
    setIsLoading(true)
    const result = await AuthService.checkAuth()

    Union.match({
      success: (userData) => {
        setUser(userData)
        if (userData) {
          Analytics.identify(userData)
        } else {
          Analytics.reset()
        }
        setIsLoading(false)
      },
      error: ({ message }) => {
        setError(message)
        setUser(null)
        setIsLoading(false)
      }
    }, result)
  }, [setUser])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  const signIn = async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true)
    setError(null)

    const result = await AuthService.signIn(email, password)

    return Union.match({
      success: (userData) => {
        setUser(userData)
        Analytics.identify(userData)
        Analytics.track('signed_in', { method: 'email' })
        setIsLoading(false)
        return { success: true }
      },
      error: ({ message }) => {
        setError(message)
        setIsLoading(false)
        return { success: false, error: message }
      }
    }, result)
  }

  const signInWithGoogle = async (): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true)
    setError(null)

    const result = await AuthService.signInWithGoogle()

    return Union.match({
      success: () => ({ success: true }),
      error: ({ message }) => {
        setError(message)
        setIsLoading(false)
        return { success: false, error: message }
      }
    }, result)
  }

  const signUp = async (email: string, password: string, name: string): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true)
    setError(null)

    const result = await AuthService.signUp(email, password, name)

    return Union.match({
      success: (userData) => {
        setUser(userData)
        Analytics.track('signed_up', { method: 'email' })
        setIsLoading(false)
        return { success: true }
      },
      error: ({ message }) => {
        setError(message)
        setIsLoading(false)
        return { success: false, error: message }
      }
    }, result)
  }

  const signOut = async () => {
    const result = await AuthService.signOut()

    Union.match({
      success: () => {
        Analytics.track('signed_out', {})
        Analytics.reset()
        setUser(null)
        router.push('/')
      },
      error: ({ message }) => {
        setError(message)
        Analytics.track('signed_out', {})
        Analytics.reset()
        setUser(null)
        router.push('/')
      }
    }, result)
  }

  return {
    user,
    isAuthenticated,
    isLoading,
    error,
    signIn,
    signInWithGoogle,
    signUp,
    signOut,
    checkAuth
  }
}
