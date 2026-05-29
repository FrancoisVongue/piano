import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { ArrangementService } from '../services'
import { Union } from '@/lib/types'
import { Arrangement } from '@piano/shared'
import { clearSavedViewport } from '@/domain/canvas/lib/viewport-persistence'
import { Analytics } from '@/lib/analytics'

const mergeArrangementSnapshot = (
  current: Arrangement.Model | null | undefined,
  updated: Arrangement.Model,
): Arrangement.Model => {
  if (!current) return updated

  return {
    ...current,
    ...updated,
    notes: updated.notes ?? current.notes,
    edges: updated.edges ?? current.edges,
    _count: updated._count ?? current._count,
  }
}

const applyArrangementUpdateToCache = (
  queryClient: QueryClient,
  updated: Arrangement.Model,
) => {
  queryClient.setQueryData<Arrangement.Model[]>(['arrangements'], (current) => {
    if (!current) return current
    return current.map((arrangement) =>
      arrangement.id === updated.id
        ? mergeArrangementSnapshot(arrangement, updated)
        : arrangement,
    )
  })

  queryClient.setQueryData<Arrangement.Model | null>(['arrangement', updated.id], (current) => {
    if (!current) return current
    return mergeArrangementSnapshot(current, updated)
  })
}

export function useArrangements() {
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['arrangements'],
    queryFn: async () => {
      const result = await ArrangementService.fetchAll()
      return Union.match({
        success: (data) => data,
        error: (err) => {
          throw new Error(err.message)
        }
      }, result)
    }
  })

  const createMutation = useMutation({
    mutationFn: async (
      input: string | { title: string; tags?: string[] },
    ): Promise<Arrangement.Model> => {
      const result = await ArrangementService.create(input)
      if ('error' in result && result.error) throw new Error(result.error.message)
      if (!('success' in result) || !result.success) throw new Error('Create returned empty response')
      return result.success
    },
    onSuccess: () => {
      // Create must INSERT a new row; the cache-merge helper only patches
      // existing entries (it's for field updates), so a fresh arrangement
      // would never appear until a refetch. Invalidate to pull it in.
      queryClient.invalidateQueries({ queryKey: ['arrangements'] })
    }
  })

  const updateMutation = useMutation({
    mutationFn: async ({ id, updateData }: { id: string; updateData: Arrangement.DTO.Update }) => {
      const result = await ArrangementService.update(id, updateData)
      return Union.match({
        success: (data) => data,
        error: (err) => {
          throw new Error(err.message)
        }
      }, result)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['arrangements'] })
    }
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const result = await ArrangementService.deleteArrangement(id)
      return Union.match({
        success: () => undefined,
        error: (err) => {
          throw new Error(err.message)
        }
      }, result)
    },
    onSuccess: (_data, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['arrangements'] })
      // Clean up the per-arrangement viewport from localStorage so it doesn't
      // accumulate forever. Cheap, synchronous, best-effort.
      clearSavedViewport(deletedId)
    }
  })

  const importMutation = useMutation({
    mutationFn: async (doc: Arrangement.ExportDoc.Document): Promise<{ id: string; title: string }> => {
      const result = await ArrangementService.importFromDocument(doc)
      if ('error' in result && result.error) throw new Error(result.error.message)
      if (!('success' in result) || !result.success) throw new Error('Import returned empty response')
      return result.success
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['arrangements'] })
    }
  })

  const createArrangement = async (input: string | { title: string; tags?: string[] }) => {
    try {
      const created = await createMutation.mutateAsync(input)
      const body = typeof input === 'string' ? { tags: [] } : input
      Analytics.track('arrangement_created', {
        arrangementId: created.id,
        tagCount: body.tags?.length ?? 0,
      })
      return { success: true as const, data: created }
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : 'Failed to create' }
    }
  }

  const updateArrangement = async (id: string, updateData: Arrangement.DTO.Update) => {
    try {
      await updateMutation.mutateAsync({ id, updateData })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update' }
    }
  }

  const deleteArrangement = async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete' }
    }
  }

  const importArrangement = async (doc: Arrangement.ExportDoc.Document) => {
    try {
      const result = await importMutation.mutateAsync(doc)
      Analytics.track('arrangement_imported', {
        arrangementId: result.id,
        noteCount: doc.notes.length,
        edgeCount: doc.edges.length,
      })
      return { success: true as const, data: result }
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : 'Failed to import' }
    }
  }

  return {
    arrangements: (data || []) as Arrangement.Model[],
    isLoading,
    error: error?.message || null,
    createArrangement,
    updateArrangement,
    deleteArrangement,
    importArrangement,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isImporting: importMutation.isPending,
  }
}

export function useArrangement(id: string | null) {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['arrangement', id],
    queryFn: async () => {
      if (!id) return null
      const result = await ArrangementService.fetchById(id)
      return Union.match({
        success: (data) => data,
        error: (err) => {
          throw new Error(err.message)
        }
      }, result)
    },
    enabled: !!id,
    // Don't refetch on window focus or reconnect — the canvas is kept in sync
    // via the optimistic /patch endpoint, and background refetches were yanking
    // the viewport back to "last edited note" every time the tab regained focus.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // But DO refetch when the hook mounts under a new arrangement id. Without
    // this, switching tabs returns the cached snapshot from the last visit
    // and ignores edits made in the meantime (own or remote).
    refetchOnMount: 'always',
    staleTime: Infinity,
  })

  useEffect(() => {
    const visited = data as Arrangement.Model | null | undefined
    if (!visited) return
    queryClient.setQueryData<Arrangement.Model[]>(['arrangements'], (current) => {
      if (!current) return current
      return current.map((arrangement) =>
        arrangement.id === visited.id
          ? { ...arrangement, lastVisitedAt: visited.lastVisitedAt }
          : arrangement,
      )
    })
  }, [data, queryClient])

  const updateFieldMutation = useMutation({
    mutationFn: async (updateData: Arrangement.DTO.Update): Promise<Arrangement.Model> => {
      if (!id) throw new Error('No arrangement selected')
      const result = await ArrangementService.update(id, updateData)
      return Union.match({
        success: (data) => data,
        error: (err) => { throw new Error(err.message) }
      }, result)
    },
    onSuccess: (updated) => {
      applyArrangementUpdateToCache(queryClient, updated)
    }
  })

  const updateArrangementField = async (updateData: Arrangement.DTO.Update) => {
    try {
      await updateFieldMutation.mutateAsync(updateData)
    } catch (error) {
      console.error('Failed to update arrangement field:', error)
    }
  }

  const runMutation = useMutation({
    mutationFn: async (data: Arrangement.DTO.ExecuteAction) => {
      if (!id) throw new Error('No arrangement selected')
      const result = await ArrangementService.executeAction(id, data)
      return Union.match({
        success: (data) => data,
        error: (err) => {
          throw new Error(err.message)
        }
      }, result)
    }
  })

  const runArrangement = async (data: Arrangement.DTO.ExecuteAction) => {
    try {
      const result = await runMutation.mutateAsync(data)
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to run' }
    }
  }

  return {
    arrangement: (data || null) as Arrangement.Model | null,
    isLoading,
    error: error?.message || null,
    updateArrangementField,
    runArrangement,
    isRunning: runMutation.isPending
  }
}
