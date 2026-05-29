import { apiClient } from './api'
import { Union } from '@/lib/types'
import { Workflow } from '@piano/shared'

export const workflowsService = {
  async getAll(): Promise<Union.Variant<{
    success: Workflow.Model[]
    error: { message: string }
  }>> {
    return apiClient<Workflow.Model[]>('/workflows')
  },

  async getById(id: string): Promise<Union.Variant<{
    success: Workflow.Model
    error: { message: string }
  }>> {
    return apiClient<Workflow.Model>(`/workflows/${id}`)
  },

  async create(data: Workflow.DTO.Create): Promise<Union.Variant<{
    success: Workflow.Model
    error: { message: string }
  }>> {
    return apiClient<Workflow.Model>('/workflows', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async update(id: string, data: Workflow.DTO.Update): Promise<Union.Variant<{
    success: Workflow.Model
    error: { message: string }
  }>> {
    return apiClient<Workflow.Model>(`/workflows/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  async delete(id: string): Promise<Union.Variant<{
    success: { id: string }
    error: { message: string }
  }>> {
    return apiClient<{ id: string }>(`/workflows/${id}`, { method: 'DELETE' })
  },

  /**
   * Trigger a workflow against a target node. Backend returns 202 Accepted
   * with { runId }; result nodes flow in over SSE as the orchestrator
   * makes progress.
   */
  async run(
    id: string,
    body: { targetNoteId: string; model: string },
  ): Promise<Union.Variant<{
    success: { runId: string; workflowId: string; targetNoteId: string }
    error: { message: string }
  }>> {
    return apiClient<{ runId: string; workflowId: string; targetNoteId: string }>(
      `/workflows/${id}/run`,
      { method: 'POST', body: JSON.stringify(body) },
    )
  },
}
