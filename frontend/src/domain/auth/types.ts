import { User } from '@piano/shared'

export namespace AuthUI {
  // UI-specific auth session state
  export interface SessionState {
    user: User.Session | null
    isAuthenticated: boolean
    isLoading: boolean
  }

  // UI-specific auth form data
  export interface SignInForm {
    email: string
    password: string
    rememberMe?: boolean
  }

  export interface SignUpForm {
    email: string
    password: string
    confirmPassword: string
    name?: string
    acceptTerms: boolean
  }

  // Form validation results
  export interface ValidationError {
    field: string
    message: string
  }

  // Auth flow states
  export type AuthFlowState = 'idle' | 'signing-in' | 'signing-up' | 'signing-out' | 'verifying'

  // Helper functions for auth UI
  export const isValidEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(email)
  }

  export const validatePassword = (password: string): ValidationError[] => {
    const errors: ValidationError[] = []

    if (password.length < 6) {
      errors.push({ field: 'password', message: 'Password must be at least 6 characters' })
    }

    return errors
  }

  export const validateSignUpForm = (form: SignUpForm): ValidationError[] => {
    const errors: ValidationError[] = []

    if (!isValidEmail(form.email)) {
      errors.push({ field: 'email', message: 'Invalid email address' })
    }

    errors.push(...validatePassword(form.password))

    if (form.password !== form.confirmPassword) {
      errors.push({ field: 'confirmPassword', message: 'Passwords do not match' })
    }

    if (!form.acceptTerms) {
      errors.push({ field: 'acceptTerms', message: 'You must accept the terms and conditions' })
    }

    return errors
  }
}