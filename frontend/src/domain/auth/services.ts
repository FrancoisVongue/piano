import { authClient } from '@/lib/auth'
import { Union } from '@/lib/types'
import { User } from '@piano/shared'

export const AuthService = {
  async signIn(
    email: string,
    password: string
  ): Promise<Union.Variant<{ success: User.Session; error: { message: string } }>> {
    try {
      const result = await authClient.signIn.email({ email, password })
      if (result.data?.user) {
        return {
          success: {
            id: result.data.user.id,
            email: result.data.user.email || '',
            name: result.data.user.name,
          }
        }
      }
      return { error: { message: result.error?.message || 'Invalid credentials' } }
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to sign in'
        }
      }
    }
  },

  async signInWithGoogle(): Promise<Union.Variant<{ success: true; error: { message: string } }>> {
    try {
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL: `${window.location.origin}/arrangements`,
      })

      if (result.error) {
        return { error: { message: result.error.message || 'Google sign in failed' } }
      }

      return { success: true }
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to sign in with Google'
        }
      }
    }
  },

  async signUp(
    email: string,
    password: string,
    name: string
  ): Promise<Union.Variant<{ success: User.Session; error: { message: string } }>> {
    try {
      const result = await authClient.signUp.email({ email, password, name })
      if (result.error) {
        return { error: { message: result.error.message || 'Sign up failed' } }
      }
      if (!result.data?.user) {
        return { error: { message: 'Sign up failed: no user returned' } }
      }
      return {
        success: {
          id: result.data.user.id,
          email: result.data.user.email || '',
          name: result.data.user.name,
        }
      }
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to sign up'
        }
      }
    }
  },

  async signOut(): Promise<Union.Variant<{ success: true; error: { message: string } }>> {
    try {
      await authClient.signOut()
      return { success: true }
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to sign out'
        }
      }
    }
  },

  async checkAuth(): Promise<Union.Variant<{ success: User.Session | null; error: { message: string } }>> {
    try {
      const session = await authClient.getSession()
      if (session.data?.user) {
        return {
          success: {
            id: session.data.user.id,
            email: session.data.user.email || '',
            name: session.data.user.name,
          }
        }
      }
      return { success: null }
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to check auth'
        }
      }
    }
  }
}
