import { create } from 'zustand'
import { toast } from 'sonner'
import { MachineTemplate, Secret } from '@piano/shared'
import { Union } from '@/lib/types'
import { TemplateService, SecretService, MissionControlService, type ArrangementWithMachines, type MachineMetrics, type MachineActivity, type MachineActivityGroup } from './services'
import { MachineService } from '@/domain/machine/services'

/**
 * Port forwards open TCP listeners on the DAEMON host, not the user's
 * browser host. On localhost-dev that's the same box so `localhost:PORT`
 * works. On a hosted deployment the daemon lives on a server the user
 * doesn't necessarily have network access to, so forwarding to the base
 * machine silently fails from the browser's perspective. Heuristic:
 * anything that isn't loopback / .local is probably remote and deserves
 * a warning. Not destructive — the user can still try — just makes the
 * constraint visible.
 */
function isLikelyRemoteDaemon(): boolean {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname
  if (!host) return false
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false
  if (host.endsWith('.local')) return false
  return true
}

export interface MachineCenterState {
  // Templates
  templates: MachineTemplate.Model[]
  isLoadingTemplates: boolean

  // Sandbox
  sandboxMachineId: string | null
  sandboxTemplateId: string | null
  sandboxDaemonId: string | null
  isSandboxOpen: boolean

  // Mission Control
  arrangementsWithMachines: ArrangementWithMachines[]
  isLoadingMachines: boolean

  // Port forwarding — single-active across the whole app (Canvas + Mission Control).
  // Mirrors daemon's PortForwarder.activeId; set by activateForward(), cleared
  // by deactivateForward(). `label` is best-effort display text (node label).
  activeForward: { machineId: string; ports: number[]; label?: string } | null

  // Secrets
  secrets: Secret.Model[]
  isLoadingSecrets: boolean

  // Sandbox draft (form is open but no machine created yet)
  sandboxDraftTemplateId: string | null

  // Actions
  fetchTemplates: () => Promise<void>
  fetchMachines: () => Promise<void>
  fetchSecrets: () => Promise<void>

  // Live activity patch from the machine:activity SSE event — updates just the
  // matching machine note's metrics so the canvas/Mission Control reflect it
  // without a full refetch.
  applyActivity: (machineId: string, activity?: MachineActivity, group?: MachineActivityGroup) => void

  deleteAllMachinesInArrangement: (arrangementId: string) => Promise<boolean>
  deleteMachineFromArrangement: (arrangementId: string, noteId: string) => Promise<boolean>

  // Port forwarding. activateForward toggles: calling it with the
  // already-active machineId deactivates instead of re-activating.
  // The auto-refresh loop goes through refreshActiveForward directly,
  // so there's no need for a "silent" variant of activate.
  activateForward: (machineId: string, label?: string) => Promise<boolean>
  deactivateForward: () => Promise<void>
  /** Re-activate the current forward if the machine's listening ports drifted. */
  refreshActiveForward: () => Promise<void>

  openSandboxForm: (templateId?: string) => void
  startSandbox: (templateId: string | undefined, daemonId: string, name?: string) => Promise<string | null>
  saveSandboxAsTemplate: (name: string, description?: string) => Promise<MachineTemplate.Model | null>
  closeSandbox: () => Promise<void>

  deleteTemplate: (id: string) => Promise<boolean>

  createSecret: (key: string, value: string) => Promise<boolean>
  updateSecret: (id: string, value: string) => Promise<boolean>
  deleteSecret: (id: string) => Promise<boolean>
}

// Auto-refresh tick for the active port-forward. Set when activateForward
// succeeds, cleared when deactivateForward runs. Keeps the forward in sync
// with processes that start or die inside the machine — the user no longer
// has to click "Forward ports" a second time to pick up new listeners.
// Fast poll — re-probing listening ports is a single podman exec + a
// `ss -tlnp` parse on the daemon. Cheap. 3 s gives near-instant feedback
// when the user kills or (re)starts a server inside the container.
const AUTO_REFRESH_MS = 3_000
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
}

function startAutoRefresh(refresh: () => Promise<void>) {
  stopAutoRefresh()
  autoRefreshTimer = setInterval(() => { void refresh() }, AUTO_REFRESH_MS)
}

