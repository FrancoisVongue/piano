import { apiClient } from '@/services/api'
import { Union } from '@/lib/types'
import { MachineTemplate, Secret } from '@piano/shared'

// Mirrors daemon/metrics.go:MachineMetrics (and backend's MachineMetrics).
// Frozen machines send zero/absent values for mem/cpu/ports; only uptime and
// disk usage are meaningful.
// Machine-level activity derived from the PTY stream (OSC 133 shell
// integration + the `piano` OSC primitive + bell). Agent-agnostic — it
// reflects whatever is running in the machine. See daemon/activity.go.
export type MachineActivity = {
  phase: string // "idle" | "running" | ""
  lastExitCode?: number
  signal?: string
  message?: string
  lastActivityAt?: string
  attentionAt?: string
}

// Container-level rollup over a machine's terminals (primary PTY + shared
// panes). Present only on the primary machine. `summary` is the loudest
// terminal; counts let the row say "2 running". A window is just a viewport
// over these terminals — it holds no state of its own.
export type MachineActivityGroup = {
  summary: MachineActivity
  running: number
  attention: number
  failed: number
  total: number
  terminals: { machineId: string; activity: MachineActivity }[]
}

export type MachineMetrics = {
  memUsageBytes: number
  memLimitBytes: number
  cpuPercent: number
  uptimeSeconds: number
  diskUsageBytes: number
  listeningPorts?: number[]
  state: string
  activity?: MachineActivity
  activityGroup?: MachineActivityGroup
  timestamp: string
}

export type ArrangementWithMachines = {
  id: string
  title: string
  pinned: boolean
  updatedAt: string
  notes: {
    id: string
    type: string
    machineId: string | null
    status: string | null
    label: string | null
    parentMachineNodeId: string | null
    metrics: MachineMetrics | null
  }[]
}

// Backend returns { success: T } or { error: { message } }.
// apiClient wraps the HTTP body as { success: body }.
// These helpers unwrap the double-nesting.

function unwrap<T>(result: Union.Variant<{ success: { success: T }; error: { message: string } }>): Union.Variant<{ success: T; error: { message: string } }> {
  if ('error' in result) return result as any
  return { success: (result as any).success.success }
}

export const TemplateService = {
  async fetchAll() {
    return unwrap<MachineTemplate.Model[]>(await apiClient('/templates'))
  },

  async saveFromMachine(data: MachineTemplate.DTO.SaveFromMachine) {
    return unwrap<MachineTemplate.Model>(await apiClient('/templates/save', {
      method: 'POST',
      body: JSON.stringify(data),
    }))
  },

  async createSandbox(templateId: string, daemonId: string, name?: string) {
    return unwrap<{ machineId: string; templateId: string; daemonId: string }>(await apiClient('/templates/sandbox', {
      method: 'POST',
      body: JSON.stringify({ templateId, daemonId, name }),
    }))
  },

  async createMachineFromTemplate(machineId: string, templateId: string, daemonId: string) {
    return unwrap<{ machineId: string; templateId: string; daemonId: string }>(await apiClient('/templates/create-machine', {
      method: 'POST',
      body: JSON.stringify({ machineId, templateId, daemonId }),
    }))
  },

  async cleanupSandbox(machineId: string, daemonId: string) {
    return apiClient(`/templates/sandbox/${machineId}/cleanup`, {
      method: 'POST',
      body: JSON.stringify({ daemonId }),
    })
  },

  async deleteTemplate(id: string) {
    return apiClient(`/templates/${id}`, { method: 'DELETE' })
  },
}

export const SecretService = {
  async fetchAll() {
    return unwrap<Secret.Model[]>(await apiClient('/secrets'))
  },

  async create(data: Secret.DTO.Create) {
    return unwrap<Secret.Model>(await apiClient('/secrets', {
      method: 'POST',
      body: JSON.stringify(data),
    }))
  },

  async update(id: string, data: Secret.DTO.Update) {
    return unwrap<Secret.Model>(await apiClient(`/secrets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }))
  },

  async delete(id: string) {
    return apiClient(`/secrets/${id}`, { method: 'DELETE' })
  },
}

export const MissionControlService = {
  async fetchArrangementsWithMachines() {
    return apiClient<ArrangementWithMachines[]>('/arrangements/machines')
  },

  async deleteAllMachinesInArrangement(arrangementId: string) {
    return unwrap<{ count: number }>(await apiClient(`/arrangements/${arrangementId}/machines`, {
      method: 'DELETE',
    }))
  },
}

// activate/deactivate live in MachineService (domain/machine/services.ts) now —
// kept single-source-of-truth so Canvas and Mission Control share the same API.
