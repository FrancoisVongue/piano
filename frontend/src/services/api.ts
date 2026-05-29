import { API_CONFIG } from '@/config'
import { useAuthStore } from '@/domain/auth/store'
import { Union } from '@/lib/types'
import { traceparent } from '@/lib/trace'

export async function apiClient<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<Union.Variant<{ success: T; error: { message: string; code?: number } }>> {
  // Get token directly from the auth store's state
  const token = useAuthStore.getState().user?.id

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  // W3C trace-context: gives the backend a trace_id to attach this call to.
  // OTel HTTP instrumentation on the server side picks this up automatically.
  const tp = traceparent()
  if (tp) headers.traceparent = tp

  try {
    const response = await fetch(`${API_CONFIG.API_URL}${endpoint}`, {
      ...options,
      headers,
      credentials: 'include', // Important for better-auth cookies
    })

    if (!response.ok) {
      // Backend convention is `{ error: { message: '...' } }`; some endpoints
      // also return `{ message: '...' }` directly. Try both before falling back
      // to a generic HTTP status string so users see the real reason.
      const body = await response.json().catch(() => null)
      const message = body?.error?.message || body?.message || `HTTP ${response.status}`
      return {
        error: {
          message,
          code: response.status
        }
      }
    }

    // Handle empty responses (like 204 No Content)
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return { success: null as T }
    }

    // Check if response has JSON content
    const contentType = response.headers.get('content-type')
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json()
      return { success: data }
    }

    // For non-JSON responses, return as text
    const text = await response.text()
    const parsed = text ? JSON.parse(text) : null
    return { success: parsed as T }
  } catch (error) {
    console.error('apiClient error:', error)
    return {
      error: {
        message: error instanceof Error ? error.message : 'Network error'
      }
    }
  }
}