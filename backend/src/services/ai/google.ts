import { GoogleGenAI } from '@google/genai';
import { venum } from 'venum';
import { LLM } from '@piano/shared';
import { Adapter, CompletionRequest, CompletionResult, CacheCreated } from './types';
import { obs } from '../observability';

const log = obs.child({ domain: 'ai:gemini' });

// -----------------------------------------------------------------------------
// Google Gemini adapter — the only one with a stateful cache lifecycle.
//
// CachedContent flow (worth reading before touching this file):
//   1. Before a run, the caller passes `cacheDirective` with ttlSeconds and
//      optionally an existingHandle (if we already created one for this
//      note+model and it hasn't expired).
//   2. If existingHandle is present and live: reference it via
//      `cachedContent` in generateContent. No write cost.
//   3. If not: create a new CachedContent with the `prefix` content + ttl,
//      then reference it. The new handle is returned in `cacheCreated` for
//      the caller to persist into the anchor note's cacheConfig.runtime.
//   4. Minimum tokens for CachedContent: 4096 (enforced by Google). Below
//      that we return `cacheTooSmall` and the caller falls through to a
//      plain uncached call.
//
// Notes:
//   - We always try to include `system` as systemInstruction so it also
//     benefits from implicit caching on Gemini 2.5+.
//   - When `cacheCreated` fires, the caller writes the handle back into
//     Note.cacheConfig[modelId].runtime. This file stays stateless.
// -----------------------------------------------------------------------------

const pickNativeId = (modelId: LLM.ModelId): string => {
  const m = LLM.getModelById(modelId);
  if (!m) throw new Error(`Unknown model: ${modelId}`);
  return m.nativeId;
};

const clientFor = (apiKey: string) => new GoogleGenAI({ apiKey });
const googleSearchTools = [{ googleSearch: {} }];

// Gemini's usageMetadata reports promptTokenCount as TOTAL input (including
// cached), matching our shared convention. cachedContentTokenCount is the
// hit subset.
const normalizeUsage = (meta: any, modelId: LLM.ModelId): LLM.RunUsage => ({
  inputTokens: meta?.promptTokenCount ?? 0,
  outputTokens: meta?.candidatesTokenCount ?? 0,
  cachedTokens: meta?.cachedContentTokenCount ?? 0,
  provider: 'GOOGLE',
  modelId,
});

const translateError = (e: any): CompletionResult<never> => {
  const status = e?.status ?? e?.statusCode;
  const message = e?.message || 'Gemini request failed';
  if (status === 401 || status === 403) return venum('invalidApiKey', { message });
  if (status === 429) return venum('rateLimited', { message });
  // Google's "too few tokens for cache" comes as a 400. We keep it as
  // providerError — the caller should already have min-token awareness via
  // LLM.CacheCapability.minTokens, so hitting this means unexpected size.
  return venum('providerError', { message });
};

// Create a fresh CachedContent handle. Wrapped in its own try/catch because
// failure here should not crash the whole run — we can fall back to an
// uncached call. Returns `null` on failure (caller decides fallback).
const createHandle = async (
  apiKey: string,
  nativeId: string,
  prefix: string,
  system: string | undefined,
  ttlSeconds: number,
): Promise<CacheCreated | 'too-small' | null> => {
  log.debug(
    { model: nativeId, prefixChars: prefix.length, systemChars: system?.length ?? 0, ttlSeconds },
    'createHandle attempt',
  );
  try {
    const ai = clientFor(apiKey);
    const cached = await ai.caches.create({
      model: nativeId,
      config: {
        contents: [{ role: 'user', parts: [{ text: prefix }] }],
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        ttl: `${ttlSeconds}s`,
      },
    });
    const handle = (cached as any).name as string;
    const expire = (cached as any).expireTime;
    const expiresAt = expire ? new Date(expire) : new Date(Date.now() + ttlSeconds * 1000);
    const tokens = (cached as any).usageMetadata?.totalTokenCount ?? 0;
    log.debug({ handle, tokens, expiresAt }, 'createHandle ok');
    return { handle, expiresAt, tokens };
  } catch (e: any) {
    const message: string = e?.message || '';
    if (/minimum|too small|token count/i.test(message)) {
      log.warn({ message }, 'createHandle too-small');
      return 'too-small';
    }
    // Any other failure — surface it loudly so we don't silently degrade.
    log.error({ err: e, status: e?.status, code: e?.code }, 'createHandle failed');
    return null;
  }
};

