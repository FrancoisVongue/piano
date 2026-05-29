import { LLM } from '@piano/shared';
import { Adapter, CompletionRequest, CompletionResult } from './types';
import { anthropicAdapter } from './anthropic';
import { openaiAdapter, openrouterAdapter } from './openai';
import { googleAdapter } from './google';

// -----------------------------------------------------------------------------
// AI Dispatcher.
//
// One unified interface for all three providers. The dispatcher is a pure
// map: `model.provider → adapter`. Nothing else lives here — no retry, no
// logging, no caching logic. The adapters already return venum results, so
// callers handle failures uniformly regardless of which provider answered.
//
// To add a new provider: write an adapter in this folder that satisfies
// `Adapter`, declare it here, add the models to LLM.MODELS with the right
// `provider` string. Three lines.
// -----------------------------------------------------------------------------

const adapters: Record<LLM.Provider, Adapter> = {
  ANTHROPIC: anthropicAdapter,
  OPENAI: openaiAdapter,
  GOOGLE: googleAdapter,
  OPENROUTER: openrouterAdapter,
};

const adapterFor = (modelId: LLM.ModelId): Adapter => {
  const model = LLM.getModelById(modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);
  return adapters[model.provider];
};

export class AiService {
  complete = (req: CompletionRequest): Promise<CompletionResult<string>> =>
    adapterFor(req.model).complete(req);

  completeJSON = <T = any>(req: CompletionRequest): Promise<CompletionResult<T>> =>
    adapterFor(req.model).completeJSON<T>(req);

  // Gemini-only lifecycle op. For Anthropic/OpenAI this resolves to a no-op
  // so callers don't branch on provider when cleaning up.
  deleteCache = async (modelId: LLM.ModelId, apiKey: string, handle: string): Promise<void> => {
    const adapter = adapterFor(modelId);
    if (adapter.deleteCache) await adapter.deleteCache(apiKey, handle);
  };
}

export type { CompletionRequest, CompletionResult } from './types';
