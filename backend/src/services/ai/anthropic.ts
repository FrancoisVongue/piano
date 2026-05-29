import Anthropic from '@anthropic-ai/sdk';
import { venum } from 'venum';
import { LLM } from '@piano/shared';
import { Adapter, CompletionRequest, CompletionResult } from './types';

// Normalize Anthropic's usage → LLM.RunUsage.
// Anthropic reports `input_tokens` as UNCACHED only; cache read+write are
// separate siblings. Our shared convention is "inputTokens = total", so we
// sum all three to derive it.
const normalizeUsage = (raw: any, modelId: LLM.ModelId): LLM.RunUsage => {
  const freshIn = raw?.input_tokens ?? 0;
  const cacheRead = raw?.cache_read_input_tokens ?? 0;
  const cacheWrite = raw?.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: freshIn + cacheRead + cacheWrite,
    outputTokens: raw?.output_tokens ?? 0,
    cachedTokens: cacheRead,
    provider: 'ANTHROPIC',
    modelId,
  };
};

// -----------------------------------------------------------------------------
// Anthropic adapter.
//
// Cache story: stateless. When a `cacheDirective` is present and we have a
// non-empty `prefix`, we split the user message into two text blocks and put
// `cache_control: { type: 'ephemeral', ttl: '5m' | '1h' }` on the prefix
// block. Anthropic validates the prefix bytes against its cache; if it
// matches a previous request, reads are 0.25× input price. Nothing to
// persist — next request with the same prefix bytes hits the same cache.
//
// TTL mapping: Anthropic only accepts '5m' or '1h'. We take the closest
// >= requested seconds. 3600s ⇒ '1h'. Anything under 3600 ⇒ '5m'.
// -----------------------------------------------------------------------------

const mapTtl = (seconds: number): '5m' | '1h' => (seconds >= 3600 ? '1h' : '5m');

const pickNativeId = (modelId: LLM.ModelId): string => {
  const m = LLM.getModelById(modelId);
  if (!m) throw new Error(`Unknown model: ${modelId}`);
  return m.nativeId;
};

type Block =
  | { type: 'text'; text: string }
  | { type: 'text'; text: string; cache_control: { type: 'ephemeral'; ttl?: '5m' | '1h' } };

// Assemble the content blocks for a single user turn. This is the ONE place
// that decides how prefix/fresh map onto Anthropic's block structure.
const buildBlocks = (req: CompletionRequest): Block[] => {
  const blocks: Block[] = [];
  const hasCache = !!(req.cacheDirective && req.prefix && req.prefix.length > 0);
  if (req.prefix) {
    blocks.push(
      hasCache
        ? {
            type: 'text',
            text: req.prefix,
            cache_control: { type: 'ephemeral', ttl: mapTtl(req.cacheDirective!.ttlSeconds) },
          }
        : { type: 'text', text: req.prefix },
    );
  }
  blocks.push({ type: 'text', text: req.fresh });
  return blocks;
};

// Convert Anthropic SDK errors into our named venum variants. Keeps callers
// exception-free and lets routes map 401/429/other to the right HTTP code.
const translateError = (e: any): CompletionResult<never> => {
  const status = e?.status ?? e?.statusCode;
  const message = e?.message || 'Anthropic request failed';
  if (status === 401) return venum('invalidApiKey', { message });
  if (status === 429) {
    const retryAfter = e?.headers?.['retry-after'];
    return venum('rateLimited', {
      message,
      retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : undefined,
    });
  }
  return venum('providerError', { message });
};

const clientFor = (apiKey: string) => new Anthropic({ apiKey });

export const anthropicAdapter: Adapter = {
  async complete(req) {
    try {
      const response = await clientFor(req.apiKey).messages.create({
        model: pickNativeId(req.model),
        max_tokens: 8192,
        system: req.system || undefined,
        messages: [{ role: 'user', content: buildBlocks(req) as any }],
      });
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as any).text as string)
        .join('');
      const usage = normalizeUsage(response.usage, req.model);
      return venum('ok', { text, cacheHit: usage.cachedTokens > 0, usage });
    } catch (e: any) {
      return translateError(e);
    }
  },

  async completeJSON<T = any>(req: CompletionRequest) {
    if (!req.jsonSchema) {
      return venum('providerError', { message: 'completeJSON requires jsonSchema' });
    }
    // Native Structured Outputs (GA in @anthropic-ai/sdk ≥ 0.90).
    // `output_config.format = { type: 'json_schema', schema }` makes the
    // response.content[0].text guaranteed to parse against the schema —
    // no prompt-engineering workaround, no ```json fence stripping.
    try {
      const response = await clientFor(req.apiKey).messages.create({
        model: pickNativeId(req.model),
        max_tokens: 8192,
        system: req.system || undefined,
        messages: [{ role: 'user', content: buildBlocks(req) as any }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: req.jsonSchema as { [key: string]: unknown },
          },
        },
      });
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as any).text as string)
        .join('');
      const parsed = JSON.parse(text) as T;
      const usage = normalizeUsage(response.usage, req.model);
      return venum('ok', { text: parsed, cacheHit: usage.cachedTokens > 0, usage });
    } catch (e: any) {
      return translateError(e);
    }
  },
};