// `usingCache` must reflect the handle we ACTUALLY pass to generateContent,
// not what was in the incoming req. On the very first run we mint a new
// handle INSIDE complete() — the prefix is now in CachedContent; sending
// it again in `contents` double-charges (bug fixed 2026-04-21).
const buildContents = (req: CompletionRequest, usingCache: boolean) => {
  const body = usingCache
    ? req.fresh
    : (req.prefix ? `${req.prefix}\n\n${req.fresh}` : req.fresh);
  return [{ role: 'user', parts: [{ text: body }] }];
};

export const googleAdapter: Adapter = {
  async complete(req) {
    const nativeId = pickNativeId(req.model);
    let cacheCreated: CacheCreated | undefined;
    let cachedContentRef: string | undefined = req.cacheDirective?.existingHandle?.handle;

    log.debug(
      {
        hasDirective: !!req.cacheDirective,
        hasExistingHandle: !!cachedContentRef,
        prefixChars: req.prefix?.length ?? 0,
        freshChars: req.fresh.length,
      },
      'complete enter',
    );

    // If user asked for cache and we don't have a live handle, try to create one.
    if (req.cacheDirective && !cachedContentRef && req.prefix) {
      const res = await createHandle(
        req.apiKey,
        nativeId,
        req.prefix,
        req.system,
        req.cacheDirective.ttlSeconds,
      );
      if (res === 'too-small') {
        return venum('cacheTooSmall', {
          message: 'Prefix is below Gemini\'s CachedContent minimum (~4096 tokens)',
          minTokens: 4096,
        });
      }
      if (res) {
        cacheCreated = res;
        cachedContentRef = res.handle;
      }
      // If res is null, fall through uncached rather than failing the whole run.
    }

    try {
      const response = await clientFor(req.apiKey).models.generateContent({
        model: nativeId,
        contents: buildContents(req, !!cachedContentRef),
        config: {
          systemInstruction: cachedContentRef ? undefined : (req.system ? { parts: [{ text: req.system }] } : undefined),
          cachedContent: cachedContentRef,
          tools: googleSearchTools,
        },
      });
      const text =
        (response as any).text ||
        response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
        '';
      const cacheHit = !!cachedContentRef;
      const usage = normalizeUsage((response as any).usageMetadata, req.model);
      log.info(
        {
          usedCacheRef: cacheHit ? cachedContentRef : null,
          inputTokens: usage.inputTokens,
          cachedTokens: usage.cachedTokens,
          outputTokens: usage.outputTokens,
        },
        'complete done',
      );
      return venum('ok', { text, cacheHit, cacheCreated, usage });
    } catch (e: any) {
      return translateError(e);
    }
  },

  async completeJSON<T = any>(req: CompletionRequest) {
    if (!req.jsonSchema) {
      return venum('providerError', { message: 'completeJSON requires jsonSchema' });
    }
    const nativeId = pickNativeId(req.model);
    try {
      const response = await clientFor(req.apiKey).models.generateContent({
        model: nativeId,
        contents: buildContents(req, false), // completeJSON path doesn't use CachedContent
        config: {
          systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
          responseMimeType: 'application/json',
          responseSchema: req.jsonSchema as any,
          tools: googleSearchTools,
        },
      });
      const raw =
        (response as any).text ||
        response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
        '{}';
      const parsed = JSON.parse(raw) as T;
      return venum('ok', {
        text: parsed,
        usage: normalizeUsage((response as any).usageMetadata, req.model),
      });
    } catch (e: any) {
      return translateError(e);
    }
  },

  async deleteCache(apiKey, handle) {
    try {
      await clientFor(apiKey).caches.delete({ name: handle });
    } catch {
      // Swallow: a failed delete just means a leaked cache that will auto-expire.
      // Surfacing this would be noise — the caller has already dropped its DB row.
    }
  },
};
