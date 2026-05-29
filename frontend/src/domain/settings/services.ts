import { apiClient } from '@/services/api'
import { Union } from '@/lib/types'
import { UserApiKey, LLM } from '@piano/shared'

export interface UserProfile {
  id: string
  email: string
  name: string | null
  defaultSystemPrompt: string | null
  createdAt: string
}

export interface UpdateProfileInput {
  name?: string
  defaultSystemPrompt?: string | null
}

export const SettingsService = {
  async getProfile(): Promise<Union.Variant<{
    success: UserProfile
    error: { message: string }
  }>> {
    return apiClient<UserProfile>('/user/profile')
  },

  async updateProfile(data: UpdateProfileInput): Promise<Union.Variant<{
    success: UserProfile
    error: { message: string }
  }>> {
    return apiClient<UserProfile>('/user/profile', {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  async getApiKeys(): Promise<Union.Variant<{
    success: { keys: UserApiKey.Model[] }
    error: { message: string }
  }>> {
    return apiClient<{ keys: UserApiKey.Model[] }>('/user/api-keys')
  },

  async upsertApiKey(
    provider: UserApiKey.Provider,
    apiKey: string
  ): Promise<Union.Variant<{
    success: { success: boolean; key: UserApiKey.Model }
    error: { message: string }
  }>> {
    return apiClient<{ success: boolean; key: UserApiKey.Model }>('/user/api-keys', {
      method: 'POST',
      body: JSON.stringify({ provider, apiKey }),
    })
  },

  async deleteApiKey(provider: UserApiKey.Provider): Promise<Union.Variant<{
    success: { success: boolean; provider: UserApiKey.Provider }
    error: { message: string }
  }>> {
    return apiClient<{ success: boolean; provider: UserApiKey.Provider }>(
      `/user/api-keys/${provider}`,
      { method: 'DELETE' }
    )
  },

  async setEnabledModels(
    provider: UserApiKey.Provider,
    modelIds: string[],
  ): Promise<Union.Variant<{
    success: { key: UserApiKey.Model }
    error: { message: string }
  }>> {
    return apiClient<{ key: UserApiKey.Model }>(
      `/user/api-keys/${provider}/models`,
      {
        method: 'PATCH',
        body: JSON.stringify({ modelIds }),
        headers: { 'Content-Type': 'application/json' },
      },
    )
  },

  async getActiveModels(): Promise<Union.Variant<{
    success: { models: LLM.Model[] }
    error: { message: string }
  }>> {
    return apiClient<{ models: LLM.Model[] }>('/user/active-models')
  },
}
