import { venum } from 'venum';
import { services } from '../../services/init';
import { UserApiKey, LLM } from '@piano/shared';
import { encrypt } from './adapters/crypto';

const profileSelect = {
  id: true,
  email: true,
  name: true,
  defaultSystemPrompt: true,
  createdAt: true,
} as const;

export class UserSettingsController {
  // ============ API KEYS ============

  static async getApiKeys(userId: string): Promise<UserApiKey.Model[]> {
    const rows = await services.prisma.userApiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(UserApiKey.toModel);
  }

  // On first insert the provider's full model set is seeded so the user
  // sees a populated dropdown immediately. Re-upserting an existing key
  // preserves the user's curated `enabledModelIds`.
  static async upsertApiKey(
    userId: string,
    provider: UserApiKey.Provider,
    apiKey: string
  ): Promise<UserApiKey.Model> {
    const keyPrefix = UserApiKey.extractKeyPrefix(apiKey);
    const keyHash = encrypt(apiKey);

    const row = await services.prisma.userApiKey.upsert({
      where: { userId_provider: { userId, provider: provider as any } },
      create: {
        userId, provider: provider as any, keyHash, keyPrefix, isActive: true,
        enabledModelIds: LLM.modelIdsFor(provider),
      },
      update: { keyHash, keyPrefix, isActive: true, updatedAt: new Date() },
    });
    return UserApiKey.toModel(row);
  }

  // Replace the visible-model list for a given (user, provider). Unknown
  // IDs or IDs from other providers are dropped silently.
  static async setEnabledModels(
    userId: string,
    provider: UserApiKey.Provider,
    modelIds: string[],
  ) {
    const clean = LLM.filterByProvider(provider, modelIds);
    const row = await services.prisma.userApiKey.update({
      where: { userId_provider: { userId, provider: provider as any } },
      data: { enabledModelIds: clean },
    }).catch(() => null);
    if (!row) return venum('notFound', { message: 'API key not found for that provider' });
    return venum('ok', UserApiKey.toModel(row));
  }

  // Pre-filtered model catalog for the UI dropdown: only models from
  // providers whose keys are active AND ticked in the user's settings.
  static async getActiveModels(userId: string): Promise<LLM.Model[]> {
    const keys = await this.getApiKeys(userId);
    const active = UserApiKey.activeModelIds(keys);
    return LLM.MODELS.filter(m => active.has(m.id)) as unknown as LLM.Model[];
  }

  static async deleteApiKey(userId: string, provider: UserApiKey.Provider) {
    await services.prisma.userApiKey.deleteMany({ where: { userId, provider: provider as any } });
    return { success: true };
  }

  // ============ PROFILE ============

  static async getProfile(userId: string) {
    return services.prisma.user.findUnique({
      where: { id: userId },
      select: profileSelect,
    });
  }

  static async updateProfile(userId: string, data: { name?: string; defaultSystemPrompt?: string | null }) {
    return services.prisma.user.update({
      where: { id: userId },
      data,
      select: profileSelect,
    });
  }
}
