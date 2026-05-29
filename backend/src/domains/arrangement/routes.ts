import { Router, Response } from 'express';
import { match } from 'venum';
import { z } from 'zod';
import { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId, paramId } from '../../shared/lib/sessionAuth';
import { sendDaemonError } from '../../services/daemon.adapter';
import { ArrangementController } from './controller';
import { ActionController } from '../action';
import { UnifierController } from '../unifier';
import { Arrangement, Note } from '@piano/shared';

// Shared route-level venum → HTTP mappers. Handlers compose these spreads
// into their `match` call, so the status-code policy lives in ONE place and
// can't drift between endpoints.
const http404 = (res: Response) => ({
  notFound: (err: { message: string }) => res.status(404).json({ error: err }),
});
const http400 = (res: Response) => ({
  invalidSource: (err: { message: string }) => res.status(400).json({ error: err }),
  invalidInput: (err: { message: string }) => res.status(400).json({ error: err }),
});

const ActionBodySchema = z.object({ noteIds: z.array(z.string().min(1)).min(1) });
const UnifierBodySchema = z.object({
  noteIds: z.array(z.string().min(1)).min(1),
  userPrompt: z.string().max(5000).optional(),
  model: z.string().min(1),
});

export const createArrangementRouter = (services: Services): Router => {
  const router = Router();
  router.use(sessionAuth(services));

  // =========== ARRANGEMENT CRUD ===========

  router.post('/', asyncHandler(async (req, res) => {
    const data = Arrangement.validate.create(req.body);
    const r = await ArrangementController.create(
      { title: data.title, tags: data.tags },
      authUserId(req),
    );
    match(r, { ok: (d) => res.status(201).json(d), ...http400(res) });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const result = await ArrangementController.delete(paramId(req));
    res.status(200).send(result);
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const updateData = Arrangement.validate.update(req.body);
    const r = await ArrangementController.update(paramId(req), authUserId(req), updateData);
    match(r, { ok: (d) => res.status(200).json(d), ...http400(res) });
  }));

  router.get('/', asyncHandler(async (req, res) => {
    const result = (await ArrangementController.findByUser(authUserId(req))) || [];
    res.json(result);
  }));

  router.get('/machines', asyncHandler(async (req, res) => {
    // Mission Control: arrangements with their machine/terminal notes.
    res.json(await ArrangementController.findAllWithMachines(authUserId(req)));
  }));

  router.delete('/:id/machines', asyncHandler(async (req, res) => {
    const r = await ArrangementController.deleteAllMachines(paramId(req), authUserId(req));
    match(r, {
      ok: (data) => res.json({ success: data }),
      ...http404(res),
      ...sendDaemonError(res),
    });
  }));

  router.post('/:id/patch', asyncHandler(async (req, res) => {
    const payload = Note.validate.patchPayload(req.body);
    const r = await ArrangementController.patch(paramId(req), authUserId(req), payload);
    match(r, { ok: (d) => res.status(200).json(d), ...http404(res) });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    res.json(await ArrangementController.findById(paramId(req), authUserId(req)));
  }));

  // =========== ACTIONS & UNIFIERS ===========

  router.post('/:id/execute-action', asyncHandler(async (req, res) => {
    const r = await ActionController.executeActionWithOptimisticUpdate(
      { arrangementId: paramId(req), userId: authUserId(req) },
      Arrangement.validate.executeAction(req.body),
    );
    match(r, {
      ok: (data) => res.status(200).json(data),
      ...http404(res),
      ...http400(res),
    });
  }));

  router.post('/:arrangementId/actions/:actionId', asyncHandler(async (req, res) => {
    const { noteIds } = ActionBodySchema.parse(req.body);
    const r = await ActionController.executeAction(
      { arrangementId: paramId(req, 'arrangementId'), userId: authUserId(req) },
      { actionId: paramId(req, 'actionId'), noteIds },
    );
    match(r, {
      ok: (data) => res.status(202).json(data),
      ...http404(res),
      ...http400(res),
    });
  }));

  router.post('/:arrangementId/unifiers/:unifierId', asyncHandler(async (req, res) => {
    const { noteIds, userPrompt, model } = UnifierBodySchema.parse(req.body);
    const r = await UnifierController.executeUnifier(
      { arrangementId: paramId(req, 'arrangementId'), userId: authUserId(req) },
      { unifierId: paramId(req, 'unifierId'), noteIds, userPrompt, model },
    );
    match(r, {
      ok: (data) => res.status(202).json(data),
      ...http404(res),
      ...http400(res),
    });
  }));

  return router;
};
