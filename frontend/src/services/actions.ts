import { apiClient } from './api'
import { Union } from '@/lib/types'
import { Action } from '@piano/shared'

export const actionsService = {
  /**
   * Get all actions for the current user
   */
  async getAll(): Promise<Union.Variant<{
    success: Action.Model[];
    error: { message: string };
  }>> {
    return apiClient<Action.Model[]>('/actions')
  },

  /**
   * Get a specific action by ID
   */
  async getById(id: string): Promise<Union.Variant<{
    success: Action.Model;
    error: { message: string };
  }>> {
    return apiClient<Action.Model>(`/actions/${id}`)
  },

  /**
   * Create a new action
   */
  async create(data: Action.DTO.Create): Promise<Union.Variant<{
    success: Action.Model;
    error: { message: string };
  }>> {
    return apiClient<Action.Model>('/actions', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async seedDefaults(data: Action.DTO.Create[]): Promise<Union.Variant<{
    success: Action.Model[];
    error: { message: string };
  }>> {
    return apiClient<Action.Model[]>('/actions/seed-defaults', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  /**
   * Update an existing action
   */
  async update(id: string, data: Action.DTO.Update): Promise<Union.Variant<{
    success: Action.Model;
    error: { message: string };
  }>> {
    return apiClient<Action.Model>(`/actions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  /**
   * Delete an action
   */
  async delete(id: string): Promise<Union.Variant<{
    success: void;
    error: { message: string };
  }>> {
    return apiClient<void>(`/actions/${id}`, {
      method: 'DELETE',
    })
  },
}
