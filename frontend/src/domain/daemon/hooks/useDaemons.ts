import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Daemon } from '@piano/shared'
import { Union } from '@/lib/types'
import { DaemonService } from '../services'

const DAEMONS_KEY = ['daemons']

// Default poll cadence for surfaces that show live status (Settings tab).
// Other surfaces (canvas/sandbox pickers) opt out by passing pollingMs: false
// because they only need a snapshot when the picker opens.
const DEFAULT_POLLING_MS = 10_000

export function useDaemons(opts: { pollingMs?: number | false } = {}) {
  const queryClient = useQueryClient()
  const pollingMs = opts.pollingMs

  const { data: daemons = [], isLoading, error, refetch } = useQuery({
    queryKey: DAEMONS_KEY,
    queryFn: async (): Promise<Daemon.Model[]> => {
      const result = await DaemonService.list()
      return Union.match({
        success: (data) => data,
        error: () => [],
      }, result)
    },
    refetchInterval: pollingMs === false ? false : (pollingMs ?? false),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: DAEMONS_KEY })

  const createPairingCode = useMutation<Daemon.PairingCodeModel, Error, string>({
    mutationFn: async (name: string) => {
      const result = await DaemonService.createPairingCode(name)
      return Union.match({
        success: (data) => data,
        error: ({ message }) => { throw new Error(message) },
      }, result)
    },
    // Don't invalidate yet — the daemon row only appears AFTER the CLI redeems
    // the code; the polling interval will pick that up.
  })

  const rename = useMutation({
    mutationFn: async ({ daemonId, name }: { daemonId: string; name: string }) => {
      const result = await DaemonService.rename(daemonId, name)
      return Union.match({
        success: (data) => data,
        error: ({ message }) => { throw new Error(message) },
      }, result)
    },
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: async (daemonId: string) => {
      const result = await DaemonService.remove(daemonId)
      return Union.match({
        success: () => true,
        error: ({ message }) => { throw new Error(message) },
      }, result)
    },
    onSuccess: invalidate,
  })

  const cancelPairingCode = useMutation({
    mutationFn: async (code: string) => {
      const result = await DaemonService.cancelPairingCode(code)
      return Union.match({
        success: () => true,
        error: ({ message }) => { throw new Error(message) },
      }, result)
    },
  })

  const rotateToken = useMutation<Daemon.PairResult, Error, string>({
    mutationFn: async (daemonId: string) => {
      const result = await DaemonService.rotateToken(daemonId)
      return Union.match({
        success: (data) => data,
        error: ({ message }) => { throw new Error(message) },
      }, result)
    },
  })

  const setPaused = useMutation({
    mutationFn: async ({ daemonId, paused }: { daemonId: string; paused: boolean }) => {
      const result = paused
        ? await DaemonService.pause(daemonId)
        : await DaemonService.resume(daemonId)
      return Union.match({
        success: (data) => data,
        error: ({ message }) => { throw new Error(message) },
      }, result)
    },
    onSuccess: invalidate,
  })

  return {
    daemons,
    isLoading,
    error,
    refetch,
    createPairingCode: createPairingCode.mutateAsync,
    isCreatingCode: createPairingCode.isPending,
    cancelPairingCode: cancelPairingCode.mutateAsync,
    rename: rename.mutateAsync,
    isRenaming: rename.isPending,
    remove: remove.mutateAsync,
    isRemoving: remove.isPending,
    rotateToken: rotateToken.mutateAsync,
    setPaused: setPaused.mutateAsync,
  }
}

// Convenience selector for the Create-Machine modal — only daemons the user
// can actually use right now (status === 'online'). Pre-sorted by most
// recently active. Picker UIs need a snapshot on open, not live polling, so
// we explicitly disable refetchInterval here. The user can refresh by
// reopening the picker, or rely on the DaemonsTab's polling to invalidate
// the query when they go check status.
export function useOnlineDaemons() {
  const { daemons, isLoading } = useDaemons({ pollingMs: false })
  const online = daemons
    .filter(d => d.status === 'online')
    .sort((a, b) => {
      const ta = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0
      const tb = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0
      return tb - ta
    })
  return { onlineDaemons: online, isLoading }
}