export const useMachineCenterStore = create<MachineCenterState>((set, get) => ({
  templates: [],
  isLoadingTemplates: false,
  sandboxMachineId: null,
  sandboxTemplateId: null,
  sandboxDaemonId: null,
  sandboxDraftTemplateId: null,
  isSandboxOpen: false,
  arrangementsWithMachines: [],
  isLoadingMachines: false,
  activeForward: null,
  secrets: [],
  isLoadingSecrets: false,

  fetchTemplates: async () => {
    set({ isLoadingTemplates: true })
    const result = await TemplateService.fetchAll()
    Union.match({
      success: (templates) => set({ templates, isLoadingTemplates: false }),
      error: () => set({ isLoadingTemplates: false }),
    }, result)
  },

  deleteAllMachinesInArrangement: async (arrangementId) => {
    const result = await MissionControlService.deleteAllMachinesInArrangement(arrangementId)
    return Union.match({
      success: () => {
        set((s) => ({
          arrangementsWithMachines: s.arrangementsWithMachines.map(a =>
            a.id === arrangementId ? { ...a, notes: [] } : a
          ),
        }))
        return true
      },
      error: ({ message }) => {
        toast.error(message || 'Failed to delete machines')
        return false
      },
    }, result)
  },

  deleteMachineFromArrangement: async (arrangementId, noteId) => {
    const arrangement = get().arrangementsWithMachines.find(a => a.id === arrangementId)
    const target = arrangement?.notes.find(n => n.id === noteId)
    const terminalChildren = target?.type === 'MACHINE'
      ? arrangement?.notes.filter(n => n.type === 'TERMINAL' && n.parentMachineNodeId === noteId) ?? []
      : []
    const machineChildren = target?.type === 'MACHINE'
      ? arrangement?.notes.filter(n => n.type === 'MACHINE' && n.parentMachineNodeId === noteId) ?? []
      : []
    const idsToDelete = [noteId, ...terminalChildren.map(n => n.id)]
    const idsToDetach = machineChildren.map(n => n.id)

    // Canvas delete has the same policy: remove the machine and its terminal
    // sessions, but keep branch MACHINE children as independent clones.
    const { ArrangementService } = await import('@/domain/arrangement/services')
    const result = await ArrangementService.patch(arrangementId, {
      dirtyNodes: idsToDetach.map(id => ({
        id,
        type: 'MACHINE' as const,
        parentMachineNodeId: null,
      })),
      dirtyEdges: [],
      deletedNodeIds: idsToDelete,
      deletedEdgeIds: [],
      demotedNodeIds: [],
    })
    return Union.match({
      success: ({ failed }) => {
        const failedIds = new Set(failed.map((f: { id: string }) => f.id))
        const targetFailure = failed.find((f: { id: string; reason: string }) => f.id === noteId)
        if (targetFailure) {
          toast.error(targetFailure.reason || 'Delete failed')
          return false
        }
        const secondaryFailure = failed.find((f: { id: string }) =>
          idsToDelete.includes(f.id) || idsToDetach.includes(f.id)
        )
        if (secondaryFailure) {
          toast.error('Machine deleted, but some child cleanup failed')
        }

        const removedIds = new Set(idsToDelete.filter(id => !failedIds.has(id)))
        const detachedIds = new Set(idsToDetach.filter(id => !failedIds.has(id)))
        set((s) => ({
          arrangementsWithMachines: s.arrangementsWithMachines.map(a =>
            a.id === arrangementId
              ? {
                  ...a,
                  notes: a.notes
                    .filter(n => !removedIds.has(n.id))
                    .map(n => detachedIds.has(n.id) ? { ...n, parentMachineNodeId: null } : n),
                }
              : a
          ),
        }))
        const activeForward = get().activeForward
        if (
          activeForward &&
          [...terminalChildren, target].some(n => n?.machineId === activeForward.machineId)
        ) {
          void get().deactivateForward()
        }
        return true
      },
      error: ({ message }) => {
        toast.error(message || 'Failed to delete machine')
        return false
      },
    }, result)
  },

  fetchMachines: async () => {
    set({ isLoadingMachines: true })
    const result = await MissionControlService.fetchArrangementsWithMachines()
    Union.match({
      success: (data) => set({ arrangementsWithMachines: data, isLoadingMachines: false }),
      error: () => set({ isLoadingMachines: false }),
    }, result)
  },

  applyActivity: (machineId, activity, group) =>
    set((s) => ({
      // Only rebuild the arrangement that holds this machine (and only its
      // matching note) so selectors for other machines keep stable refs and
      // don't re-render on every activity tick.
      arrangementsWithMachines: s.arrangementsWithMachines.map(arr =>
        arr.notes.some(n => n.machineId === machineId)
          ? {
              ...arr,
              notes: arr.notes.map(n =>
                n.machineId === machineId
                  ? { ...n, metrics: { ...(n.metrics ?? {}), activity, activityGroup: group } as MachineMetrics }
                  : n,
              ),
            }
          : arr,
      ),
    })),

  // Port forwarding as a *sticky subscription*. Click Activate and the
  // store latches onto a machineId — it does NOT matter whether the
  // machine is currently listening on anything. A 3-second poll then
  // drives the `ports` field: ports come and go, the subscription
  // stays. User explicitly clicks the X to stop.
  //
  // activate() and the polling tick share one code path — `syncPorts`
  // below. That's the whole reason this block is short.
  activateForward: async (machineId, label) => {
    const prev = get().activeForward
    // Toggle: click on the same machine = deactivate.
    if (prev?.machineId === machineId) {
      await get().deactivateForward()
      return true
    }
    // Latch immediately with empty ports — UI shows "waiting" state
    // instantly even if the probe below takes a moment or fails.
    set({ activeForward: { machineId, ports: [], label: label ?? prev?.label } })
    startAutoRefresh(() => get().refreshActiveForward())
    if (isLikelyRemoteDaemon()) {
      toast.warning(
        `Ports will open on daemon host (${window.location.hostname}), not your local machine. Tunnel through SSH if you need browser access.`,
        { duration: 8000 },
      )
    }
    // First probe runs through the same path the timer uses.
    return get().refreshActiveForward().then(() => true)
  },

  deactivateForward: async () => {
    stopAutoRefresh()
    const machineId = get().activeForward?.machineId
    if (!machineId) {
      set({ activeForward: null })
      return
    }
    const result = await MachineService.deactivate(machineId)
    set({ activeForward: null })
    Union.match({
      success: () => toast.success('Forwarding stopped'),
      error: ({ message }) => toast.error(`Daemon error: ${message}. Cleared locally.`),
    }, result)
  },

  // The one place that actually talks to the daemon about ports.
  // Invoked immediately by activateForward and then every 3 s by the
  // interval. Transitions drive toasts:
  //   [] → [3000]     "Now forwarding :3000"   (server came up)
  //   [3000] → []     "Ports stopped listening" (server died)
  //   [3000] → [3001] silent update
  // The subscription never self-cancels — only deactivateForward does.
  refreshActiveForward: async () => {
    const { activeForward } = get()
    if (!activeForward) return
    const result = await MachineService.activate(activeForward.machineId)
    const nextPorts = Union.match<{ success: { ports: number[] }; error: { message: string; code?: number } }, number[]>({
      success: ({ ports }): number[] => ports,
      // "no listening" is the expected idle state, not an error.
      // Other errors (daemon reconnect, container restart) → keep the
      // last known ports so we don't flicker; the next tick recovers.
      error: ({ message }): number[] =>
        message.includes('no listening') ? [] : activeForward.ports,
    }, result)

    const prev = activeForward.ports
    const same =
      nextPorts.length === prev.length &&
      nextPorts.every((p, i) => p === prev[i])
    if (same) return

    set({ activeForward: { ...activeForward, ports: nextPorts } })

    const label = activeForward.label || activeForward.machineId.slice(0, 12)
    if (prev.length === 0 && nextPorts.length > 0) {
      toast.success(`Now forwarding ${nextPorts.map((p) => `:${p}`).join(' ')} (${label})`)
    } else if (prev.length > 0 && nextPorts.length === 0) {
      toast.info(`${label}: no listening ports — still watching`)
    }
  },

  fetchSecrets: async () => {
    set({ isLoadingSecrets: true })
    const result = await SecretService.fetchAll()
    Union.match({
      success: (secrets) => set({ secrets, isLoadingSecrets: false }),
      error: () => set({ isLoadingSecrets: false }),
    }, result)
  },

  // Open the sandbox panel in form mode (no machine created yet).
  openSandboxForm: (templateId) => {
    set({
      isSandboxOpen: true,
      sandboxDraftTemplateId: templateId || null,
      sandboxMachineId: null,
      sandboxTemplateId: null,
      sandboxDaemonId: null,
    })
  },

  startSandbox: async (templateId, daemonId, name) => {
    const result = await TemplateService.createSandbox(templateId || '', daemonId, name)
    return Union.match({
      success: ({ machineId }) => {
        set({
          sandboxMachineId: machineId,
          sandboxTemplateId: templateId || null,
          sandboxDaemonId: daemonId,
          sandboxDraftTemplateId: null,
          isSandboxOpen: true,
        })
        return machineId
      },
      error: () => null,
    }, result)
  },

  saveSandboxAsTemplate: async (name, description) => {
    const { sandboxMachineId, sandboxTemplateId } = get()
    if (!sandboxMachineId) return null

    const result = await TemplateService.saveFromMachine({
      machineId: sandboxMachineId,
      name,
      description,
      parentTemplateId: sandboxTemplateId || undefined,
    })

    return Union.match({
      success: (template) => {
        set((s) => ({
          templates: [template, ...s.templates],
          sandboxMachineId: null,
          sandboxTemplateId: null,
          sandboxDaemonId: null,
          isSandboxOpen: false,
        }))
        return template
      },
      error: () => null,
    }, result)
  },

  closeSandbox: async () => {
    const { sandboxMachineId, sandboxDaemonId } = get()
    if (sandboxMachineId && sandboxDaemonId) {
      await TemplateService.cleanupSandbox(sandboxMachineId, sandboxDaemonId)
    }
    set({
      sandboxMachineId: null,
      sandboxTemplateId: null,
      sandboxDaemonId: null,
      sandboxDraftTemplateId: null,
      isSandboxOpen: false,
    })
  },

  deleteTemplate: async (id) => {
    const result = await TemplateService.deleteTemplate(id)
    return Union.match({
      success: () => {
        set((s) => ({ templates: s.templates.filter(t => t.id !== id) }))
        return true
      },
      error: () => false,
    }, result)
  },

  createSecret: async (key, value) => {
    const result = await SecretService.create({ key, value })
    return Union.match({
      success: (secret) => {
        set((s) => ({
          secrets: [secret, ...s.secrets.filter(sec => sec.key !== key)],
        }))
        return true
      },
      error: () => false,
    }, result)
  },

  updateSecret: async (id, value) => {
    const result = await SecretService.update(id, { value })
    return Union.match({
      success: (secret) => {
        set((s) => ({
          secrets: s.secrets.map(sec => sec.id === id ? secret : sec),
        }))
        return true
      },
      error: () => false,
    }, result)
  },

  deleteSecret: async (id) => {
    const result = await SecretService.delete(id)
    return Union.match({
      success: () => {
        set((s) => ({ secrets: s.secrets.filter(sec => sec.id !== id) }))
        return true
      },
      error: () => false,
    }, result)
  },
}))

// Selector: the latest cached daemon metrics for a machine id, scanned out of
// the Mission Control projection. Returns the stored metrics object as-is (a
// stable reference) so subscribers re-render only when that machine's metrics
// actually change. Used by the canvas (MachineNode header + pane chrome) to
// show activity; keep it fed with useMachineActivityFeed.
export const selectMachineMetrics =
  (machineId: string | null | undefined) =>
  (s: MachineCenterState): MachineMetrics | null => {
    if (!machineId) return null
    for (const arr of s.arrangementsWithMachines) {
      for (const note of arr.notes) {
        if (note.machineId === machineId) return note.metrics
      }
    }
    return null
  }
