import { apiClient } from '@/services/api'
import { Union } from '@/lib/types'

// Backend returns `{ success: T }` in the body; apiClient wraps it as
// `{ success: { success: T } }`. This helper strips one level so callers
// see a clean `{ success: T }` Union.
function unwrap<T>(
  result: Union.Variant<{ success: { success: T }; error: { message: string; code?: number } }>
): Union.Variant<{ success: T; error: { message: string; code?: number } }> {
  if ('error' in result) return result as any
  return { success: (result as any).success.success }
}

export const MachineService = {
  async freeze(machineId: string, name?: string) {
    return unwrap<{
      machineId: string
      templateId: string
      templateName: string
      deletedNoteIds: string[]
      arrangementId: string | null
    }>(await apiClient(`/machines/${machineId}/freeze`, {
      method: 'POST',
      body: name ? JSON.stringify({ name }) : undefined,
    }))
  },

  async branch(machineId: string, childId: string, machineName?: string) {
    return unwrap<{ machineId: string; parentId: string; daemonId: string | null }>(
      await apiClient(`/machines/${machineId}/branch`, {
        method: 'POST',
        body: JSON.stringify({ childId, machineName }),
      })
    )
  },

  async share(machineId: string, childId: string) {
    return unwrap<{ machineId: string; parentId: string; daemonId: string | null }>(
      await apiClient(`/machines/${machineId}/share`, {
        method: 'POST',
        body: JSON.stringify({ childId }),
      })
    )
  },

  async activate(machineId: string) {
    return unwrap<{ machineId: string; ports: number[] }>(await apiClient(`/machines/${machineId}/activate`, {
      method: 'POST',
    }))
  },

  async deactivate(machineId: string) {
    return unwrap<boolean>(await apiClient('/machines/deactivate', {
      method: 'POST',
      body: JSON.stringify({ machineId }),
    }))
  },

  // In-window pane lifecycle (same daemon substrate as `share`, but no
  // canvas Note row created — the pane is layout state in MachineWindow).
  async spawnPane(parentMachineId: string, paneId: string) {
    return unwrap<{ paneId: string; parentId: string; daemonId: string | null }>(
      await apiClient(`/machines/${parentMachineId}/panes`, {
        method: 'POST',
        body: JSON.stringify({ paneId }),
      }),
    )
  },

  async closePane(parentMachineId: string, paneId: string) {
    return unwrap<{ paneId: string }>(
      await apiClient(`/machines/${parentMachineId}/panes/${paneId}`, {
        method: 'DELETE',
      }),
    )
  },
}
