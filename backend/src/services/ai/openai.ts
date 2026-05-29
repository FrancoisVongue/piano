import OpenAI from 'openai';
import { venum } from 'venum';
import { LLM } from '@piano/shared';
import { Adapter, CompletionRequest, CompletionResult } from './types';

// -----------------------------------------------------------------------------
// OpenAI-compatible adapter factory.
//
// Two adapters share the OpenAI chat-completions wire protocol:
//   • native OpenAI (default baseURL)
//   • OpenRouter (baseURL set to OR)
// They differ only in endpoint + error label; behavior is identical.
// One factory produces both — no more copy-pasted 80-line twins.
//
// Cache story: fully automatic, opaque TTL. The dispatcher rejects
// cache-controllable configs for these provider tiers at the capability
// layer, so this adapter silently ignores `cacheDirective` if one arrives.
// `cacheHit` is reported when the provider surfaces it in the usage payload.
// -----------------------------------------------------------------------------

const pickNativeId = (modelId: LLM.ModelId): string => {
  const m = LLM.getModelById(modelId);
  if (!m) throw new Error(`Unknown model: ${modelId}`);
  return m.nativeId;
};

const buildMessages = (req: CompletionRequest): OpenAI.Chat.ChatCompletionMessageParam[] => {
  const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (req.system) msgs.push({ role: 'system', content: req.system });
  const content = req.prefix ? `${req.prefix}\n\n${req.fresh}` : req.fresh;
  msgs.push({ role: 'user', content });
  return msgs;
};

export const createOpenAICompatibleAdapter = (opts: {
  label: string;                 // "OpenAI" / "OpenRouter" — surfaces in error messages
  baseURL?: string;              // omit for native OpenAI
  supportsRetention?: boolean;   // emit prompt_cache_retention when cacheDirective present
}): Adapter => {
  const client = (apiKey: string) =>
    new OpenAI(opts.baseURL ? { apiKey, baseURL: opts.baseURL } : { apiKey });

  // OpenAI has two discrete retention tiers: the default in-memory (~5-10 min)
  // and "24h". We map ttlSeconds → '24h' only above the day threshold so a
  // user who picked the short option doesn't accidentally pay for 24h writes.
  const retentionFor = (ttlSeconds?: number): '24h' | undefined =>
    ttlSeconds && ttlSeconds >= 86400 ? '24h' : undefined;

  const extraParams = (req: CompletionRequest): Record<string, unknown> => {
    if (!opts.supportsRetention || !req.cacheDirective) return {};
    const retention = retentionFor(req.cacheDirective.ttlSeconds);
    return retention ? { prompt_cache_retention: retention } : {};
  };

  const translateError = (e: any): CompletionResult<never> => {
    const status = e?.status ?? e?.statusCode;
    const message = e?.message || `${opts.label} request failed`;
    if (status === 401) return venum('invalidApiKey', { message });
    if (status === 429) return venum('rateLimited', { message });
    return venum('providerError', { message });
  };

  const readCacheHit = (completion: any): boolean =>
    (completion.usage?.prompt_tokens_details?.cached_tokens ?? 0) > 0;

  // OpenAI-shape usage is identical for native and OR. prompt_tokens is
  // total (includes cached); we keep that convention across providers.
  const normalizeUsage = (raw: any, modelId: LLM.ModelId): LLM.RunUsage => ({
    inputTokens: raw?.prompt_tokens ?? 0,
    outputTokens: raw?.completion_tokens ?? 0,
    cachedTokens: raw?.prompt_tokens_details?.cached_tokens ?? 0,
    provider: LLM.getModelById(modelId)?.provider ?? 'OPENAI',
    modelId,
  });

  return {
    async complete(req) {
      try {
        const completion = await client(req.apiKey).chat.completions.create({
          model: pickNativeId(req.model),
          messages: buildMessages(req),
          ...extraParams(req),
        } as any);
        const text = completion.choices[0]?.message?.content || '';
        return venum('ok', {
          text,
          cacheHit: readCacheHit(completion),
          usage: normalizeUsage(completion.usage, req.model),
        });
      } catch (e: any) {
        return translateError(e);
      }
    },

    async completeJSON<T = any>(req: CompletionRequest) {
      if (!req.jsonSchema) {
        return venum('providerError', { message: 'completeJSON requires jsonSchema' });
      }
      try {
        const completion = await client(req.apiKey).chat.completions.create({
          model: pickNativeId(req.model),
          messages: buildMessages(req),
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'structured_output',
              strict: true,
              schema: req.jsonSchema,
            },
          } as any,
          temperature: 0.2,
          ...extraParams(req),
        } as any);
        const raw = completion.choices[0]?.message?.content || '{}';
        const parsed = JSON.parse(raw) as T;
        return venum('ok', {
          text: parsed,
          cacheHit: readCacheHit(completion),
          usage: normalizeUsage(completion.usage, req.model),
        });
      } catch (e: any) {
        return translateError(e);
      }
    },
  };
};

// Native OpenAI: supports `prompt_cache_retention`.
export const openaiAdapter = createOpenAICompatibleAdapter({
  label: 'OpenAI',
  supportsRetention: true,
});
// OpenRouter: caching is OR's own concern. If the user is on OR they
// accept OR's implicit handling; we don't try to second-guess it.
// Base URL is overridable via OPENROUTER_BASE_URL so self-hosters can
// route through a custom AI gateway or a regional mirror.
export const openrouterAdapter = createOpenAICompatibleAdapter({
  label: 'OpenRouter',
  baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
});
