import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { SettingsService, UserProfile, UpdateProfileInput } from '../services'
import { Union } from '@/lib/types'
import { UserApiKey, LLM } from '@piano/shared'

const PROFILE_KEY = ['user', 'profile']
const API_KEYS_KEY = ['user', 'api-keys']
const ACTIVE_MODELS_KEY = ['user', 'active-models']

// Shared invalidator: any mutation that changes what the user can run
// (key upsert, key delete, enabled-models edit) must refresh both lists
// so the canvas dropdown updates in the same tick as the settings page.
const invalidateKeysAndModels = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: API_KEYS_KEY })
  qc.invalidateQueries({ queryKey: ACTIVE_MODELS_KEY })
}

export function useUserProfile() {
  const queryClient = useQueryClient()

  const { data: profile, isLoading, error } = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: async (): Promise<UserProfile | null> => {
      const result = await SettingsService.getProfile()
      return Union.match({
        success: (data) => data,
        error: () => null,
      }, result)
    },
  })

  const updateMutation = useMutation({
    mutationFn: async (data: UpdateProfileInput) => {
      const result = await SettingsService.updateProfile(data)
      return Union.match({
        success: (profile) => profile,
        error: ({ message }) => { throw new Error(message) },
      }, result)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROFILE_KEY }),
  })

  return {
    profile,
    isLoading,
    error,
    updateProfile: updateMutation.mutateAsync,
    isUpdating: updateMutation.isPending,
  }
}

export function useApiKeys() {
  const queryClient = useQueryClient()

  const { data: keys = [], isLoading, error } = useQuery({
    queryKey: API_KEYS_KEY,
    queryFn: async (): Promise<UserApiKey.Model[]> => {
      const result = await SettingsService.getApiKeys()
      return Union.match({
        success: ({ keys }) => keys,
        error: () => [],
      }, result)
    },
  })

  const upsertMutation = useMutation({
    mutationFn: async ({ provider, apiKey }: { provider: UserApiKey.Provider; apiKey: string }) => {
      const result = await SettingsService.upsertApiKey(provider, apiKey)
      return Union.match({
        success: ({ key }) => key,
        error: ({ message }) => { throw new Error(message) },
      }, result)
    },
    onSuccess: () => invalidateKeysAndModels(queryClient),
  })

  const deleteMutation = useMutation({
    mutationFn: async (provider: UserApiKey.Provider) => {
      const result = await SettingsService.deleteApiKey(provider)
      return Union.match({
        success: () => provider,
        error: ({ message }) => { throw new Error(message) },
      }, result)
    },
    onSuccess: () => invalidateKeysAndModels(queryClient),
  })

  const setEnabledModelsMutation = useMutation({
    mutationFn: async (
      { provider, modelIds }: { provider: UserApiKey.Provider; modelIds: string[] },
    ) => {
      const result = await SettingsService.setEnabledModels(provider, modelIds)
      return Union.match({
        success: ({ key }) => key,
        error: ({ message }) => { throw new Error(message) },
      }, result)
    },
    onSuccess: () => invalidateKeysAndModels(queryClient),
  })

  return {
    keys,
    isLoading,
    error,
    upsertApiKey: upsertMutation.mutateAsync,
    deleteApiKey: deleteMutation.mutateAsync,
    setEnabledModels: setEnabledModelsMutation.mutateAsync,
    isUpserting: upsertMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isSettingModels: setEnabledModelsMutation.isPending,
  }
}

// Canvas + settings both consume this. The query is lightweight (one GET)
// and automatically refreshes when any key mutation invalidates it.
export function useActiveModels() {
  const { data: models = [], isLoading } = useQuery({
    queryKey: ACTIVE_MODELS_KEY,
    queryFn: async (): Promise<LLM.Model[]> => {
      const result = await SettingsService.getActiveModels()
      return Union.match({
        success: ({ models }) => models,
        error: () => [],
      }, result)
    },
  })
  return { models, isLoading }
}
