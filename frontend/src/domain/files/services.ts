import { apiClient } from '@/services/api'
import { Union } from '@/lib/types'
import { Files } from '@piano/shared'

// Backend wraps every payload as `{ success: T }`; apiClient wraps that again
// as `{ success: { success: T } }`. Strip one level so callers see clean Union.
function unwrap<T>(
  result: Union.Variant<{ success: { success: T }; error: { message: string; code?: number } }>,
): Union.Variant<{ success: T; error: { message: string; code?: number } }> {
  if ('error' in result) return result as any
  return { success: (result as any).success.success }
}

// FileService is the front-door to the daemon's filesystem view of one machine.
// Two endpoints, both daemon round-trips: the heavy lifting lives there.
export const FileService = {
  async list(machineId: string, path: string) {
    const qp = new URLSearchParams({ path })
    return unwrap<Files.ListResult>(
      await apiClient<{ success: Files.ListResult }>(`/files/${machineId}/list?${qp.toString()}`),
    )
  },

  async read(machineId: string, path: string, maxBytes?: number) {
    const qp = new URLSearchParams({ path })
    if (maxBytes != null) qp.set('maxBytes', String(maxBytes))
    return unwrap<Files.ReadResult>(
      await apiClient<{ success: Files.ReadResult }>(`/files/${machineId}/read?${qp.toString()}`),
    )
  },
}
