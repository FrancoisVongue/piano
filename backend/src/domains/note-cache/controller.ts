import { venum } from 'venum';
import { services } from '../../services/init';
import { Note, LLM } from '@piano/shared';
import * as Runtime from './runtime';
import { obs } from '../../services/observability';

const log = obs.child({ domain: 'note-cache:controller' });

// -----------------------------------------------------------------------------
// Note cache controller — user-facing lifecycle of per-model cache anchors.
//
// Three user stories:
//   1. set(ttl, enabled)  — "make this node a cache anchor for model X"
//   2. toggle(enabled)    — flip the switch without losing TTL choice
//   3. clear()            — remove the anchor entirely (and nuke any
//                            stateful handle the provider still holds)
//
// Everything runtime-flavored (persist handle, delete remote, bulk-invalidate)
// lives in ./runtime — we only handle the HTTP-shaped config writes here.
// -----------------------------------------------------------------------------

const findOwnedNote = async (userId: string, noteId: string) =>
  services.prisma.note.findFirst({ where: { id: noteId, userId } });

const validateModel = (modelId: string) => {
  const model = LLM.getModelById(modelId as LLM.ModelId);
  if (!model) return venum('invalidInput', { message: `Unknown model: ${modelId}` });
  if (!model.cache.controllable) {
    return venum('invalidInput', {
      message: `Model ${modelId} does not support user-controlled caching (automatic only).`,
    });
  }
  return venum('ok', model);
};

const writeConfig = (noteId: string, nextConfig: Note.CacheConfig.Config) => {
  const value = Object.keys(nextConfig).length === 0 ? null : (nextConfig as any);
  return services.prisma.note.update({ where: { id: noteId }, data: { cacheConfig: value } });
};

export class NoteCacheController {
  // Set or replace the anchor for (note, model). TTL change ⇒ drop the old
  // runtime handle (bytes stay valid, but duration changed).
  static async set(userId: string, noteId: string, dto: Note.CacheConfig.Set) {
    const model = validateModel(dto.modelId);
    if (model.tag !== 'ok') return model;

    if (LLM.ttlSeconds(model.data.id, dto.ttl) === undefined) {
      return venum('invalidInput', {
        message: `TTL '${dto.ttl}' is not valid for ${dto.modelId}.`,
      });
    }

    const note = await findOwnedNote(userId, noteId);
    if (!note) return venum('notFound', { message: 'Note not found' });

    const existing = note.cacheConfig;
    const prev = Note.CacheConfig.get(existing, dto.modelId);

    // Drop the old handle remotely when the caller asked for a new TTL —
    // the cached bytes are still valid but their lifetime isn't.
    if (prev && prev.ttl !== dto.ttl && prev.runtime) {
      await Runtime.deleteRemote(userId, dto.modelId as LLM.ModelId, prev.runtime.handle);
    }

    const nextConfig = Note.CacheConfig.withModel(
      existing,
      dto.modelId,
      Note.CacheConfig.upsertEntry(prev, dto),
    );
    await writeConfig(noteId, nextConfig);
    log.info(
      {
        noteId,
        model: dto.modelId,
        ttl: dto.ttl,
        enabled: dto.enabled,
        prev: prev ? { ttl: prev.ttl, enabled: prev.enabled } : null,
      },
      'cache config set',
    );
    return venum('ok', nextConfig);
  }

  // Flip enabled without losing TTL or the runtime handle. User might
  // re-enable soon and still benefit from the same cached bytes.
  static async toggle(userId: string, noteId: string, dto: Note.CacheConfig.Toggle) {
    const model = validateModel(dto.modelId);
    if (model.tag !== 'ok') return model;

    const note = await findOwnedNote(userId, noteId);
    if (!note) return venum('notFound', { message: 'Note not found' });

    const entry = Note.CacheConfig.get(note.cacheConfig, dto.modelId);
    if (!entry) {
      return venum('invalidInput', {
        message: `No cache configured for ${dto.modelId} — use set() to add one first.`,
      });
    }

    const nextConfig = Note.CacheConfig.withModel(note.cacheConfig, dto.modelId, {
      ...entry,
      enabled: dto.enabled,
    });
    await writeConfig(noteId, nextConfig);
    return venum('ok', nextConfig);
  }

  // Remove the anchor entry entirely + nuke the remote handle.
  static async clear(userId: string, noteId: string, modelId: string) {
    const model = validateModel(modelId);
    if (model.tag !== 'ok') return model;

    const note = await findOwnedNote(userId, noteId);
    if (!note) return venum('notFound', { message: 'Note not found' });

    const entry = Note.CacheConfig.get(note.cacheConfig, modelId);
    if (entry?.runtime) {
      await Runtime.deleteRemote(userId, modelId as LLM.ModelId, entry.runtime.handle);
    }

    const nextConfig = Note.CacheConfig.withoutModel(note.cacheConfig, modelId);
    await writeConfig(noteId, nextConfig);
    return venum('ok', nextConfig);
  }

  // Called by Arrangement.patch when a note's content changes.
  static invalidateAllHandles = Runtime.forgetAllHandles;
}
