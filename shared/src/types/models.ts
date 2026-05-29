export namespace LLM {
  // ============================================
  // PROVIDERS — aligned with UserApiKey.Provider.
  // `provider` on each model is the BYOK key needed to unlock it.
  // ============================================

  export type Provider = 'ANTHROPIC' | 'OPENAI' | 'GOOGLE' | 'OPENROUTER';

  // ============================================
  // CACHE CAPABILITY — the UX contract.
  //
  // `controllable`: can the user pick TTL explicitly?
  //    - Anthropic: yes (5m / 1h via cache_control).
  //    - Google Gemini: yes (CachedContent API — minutes to hours).
  //    - OpenAI: no (automatic caching, opaque TTL).
  //
  // Frontend reads this to decide whether to show the "Add cache" button.
  // Backend reads `mechanism` to pick the right adapter path.
  // ============================================

  export type CacheMechanism =
    | 'anthropic-breakpoint'   // insert cache_control in messages
    | 'gemini-cached-content'  // stateful CachedContent handle
    | 'openai-retention'       // prompt_cache_retention: 'in_memory' | '24h'
    | 'openai-automatic'       // legacy: provider caches silently, no knob
    | 'none';                  // no caching at all

  export type TtlOption = { value: string; label: string; seconds: number };

  export type CacheCapability =
    | { controllable: false; mechanism: 'openai-automatic' | 'none' }
    | {
        controllable: true;
        mechanism: 'anthropic-breakpoint' | 'gemini-cached-content' | 'openai-retention';
        ttlOptions: TtlOption[];
        minTokens: number;
      };

  // Pre-baked TTL pickers per provider. Kept here so the list is the single
  // source of truth for both Note.CacheConfig validation and UI dropdowns.
  const ANTHROPIC_TTL: TtlOption[] = [
    { value: '5m', label: '5 minutes', seconds: 300 },
    { value: '1h', label: '1 hour', seconds: 3600 },
  ];

  const GEMINI_TTL: TtlOption[] = [
    { value: '5m', label: '5 minutes', seconds: 300 },
    { value: '30m', label: '30 minutes', seconds: 1800 },
    { value: '1h', label: '1 hour', seconds: 3600 },
    { value: '3h', label: '3 hours', seconds: 10800 },
    { value: '6h', label: '6 hours', seconds: 21600 },
  ];

  // OpenAI exposes two tiers via `prompt_cache_retention`. Not granular
  // like the others, but meaningfully controllable — default is fine for
  // short sessions, 24h matches all-day research flows.
  const OPENAI_TTL: TtlOption[] = [
    { value: 'in_memory', label: 'Default (5–10 min)', seconds: 300 },
    { value: '24h', label: '24 hours', seconds: 86400 },
  ];

  // Reusable cache-capability presets. Every MODELS entry picks one of
  // these (or declares its own for truly bespoke behavior) — avoids 12
  // identical inline objects for automatic/no-cache models.
  // OR-routed tier: OR forwards OpenAI's `prompt_cache_retention` via its
  // own `cacheRetention: 'long'` body param. Our openrouterAdapter doesn't
  // wire that yet — TODO. Marked automatic until then.
  const AUTO_CACHE: CacheCapability = { controllable: false, mechanism: 'openai-automatic' };
  const NO_CACHE:   CacheCapability = { controllable: false, mechanism: 'none' };
  const ANTHROPIC_CACHE: CacheCapability = {
    controllable: true,
    mechanism: 'anthropic-breakpoint',
    ttlOptions: ANTHROPIC_TTL,
    minTokens: 1024,
  };
  const GEMINI_CACHE: CacheCapability = {
    controllable: true,
    mechanism: 'gemini-cached-content',
    ttlOptions: GEMINI_TTL,
    minTokens: 4096,
  };
  const OPENAI_CACHE: CacheCapability = {
    controllable: true,
    mechanism: 'openai-retention',
    ttlOptions: OPENAI_TTL,
    minTokens: 1024,
  };

  // ============================================
  // AVAILABLE AI MODELS
  // ============================================

  export const MODELS = [
    // -- Anthropic (direct) --
    {
      id: 'anthropic/claude-opus-4.7',
      name: 'Claude Opus 4.7',
      description: 'Anthropic flagship — strongest reasoning, longest context',
      provider: 'ANTHROPIC',
      nativeId: 'claude-opus-4-7',
      cache: ANTHROPIC_CACHE,
    },
    {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      description: 'Fast, general-purpose Claude for everyday tasks',
      provider: 'ANTHROPIC',
      nativeId: 'claude-sonnet-4-5-20250929',
      cache: ANTHROPIC_CACHE,
    },

    // -- Google (direct) --
    {
      id: 'google/gemini-3.1-pro',
      name: 'Gemini 3.1 Pro',
      description: 'Google\'s frontier Gemini — strongest reasoning, 1M context',
      provider: 'GOOGLE',
      nativeId: 'gemini-3.1-pro-preview',
      cache: GEMINI_CACHE,
    },
    {
      id: 'google/gemini-3.5-flash',
      name: 'Gemini 3.5 Flash',
      description: 'Frontier-speed Gemini — strongest coding/agentic Flash, 1M context',
      provider: 'GOOGLE',
      nativeId: 'gemini-3.5-flash',
      cache: GEMINI_CACHE,
    },
    {
      id: 'google/gemini-3-flash',
      name: 'Gemini 3 Flash',
      description: 'Fast, cost-efficient Gemini 3 for high-throughput workloads',
      provider: 'GOOGLE',
      nativeId: 'gemini-3-flash-preview',
      cache: GEMINI_CACHE,
    },
    {
      id: 'google/gemini-3.1-flash-lite',
      name: 'Gemini 3.1 Flash Lite',
      description: 'Ultra-cheap Gemini for simple tasks',
      provider: 'GOOGLE',
      nativeId: 'gemini-3.1-flash-lite',
      cache: GEMINI_CACHE,
    },

    // -- OpenAI (direct) --
    {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      description: 'OpenAI\'s versatile multimodal model',
      provider: 'OPENAI',
      nativeId: 'gpt-4o',
      cache: OPENAI_CACHE,
    },
    {
      id: 'openai/gpt-4o-mini',
      name: 'GPT-4o Mini',
      description: 'Fast, inexpensive OpenAI model',
      provider: 'OPENAI',
      nativeId: 'gpt-4o-mini',
      cache: OPENAI_CACHE,
    },

    // -- OpenRouter-routed (single key unlocks many providers) --
    // id prefixed `openrouter/...` so these never collide with native
    // entries. Caching declared non-controllable: OR forwards Anthropic's
    // cache_control but our adapter doesn't emit it yet. When it does,
    // flip individual cache fields and nothing else changes.
    { id: 'openrouter/openai/gpt-5.4',
      name: 'GPT-5.4',
      description: 'OpenAI\'s flagship — unified reasoning + coding with 1M context',
      provider: 'OPENROUTER', nativeId: 'openai/gpt-5.4', cache: AUTO_CACHE },
    { id: 'openrouter/openai/gpt-5.4-mini',
      name: 'GPT-5.4 Mini',
      description: 'Fast, cheap variant of GPT-5.4 for high-throughput tasks',
      provider: 'OPENROUTER', nativeId: 'openai/gpt-5.4-mini', cache: AUTO_CACHE },
    { id: 'openrouter/openai/o3',
      name: 'o3',
      description: 'OpenAI reasoning model for hard multi-step problems',
      provider: 'OPENROUTER', nativeId: 'openai/o3', cache: AUTO_CACHE },
    { id: 'openrouter/anthropic/claude-opus-4.7',
      name: 'Claude Opus 4.7',
      description: 'Anthropic\'s flagship for long-running async agents',
      provider: 'OPENROUTER', nativeId: 'anthropic/claude-opus-4.7', cache: AUTO_CACHE },
    { id: 'openrouter/anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      description: 'Sonnet tuned for real-world agents and coding workflows',
      provider: 'OPENROUTER', nativeId: 'anthropic/claude-sonnet-4.6', cache: AUTO_CACHE },
    { id: 'openrouter/anthropic/claude-haiku-4.5',
      name: 'Claude Haiku 4.5',
      description: 'Near-frontier intelligence at Haiku latency and price',
      provider: 'OPENROUTER', nativeId: 'anthropic/claude-haiku-4.5', cache: AUTO_CACHE },
    { id: 'openrouter/google/gemini-3.1-pro',
      name: 'Gemini 3.1 Pro',
      description: 'Google\'s frontier Gemini with multimodal reasoning',
      provider: 'OPENROUTER', nativeId: 'google/gemini-3.1-pro-preview', cache: AUTO_CACHE },
    { id: 'openrouter/google/gemini-3.5-flash',
      name: 'Gemini 3.5 Flash',
      description: 'Frontier-speed Gemini — strongest coding/agentic Flash, 1M context',
      provider: 'OPENROUTER', nativeId: 'google/gemini-3.5-flash', cache: AUTO_CACHE },
    { id: 'openrouter/google/gemini-3-flash',
      name: 'Gemini 3 Flash',
      description: 'Fast Gemini 3 for high-volume workloads',
      provider: 'OPENROUTER', nativeId: 'google/gemini-3-flash-preview', cache: AUTO_CACHE },
    { id: 'openrouter/google/gemini-3.1-flash-lite',
      name: 'Gemini 3.1 Flash Lite',
      description: 'Ultra-cheap Gemini for simple tasks at $0.25/$1.50',
      provider: 'OPENROUTER', nativeId: 'google/gemini-3.1-flash-lite', cache: AUTO_CACHE },
    { id: 'openrouter/perplexity/sonar-pro',
      name: 'Sonar Pro',
      description: 'Web-grounded search for quick answers and topic summaries',
      provider: 'OPENROUTER', nativeId: 'perplexity/sonar-pro', cache: NO_CACHE },
    { id: 'openrouter/perplexity/sonar-reasoning-pro',
      name: 'Sonar Reasoning Pro',
      description: 'Deep reasoning with web grounding; multi-step chain of thought',
      provider: 'OPENROUTER', nativeId: 'perplexity/sonar-reasoning-pro', cache: NO_CACHE },
    { id: 'openrouter/perplexity/sonar-deep-research',
      name: 'Sonar Deep Research',
      description: 'Autonomous deep research — reads and synthesises across sources',
      provider: 'OPENROUTER', nativeId: 'perplexity/sonar-deep-research', cache: NO_CACHE },
  ] as const;

  // ============================================
  // TYPES
  // ============================================

  export type ModelId = typeof MODELS[number]['id'];
  export const ModelIds: ModelId[] = MODELS.map(m => m.id);
  export const DEFAULT_MODEL: ModelId = 'anthropic/claude-sonnet-4.5';

  export interface Model {
    id: ModelId;
    name: string;
    description: string;
    provider: Provider;
    nativeId: string;           // what the provider's SDK actually wants
    cache: CacheCapability;
  }

  // ============================================
  // UTILITIES
  // ============================================

  export const getModelById = (id: ModelId): Model | undefined =>
    MODELS.find(m => m.id === id) as Model | undefined;

  export const getModelsByProvider = (provider: Provider): Model[] =>
    MODELS.filter(m => m.provider === provider) as unknown as Model[];

  // Ids only — the common need when seeding a fresh key's enabled list.
  export const modelIdsFor = (provider: Provider): string[] =>
    getModelsByProvider(provider).map(m => m.id);

  // Keep only IDs that actually belong to `provider`. Defence against
  // stale UI state or hand-crafted requests from clients.
  export const filterByProvider = (provider: Provider, ids: string[]): string[] => {
    const allowed = new Set(modelIdsFor(provider));
    return ids.filter(id => allowed.has(id));
  };

  // The "which providers are needed" question for a user-facing model list.
  // Frontend filters models by activeKeys; this is the predicate behind it.
  export const requiresProvider = (modelId: ModelId): Provider => {
    const m = getModelById(modelId);
    if (!m) throw new Error(`Unknown model: ${modelId}`);
    return m.provider;
  };

  // Parse TTL string → seconds. Used at the DB/API boundary when a cache
  // config arrives as a string. Falls through to undefined on unknown values
  // so callers can reject them via their own Union.
  export const ttlSeconds = (modelId: ModelId, ttl: string): number | undefined => {
    const m = getModelById(modelId);
    if (!m?.cache.controllable) return undefined;
    return m.cache.ttlOptions.find(o => o.value === ttl)?.seconds;
  };

  // ============================================
  // RUN USAGE + ESTIMATED PRICING
  // --------------------------------------------
  // Normalized shape the worker persists + the UI reads. Provider-specific
  // token accounting lives only in the adapter; by the time RunUsage leaves
  // the AI service, everything is uniform.
  //
  // Deliberate omissions:
  //   - Anthropic cache-write tier surcharge (1.25× / 2×) — rolled into base.
  //   - Gemini CachedContent storage (per-hour, per-MB) — typically cents/day
  //     on realistic canvases; UI labels the estimate with ±10% honesty.
  //   - OR's markup — we use provider-direct rates. Labels say as much.
  // ============================================

  export type RunUsage = {
    inputTokens: number;     // total input INCLUDING cached (all providers normalized to this convention)
    outputTokens: number;
    cachedTokens: number;    // subset of inputTokens that hit a cache
    provider: Provider;
    modelId: ModelId;
  };

  export type Rates = {
    input: number;           // USD per 1M tokens
    output: number;
    cachedRead: number;      // USD per 1M tokens read from cache
  };

  // Rates approximated from each provider's public pricing as of 2026-04.
  // Update this table when a provider changes prices — historical runs
  // recompute automatically since cost is derived on-read, not stored.
  export const PRICING: Partial<Record<ModelId, Rates>> = {
    // Anthropic
    'anthropic/claude-opus-4.7':   { input: 15,   output: 75,  cachedRead: 1.5 },
    'anthropic/claude-sonnet-4.5': { input: 3,    output: 15,  cachedRead: 0.3 },
    // Google
    'google/gemini-3.1-pro':         { input: 1.25, output: 10,   cachedRead: 0.31 },
    'google/gemini-3.5-flash':       { input: 1.50, output: 9,    cachedRead: 0.15 },
    'google/gemini-3-flash':         { input: 0.15, output: 0.60, cachedRead: 0.04 },
    'google/gemini-3.1-flash-lite':  { input: 0.10, output: 0.40, cachedRead: 0.025 },
    // OpenAI
    'openai/gpt-4o':      { input: 2.50, output: 10,   cachedRead: 1.25 },
    'openai/gpt-4o-mini': { input: 0.15, output: 0.60, cachedRead: 0.075 },
  };

  // Pure cost estimate in USD. Uses base input rate for uncached tokens +
  // cachedRead rate for cached ones + output rate for completion. Returns
  // `undefined` when the model isn't in the price table — caller shows
  // "—" in the UI instead of a fake zero.
  export const costFor = (usage: RunUsage): number | undefined => {
    const rates = PRICING[usage.modelId];
    if (!rates) return undefined;
    const freshIn = Math.max(0, usage.inputTokens - usage.cachedTokens);
    const M = 1_000_000;
    return (
      (freshIn * rates.input) / M +
      (usage.cachedTokens * rates.cachedRead) / M +
      (usage.outputTokens * rates.output) / M
    );
  };

  // Cache hit ratio (0..1). 0 when no input tokens.
  export const cacheHitRatio = (usage: RunUsage): number =>
    usage.inputTokens > 0 ? usage.cachedTokens / usage.inputTokens : 0;
}
