'use client'

import { useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrangementService } from '../services'
import { Union } from '@/lib/types'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { toast } from 'sonner'

/**
 * Per-user "preloaded arrangements" — a local list of arrangement IDs that
 * should be fetched eagerly and kept warm in the TanStack Query cache, so
 * switching between them is instant.
 *
 * Stored in localStorage as a JSON array of arrangement IDs. No backend
 * field — the user's subscription tier can later gate the max count, but
 * the mechanism itself is purely client-side.
 */

const STORAGE_KEY = 'piano:preloaded-arrangements'
export const DEFAULT_PRELOAD_LIMIT = 10

// 5 min staleTime: enough to keep switches instant within a working session,
// short enough that edits from other tabs/devices show up on next switch.
const PRELOAD_STALE_TIME = 5 * 60 * 1000

const EMPTY_IDS: string[] = []

/** Fire a single prefetch. Returns false if the fetch failed so the caller
 *  can decide whether to keep the entry in the list. */
const prefetch = async (
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
): Promise<boolean> => {
  try {
    await queryClient.prefetchQuery({
      queryKey: ['arrangement', id],
      queryFn: async () => {
        const result = await ArrangementService.fetchById(id)
        if ('error' in result && result.error) throw new Error(result.error.message)
        if (!('success' in result) || !result.success) throw new Error('Empty response')
        return result.success
      },
      staleTime: PRELOAD_STALE_TIME,
    })
    return true
  } catch {
    return false
  }
}

export function usePreloadedArrangements(limit: number = DEFAULT_PRELOAD_LIMIT) {
  const queryClient = useQueryClient()
  const [ids, setIds] = useLocalStorage<string[]>(STORAGE_KEY, EMPTY_IDS)

  // Warm up on mount — fire-and-forget, failures are silent here
  // (user hasn't interacted yet so a toast would be confusing).
  useEffect(() => {
    for (const id of ids) prefetch(queryClient, id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient])

  const isPreloaded = useCallback((id: string) => ids.includes(id), [ids])

  const togglePreloaded = useCallback(async (id: string) => {
    // Remove
    if (ids.includes(id)) {
      setIds(prev => prev.filter(x => x !== id))
      return
    }

    // Prefetch first — if it fails, don't add to the list
    const ok = await prefetch(queryClient, id)
    if (!ok) {
      toast.error('Could not preload arrangement — it may have been deleted.')
      return
    }

    setIds(prev => {
      if (prev.includes(id)) return prev // race-guard

      // Evict oldest if at limit
      if (prev.length >= limit) {
        toast.info(`Preload limit (${limit}) reached — oldest entry removed.`)
        return [...prev.slice(1), id]
      }
      return [...prev, id]
    })
  }, [ids, limit, queryClient, setIds])

  return { preloadedIds: ids, isPreloaded, togglePreloaded, limit }
}
