import { apiClient } from '@/services/api'
import { Union } from '@/lib/types'
import { Note } from '@piano/shared'

// One place for every per-note cache HTTP call. All three verbs return the
// same `Config | null` shape (or error), so the caller can just drop the
// result into zustand without an ad-hoc discriminator.
export const NoteCacheService = {
  async set(
    noteId: string,
    dto: Note.CacheConfig.Set,
  ): Promise<Union.Variant<{ success: Note.CacheConfig.Config; error: { message: string } }>> {
    return apiClient<Note.CacheConfig.Config>(`/notes/${noteId}/cache`, {
      method: 'PUT',
      body: JSON.stringify(dto),
      headers: { 'Content-Type': 'application/json' },
    })
  },

  async toggle(
    noteId: string,
    dto: Note.CacheConfig.Toggle,
  ): Promise<Union.Variant<{ success: Note.CacheConfig.Config; error: { message: string } }>> {
    return apiClient<Note.CacheConfig.Config>(`/notes/${noteId}/cache/toggle`, {
      method: 'POST',
      body: JSON.stringify(dto),
      headers: { 'Content-Type': 'application/json' },
    })
  },

  async clear(
    noteId: string,
    modelId: string,
  ): Promise<Union.Variant<{ success: Note.CacheConfig.Config | null; error: { message: string } }>> {
    return apiClient<Note.CacheConfig.Config | null>(
      `/notes/${noteId}/cache/${encodeURIComponent(modelId)}`,
      { method: 'DELETE' },
    )
  },
}
