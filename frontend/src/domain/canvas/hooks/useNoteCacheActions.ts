'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Note } from '@piano/shared'
import { Union } from '@/lib/types'
import { NoteCacheService } from '../services/note-cache'
import { useCanvasStore } from '../store'

// -----------------------------------------------------------------------------
// useNoteCacheActions — hook that owns the "how" of cache lifecycle.
//
// The CacheButton component is purely presentational: it calls set/toggle/
// clear from this hook and re-renders on config change. All API calls,
// toast messages, store syncs, and busy-state management live here.
//
// Per-note scope: every button on every card gets its own hook instance.
// The `noteId` and `modelId` come from props, so the hook stays generic.
// -----------------------------------------------------------------------------

export const useNoteCacheActions = (noteId: string, modelId: string) => {
  const [busy, setBusy] = useState(false)
  const updateStore = useCanvasStore(state => state.updateNodeCacheConfig)

  type ActionResult =
    | { ok: true; config: Note.CacheConfig.Config | null }
    | { ok: false }

  const runAndSync = async <T>(
    op: () => Promise<Union.Variant<{ success: T; error: { message: string } }>>,
    okToastMessage: string,
    extract: (data: T) => Note.CacheConfig.Config | null,
  ): Promise<ActionResult> => {
    setBusy(true)
    const result = await op()
    setBusy(false)
    return Union.match<{ success: T; error: { message: string } }, ActionResult>({
      success: (data) => {
        const config = extract(data)
        updateStore(noteId, config)
        toast.success(okToastMessage)
        return { ok: true, config }
      },
      error: ({ message }) => {
        toast.error(message)
        return { ok: false }
      },
    }, result)
  }

  return {
    busy,

    set: (ttl: string, enabled = true) =>
      runAndSync(
        () => NoteCacheService.set(noteId, { modelId, ttl, enabled }),
        enabled ? `Cache set: ${ttl}` : 'Cache updated',
        (config) => config,
      ),

    toggle: (enabled: boolean) =>
      runAndSync(
        () => NoteCacheService.toggle(noteId, { modelId, enabled }),
        enabled ? 'Cache enabled' : 'Cache disabled',
        (config) => config,
      ),

    clear: () =>
      runAndSync(
        () => NoteCacheService.clear(noteId, modelId),
        'Cache cleared',
        (config) => config ?? null,
      ),
  }
}
