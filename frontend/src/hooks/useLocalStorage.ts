'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Generic localStorage-backed React state hook.
 *
 * Reads once on mount, writes on every change, and subscribes to the `storage`
 * event so updates from other tabs propagate live.
 *
 * Use this for any client-only preference/cache that should survive reloads
 * but doesn't warrant a backend field. Patterns like sidebar width, view mode,
 * font multipliers, pinned toolbars, preload lists — all live here.
 *
 * @example
 * const [viewMode, setViewMode] = useLocalStorage('piano-editor-view-mode', 'preview')
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const readValue = useCallback((): T => {
    if (typeof window === 'undefined') return initialValue
    try {
      const raw = window.localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initialValue
    } catch {
      return initialValue
    }
  }, [key, initialValue])

  const [value, setValue] = useState<T>(initialValue)

  // Hydrate from storage on mount (avoids SSR mismatch).
  useEffect(() => {
    setValue(readValue())
  }, [readValue])

  // Persist changes and cross-tab broadcast.
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue(prev => {
        const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next
        try {
          if (typeof window !== 'undefined') {
            window.localStorage.setItem(key, JSON.stringify(resolved))
          }
        } catch {
          // quota exceeded / private mode — best effort
        }
        return resolved
      })
    },
    [key],
  )

  // Listen for updates from other tabs.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (e: StorageEvent) => {
      if (e.key === key) setValue(readValue())
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [key, readValue])

  return [value, set]
}
