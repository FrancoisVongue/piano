import { create } from 'zustand'
import { Workflow } from '@piano/shared'
import { workflowsService } from '@/services/workflows'
import { Union } from '@/lib/types'

// -----------------------------------------------------------------------------
// Workflow store — same shape as the actions store. Holds the canonical
// workflow list + create/update/delete actions that round-trip the API.
//
// Run is a separate action, not a CRUD op — kicks off backend execution
// (via NATS → Temporal orchestrator) and returns immediately. New nodes
// from the workflow's levels stream in via the canvas SSE pipe, exactly
// like Action runs.
// -----------------------------------------------------------------------------

interface WorkflowsState {
  workflows: Workflow.Model[]
  isLoading: boolean
  error: string | null
  isCreating: boolean
  isUpdating: boolean
  isDeleting: boolean
  isRunning: boolean

  fetch: () => Promise<void>
  create: (data: Workflow.DTO.Create) => Promise<{ success: boolean; error?: string; workflow?: Workflow.Model }>
  update: (id: string, data: Workflow.DTO.Update) => Promise<{ success: boolean; error?: string }>
  remove: (id: string) => Promise<{ success: boolean; error?: string }>
  run: (id: string, args: { targetNoteId: string; model: string }) => Promise<{ success: boolean; error?: string; runId?: string }>
}

export const useWorkflowsStore = create<WorkflowsState>((set, get) => ({
  workflows: [],
  isLoading: false,
  error: null,
  isCreating: false,
  isUpdating: false,
  isDeleting: false,
  isRunning: false,

  fetch: async () => {
    if (get().isLoading) return
    set({ isLoading: true, error: null })
    const result = await workflowsService.getAll()
    Union.match({
      success: (data) => set({ workflows: data, isLoading: false }),
      error: (err) => set({ error: err.message, isLoading: false }),
    }, result)
  },

  create: async (data) => {
    set({ isCreating: true })
    const result = await workflowsService.create(data)
    return Union.match({
      success: (wf) => {
        set(s => ({ workflows: [wf, ...s.workflows], isCreating: false }))
        return { success: true as const, workflow: wf }
      },
      error: (err) => {
        set({ isCreating: false })
        return { success: false as const, error: err.message }
      },
    }, result)
  },

  update: async (id, data) => {
    set({ isUpdating: true })
    const result = await workflowsService.update(id, data)
    return Union.match({
      success: (wf) => {
        set(s => ({
          workflows: s.workflows.map(w => w.id === id ? wf : w),
          isUpdating: false,
        }))
        return { success: true as const }
      },
      error: (err) => {
        set({ isUpdating: false })
        return { success: false as const, error: err.message }
      },
    }, result)
  },

  remove: async (id) => {
    set({ isDeleting: true })
    const result = await workflowsService.delete(id)
    return Union.match({
      success: () => {
        set(s => ({
          workflows: s.workflows.filter(w => w.id !== id),
          isDeleting: false,
        }))
        return { success: true as const }
      },
      error: (err) => {
        set({ isDeleting: false })
        return { success: false as const, error: err.message }
      },
    }, result)
  },

  run: async (id, args) => {
    set({ isRunning: true })
    const result = await workflowsService.run(id, args)
    return Union.match({
      success: (data) => {
        set({ isRunning: false })
        return { success: true as const, runId: data.runId }
      },
      error: (err) => {
        set({ isRunning: false })
        return { success: false as const, error: err.message }
      },
    }, result)
  },
}))

// Stable per-session id generator for level rows. Only needs uniqueness
// within one workflow; cross-workflow collisions are fine.
export const newLevelId = (): string =>
  `lv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
