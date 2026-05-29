import { LLM } from '@piano/shared';
import { venum } from 'venum';

// -----------------------------------------------------------------------------
// Unified AI request/response shapes.
//
// The dispatcher (see ./index.ts) picks one of three adapters by
// `LLM.Model.provider`. Each adapter speaks these types natively so callers
// have exactly ONE contract regardless of provider.
//
// Design notes:
// - Prompt is split into `system` + `prefix` + `fresh`. This is the shape
//   that lets us plug each piece into the right provider-specific cache
//   mechanism: Anthropic puts cache_control on the prefix block; Gemini
//   puts the prefix into a CachedContent; OpenAI ignores the split.
// - `cacheDirective` carries user intent AND the previously-created handle
//   (Gemini). Adapters that create new handles return them in
//   `response.cacheCreated` so the caller can persist.
// - No throws at the adapter boundary: we return a venum variant. The worker
//   (Temporal activity) bridges that to throw if it wants retries.
// -----------------------------------------------------------------------------

export type CacheDirective = {
  ttlSeconds: number;
  // For Gemini CachedContent: if we have an unexpired handle, reuse it.
  existingHandle?: { handle: string; expiresAt: Date };
};

export type CompletionRequest = {
  model: LLM.ModelId;
  apiKey: string;
  system?: string;         // concatenated system prompts (user default + arrangement)
  prefix?: string;         // content above the cache anchor (ancestor chain up to anchor)
  fresh: string;           // content at-and-below anchor + action prompt + source
  cacheDirective?: CacheDirective;
  // JSON Schema (Draft 2020-12). PLAIN object — must survive Temporal's
  // JSON serialization across activity boundaries, which Zod schemas don't
  // (they lose methods and shape). Build this with zod's native
  // `z.toJSONSchema()` at the worker layer; adapters never see Zod.
  jsonSchema?: Record<string, unknown>;
};

export type CacheCreated = { handle: string; expiresAt: Date; tokens: number };

export type CompletionOk<T = string> = {
  text: T;
  cacheCreated?: CacheCreated;    // only Gemini path produces this
  cacheHit?: boolean;             // best-effort diagnostic flag
  usage?: LLM.RunUsage;           // normalized token accounting; absent on pathological provider responses
};

// Adapter result — venum-shaped so callers map to HTTP or worker retries
// without try/catch. `providerError` is the fallback bucket for anything that
// isn't a named business failure.
export type CompletionResult<T = string> = ReturnType<typeof venum<'ok', CompletionOk<T>>>
  | ReturnType<typeof venum<'invalidApiKey', { message: string }>>
  | ReturnType<typeof venum<'rateLimited', { message: string; retryAfterMs?: number }>>
  | ReturnType<typeof venum<'cacheTooSmall', { message: string; minTokens: number }>>
  | ReturnType<typeof venum<'providerError', { message: string }>>;

// The interface each provider adapter implements. Dispatcher routes to one
// of three implementations based on model.provider.
export interface Adapter {
  complete(req: CompletionRequest): Promise<CompletionResult<string>>;
  completeJSON<T = any>(req: CompletionRequest): Promise<CompletionResult<T>>;
  // Cache lifecycle — only Gemini implements these meaningfully; other
  // adapters return a no-op result so the caller code stays uniform.
  deleteCache?(apiKey: string, handle: string): Promise<void>;
}
