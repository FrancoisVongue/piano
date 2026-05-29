import { Router, Response } from 'express';
import { match } from 'venum';
import { Note } from '@piano/shared';
import { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId, paramId } from '../../shared/lib/sessionAuth';
import { NoteCacheController } from './controller';

// Per-note, per-model cache anchor endpoints.
// Policy map: notFound → 404, invalidInput → 400, ok → 200.
const http404 = (res: Response) => ({
  notFound: (err: { message: string }) => res.status(404).json({ error: err }),
});
const http400 = (res: Response) => ({
  invalidInput: (err: { message: string }) => res.status(400).json({ error: err }),
});

export const createNoteCacheRouter = (services: Services): Router => {
  const router = Router();
  router.use(sessionAuth(services));

  // PUT /notes/:id/cache  — set-or-replace anchor for a given model
  router.put('/:id/cache', asyncHandler(async (req, res) => {
    const dto = Note.CacheConfig.validate.set(req.body);
    const r = await NoteCacheController.set(authUserId(req), paramId(req), dto);
    match(r, {
      ok: (config) => res.json(config),
      ...http404(res),
      ...http400(res),
    });
  }));

  // POST /notes/:id/cache/toggle  — flip enabled without losing TTL
  router.post('/:id/cache/toggle', asyncHandler(async (req, res) => {
    const dto = Note.CacheConfig.validate.toggle(req.body);
    const r = await NoteCacheController.toggle(authUserId(req), paramId(req), dto);
    match(r, {
      ok: (config) => res.json(config),
      ...http404(res),
      ...http400(res),
    });
  }));

  // DELETE /notes/:id/cache/:modelId  — remove anchor + nuke remote handle
  router.delete('/:id/cache/:modelId', asyncHandler(async (req, res) => {
    const modelId = paramId(req, 'modelId');
    const r = await NoteCacheController.clear(authUserId(req), paramId(req), modelId);
    match(r, {
      ok: (config) => res.json(config),
      ...http404(res),
      ...http400(res),
    });
  }));

  return router;
};
