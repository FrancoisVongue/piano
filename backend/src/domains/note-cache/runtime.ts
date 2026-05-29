import { Note, LLM } from '@piano/shared';
import { services } from '../../services/init';
import { resolveApiKey } from '../../services/ai/keys';
import { obs } from '../../services/observability';
import type { CompletionRequest } from '../../services/ai';

const log = obs.child({ domain: 'note-cache:runtime' });

// -----------------------------------------------------------------------------
// NoteCacheRuntime — single place for the "how" of per-node cache anchors.
//
// The user-facing morda (set/toggle/clear endpoints) lives in ./controller.
// Everything else — splitting the ancestor chain, building the AI-layer
// cacheDirective, persisting freshly-minted provider handles, invalidating
// stale ones — is orchestrated from here.
//
// Before this module the logic was smeared across three files (action/
// cache-split.ts, note-cache/controller.ts, services/ai/google.ts). One
// readable question, one file.
// -----------------------------------------------------------------------------

export type CacheSplit = {
  prefix: Note.Model[];
  fresh: Note.Model[];
  anchor: Note.Model | null;
};

// Split an ancestor chain [Root, ..., Parent] into (cached prefix, fresh tail)
// at the deepest enabled anchor for `modelId`. `anchor === prefix.at(-1)` when
// present — returned as a named convenience so callers don't index manually.
export const splitByAnchor = (
  ancestorsTopToBottom: Note.Model[],
  modelId: LLM.ModelId,
): CacheSplit => {
  for (let i = ancestorsTopToBottom.length - 1; i >= 0; i--) {
    const note = ancestorsTopToBottom[i]!;
    if (Note.CacheConfig.isActiveFor(note.cacheConfig, modelId)) {
      return {
        prefix: ancestorsTopToBottom.slice(0, i + 1),
        fresh: ancestorsTopToBottom.slice(i + 1),
        anchor: note,
      };
    }
  }
  // No match — enumerate what we DID see so the caller can tell whether the
  // cache was set for a different model, disabled, or never set at all.
  const survey = ancestorsTopToBottom
    .map(n => {
      const cfg = Note.CacheConfig.asConfig(n.cacheConfig);
      if (!cfg) return null;
      const entries = Object.entries(cfg).map(([m, e]) =>
        `${m}(${e.enabled ? 'on' : 'off'},${e.ttl})`);
      return entries.length ? `${n.id.slice(0, 6)}→[${entries.join(',')}]` : null;
    })
    .filter(Boolean);
  log.debug(
    {
      model: modelId,
      scanned: ancestorsTopToBottom.length,
      nodesWithAnyCacheConfig: survey.length,
      details: survey,
    },
    'splitByAnchor: no anchor',
  );
  return { prefix: [], fresh: ancestorsTopToBottom, anchor: null };
};

// Turn an in-memory anchor + model into the cacheDirective the AI layer
// wants. Pure — no DB, no remote calls. Returns undefined when the anchor
// has no live config or the model's TTL isn't recognized.
export const directiveFor = (
  anchor: Note.Model | null,
  modelId: LLM.ModelId,
): CompletionRequest['cacheDirective'] => {
  if (!anchor) return undefined;
  const entry = Note.CacheConfig.get(anchor.cacheConfig, modelId);
  if (!entry) return undefined;
  const ttlSeconds = LLM.ttlSeconds(modelId, entry.ttl);
  if (!ttlSeconds) return undefined;

  const rt = Note.CacheConfig.liveRuntime(anchor.cacheConfig, modelId);
  const existingHandle = rt
    ? { handle: rt.handle, expiresAt: new Date(rt.expiresAt) }
    : undefined;

  return { ttlSeconds, existingHandle };
};

// Persist a freshly-minted provider handle into the anchor's cacheConfig.
// Single UPDATE — the in-memory anchor already carries its current config.
// (Race: if a concurrent run wrote its own handle, we clobber it; orphan
// auto-expires server-side. Cheap enough to not solve.)
export const persistHandle = async (input: {
  anchor: Note.Model;
  modelId: LLM.ModelId;
  handle: string;
  expiresAt: Date;
  tokens: number;
}) => {
  const next = Note.CacheConfig.withRuntime(input.anchor.cacheConfig, input.modelId, {
    handle: input.handle,
    expiresAt: input.expiresAt.toISOString(),
    tokens: input.tokens,
  });
  await services.prisma.note.update({
    where: { id: input.anchor.id },
    data: { cacheConfig: next as any },
  });
};

// Best-effort: tell the provider to drop the remote handle. Failure here
// is acceptable — unused handles auto-expire and storage cost is small.
export const deleteRemote = async (
  userId: string,
  modelId: LLM.ModelId,
  handle: string,
): Promise<void> => {
  const key = await resolveApiKey(userId, modelId);
  if (key.tag !== 'ok') return;
  await services.ai.deleteCache(modelId, key.data, handle);
};

// Content on `noteId` changed — every provider handle anchored here now
// references stale bytes. Nuke remote handles + strip runtime blocks from
// cacheConfig (keep ttl/enabled intact so next run mints fresh).
//
// Consumed by Arrangement.patch; also callable standalone.
export const forgetAllHandles = async (userId: string, noteId: string): Promise<void> => {
  const note = await services.prisma.note.findUnique({
    where: { id: noteId },
    select: { cacheConfig: true },
  });
  const config = Note.CacheConfig.asConfig(note?.cacheConfig);
  if (!config) return;

  const removals: Promise<void>[] = [];
  let next: Note.CacheConfig.Config = config;
  for (const [modelId, entry] of Object.entries(config)) {
    if (entry.runtime) {
      removals.push(deleteRemote(userId, modelId as LLM.ModelId, entry.runtime.handle));
      next = Note.CacheConfig.withoutRuntime(next, modelId);
    }
  }
  if (removals.length === 0) return;
  await Promise.all(removals);
  await services.prisma.note.update({
    where: { id: noteId },
    data: { cacheConfig: Object.keys(next).length === 0 ? null : (next as any) },
  });
};
