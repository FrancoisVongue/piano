import { venum } from 'venum';
import { LLM } from '@piano/shared';
import { services } from '../init';
import { decrypt } from '../../domains/user-settings/adapters/crypto';

// -----------------------------------------------------------------------------
// BYOK resolution. One question: "given a userId and a model, do we have a
// usable API key?" Answer is a venum so callers (workers, controllers) map
// the `missingKey` case to a named UI outcome instead of crashing.
// -----------------------------------------------------------------------------

export const resolveApiKey = async (userId: string, modelId: LLM.ModelId) => {
  const provider = LLM.requiresProvider(modelId);
  const row = await services.prisma.userApiKey.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  if (!row || !row.isActive) {
    return venum('missingKey', {
      message: `No active ${provider} API key. Add one in settings to use ${modelId}.`,
      provider,
    });
  }
  return venum('ok', decrypt(row.keyHash));
};
