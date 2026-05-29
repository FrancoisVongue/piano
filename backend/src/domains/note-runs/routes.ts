import { Router } from 'express';
import { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId, paramId } from '../../shared/lib/sessionAuth';
import { NoteRunsController } from './controller';

export const createNoteRunsRouter = (services: Services): Router => {
  const router = Router();
  router.use(sessionAuth(services));

  // Info dialog payload. Returns the latest run that produced this note
  // (tokens + model + timestamp); 204 when there is no run yet.
  router.get('/:id/latest-run', asyncHandler(async (req, res) => {
    const run = await NoteRunsController.latestForNote(authUserId(req), paramId(req));
    if (!run) return res.status(204).send();
    res.json({ run });
  }));

  return router;
};
