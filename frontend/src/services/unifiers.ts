import { apiClient } from './api'
import { Union } from '@/lib/types'
import { Unifier } from '@piano/shared'

export const unifersService = {
  /**
   * Get all unifiers for the current user
   */
  async getAll(): Promise<Union.Variant<{
    success: Unifier.Model[];
    error: { message: string };
  }>> {
    return apiClient<Unifier.Model[]>('/unifiers')
  },

  /**
   * Get a specific unifier by ID
   */
  async getById(id: string): Promise<Union.Variant<{
    success: Unifier.Model;
    error: { message: string };
  }>> {
    return apiClient<Unifier.Model>(`/unifiers/${id}`)
  },

  /**
   * Create a new unifier
   */
  async create(data: Unifier.DTO.Create): Promise<Union.Variant<{
    success: Unifier.Model;
    error: { message: string };
  }>> {
    return apiClient<Unifier.Model>('/unifiers', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  /**
   * Update an existing unifier
   */
  async update(id: string, data: Unifier.DTO.Update): Promise<Union.Variant<{
    success: Unifier.Model;
    error: { message: string };
  }>> {
    return apiClient<Unifier.Model>(`/unifiers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  /**
   * Delete a unifier
   */
  async delete(id: string): Promise<Union.Variant<{
    success: void;
    error: { message: string };
  }>> {
    return apiClient<void>(`/unifiers/${id}`, {
      method: 'DELETE',
    })
  },
}
