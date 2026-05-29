import { apiClient } from '@/services/api'
import { Union } from '@/lib/types'
import { Daemon } from '@piano/shared'

// Backend wraps responses as `{ success: T }`; apiClient wraps that as
// `{ success: { success: T } }`. Strip one level so callers see a clean Union.
function unwrap<T>(
  result: Union.Variant<{ success: { success: T }; error: { message: string; code?: number } }>
): Union.Variant<{ success: T; error: { message: string; code?: number } }> {
  if ('error' in result) return result as any
  return { success: (result as any).success.success }
}

export const DaemonService = {
  async list() {
    return unwrap<Daemon.Model[]>(await apiClient('/daemons'))
  },

  // Step 1 of pairing — returns the one-time PIANO-XXXX-XXXX code that the
  // user pastes into the daemon CLI (`piano-daemon pair <code>`).
  async createPairingCode(name: string) {
    return unwrap<Daemon.PairingCodeModel>(await apiClient('/daemons/pair-codes', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }))
  },

  async rename(daemonId: string, name: string) {
    return unwrap<Daemon.Model>(await apiClient(`/daemons/${daemonId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }))
  },

  async remove(daemonId: string) {
    return unwrap<boolean>(await apiClient(`/daemons/${daemonId}`, {
      method: 'DELETE',
    }))
  },

  async cancelPairingCode(code: string) {
    return unwrap<boolean>(await apiClient(`/daemons/pair-codes/${encodeURIComponent(code)}`, {
      method: 'DELETE',
    }))
  },

  async rotateToken(daemonId: string) {
    return unwrap<Daemon.PairResult>(await apiClient(`/daemons/${daemonId}/rotate-token`, {
      method: 'POST',
    }))
  },

  async pause(daemonId: string) {
    return unwrap<Daemon.Model>(await apiClient(`/daemons/${daemonId}/pause`, {
      method: 'POST',
    }))
  },

  async resume(daemonId: string) {
    return unwrap<Daemon.Model>(await apiClient(`/daemons/${daemonId}/resume`, {
      method: 'POST',
    }))
  },

  async sshInfo(machineId: string) {
    return unwrap<Daemon.SshInfo>(await apiClient(`/machines/${machineId}/ssh-info`))
  },
}
