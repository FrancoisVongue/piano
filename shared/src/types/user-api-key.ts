import { z } from 'zod';

export namespace UserApiKey {
  // ============================================
  // PROVIDERS
  // ============================================

  // BYOK providers. The three direct ones (OPENAI/ANTHROPIC/GOOGLE) are
  // consumed by LLM.MODELS directly; OPENROUTER is a router tier for
  // pulling in models outside the main catalog — it unlocks whatever
  // LLM.MODELS entries the user (or the product) decides to expose with
  // `provider: 'OPENROUTER'`.
  export const providers = ['OPENAI', 'ANTHROPIC', 'GOOGLE', 'OPENROUTER'] as const;
  export type Provider = typeof providers[number];
  export const ProviderSchema = z.enum(providers);

  export const providerConfig: Record<Provider, { name: string }> = {
    OPENAI: { name: 'OpenAI' },
    ANTHROPIC: { name: 'Anthropic' },
    GOOGLE: { name: 'Google AI' },
    OPENROUTER: { name: 'OpenRouter' },
  };

  // ============================================
  // MODEL (what backend stores/returns)
  // ============================================

  export interface Model {
    id: string;
    provider: Provider;
    keyPrefix: string;
    isActive: boolean;
    // Model IDs (from LLM.MODELS) the user has enabled for this key. Seeded
    // to the full provider set on first insert; can be pruned via Settings.
    enabledModelIds: string[];
    createdAt: Date | string;
    updatedAt: Date | string;
  }

  // ============================================
  // DTOs
  // ============================================

  export namespace DTO {
    export const UpsertSchema = z.object({
      provider: ProviderSchema,
      apiKey: z.string().min(10, 'API key is too short'),
    });
    export type Upsert = z.infer<typeof UpsertSchema>;

    export const SetEnabledModelsSchema = z.object({
      modelIds: z.array(z.string().min(1)),
    });
    export type SetEnabledModels = z.infer<typeof SetEnabledModelsSchema>;
  }

  // ============================================
  // VALIDATION & UTILS
  // ============================================

  export const validate = {
    upsert: (data: unknown): DTO.Upsert => DTO.UpsertSchema.parse(data),
    provider: (data: unknown): Provider => ProviderSchema.parse(data),
    setEnabledModels: (data: unknown): DTO.SetEnabledModels =>
      DTO.SetEnabledModelsSchema.parse(data),
  };

  export const extractKeyPrefix = (apiKey: string): string => {
    return apiKey.substring(0, 8) + '...';
  };

  // Pure transformation: DB row -> Model (drops sensitive keyHash)
  export type DbRow = {
    id: string;
    provider: string;
    keyPrefix: string;
    isActive: boolean;
    enabledModelIds: string[];
    createdAt: Date;
    updatedAt: Date;
  };

  export const toModel = (row: DbRow): Model => ({
    id: row.id,
    provider: row.provider as Provider,
    keyPrefix: row.keyPrefix,
    isActive: row.isActive,
    enabledModelIds: row.enabledModelIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  // Flatten: what model IDs are visible given the user's current keys.
  // Inactive keys contribute nothing.
  export const activeModelIds = (keys: Model[]): Set<string> => {
    const ids = new Set<string>();
    for (const k of keys) {
      if (!k.isActive) continue;
      for (const id of k.enabledModelIds) ids.add(id);
    }
    return ids;
  };
}
