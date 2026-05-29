import { apiClient } from '@/services/api'
import { Union } from '@/lib/types'

export type NoteRun = {
  id: string
  noteId: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  createdAt: string
}

export const NoteRunsService = {
  // Latest Run row for a note. Backend returns 204 when none exists, which
  // the api client maps to `{ success: null }` (see apiClient conventions).
  async latest(noteId: string): Promise<Union.Variant<{
    success: { run: NoteRun } | null
    error: { message: string }
  }>> {
    return apiClient<{ run: NoteRun } | null>(`/notes/${noteId}/latest-run`)
  },
}
