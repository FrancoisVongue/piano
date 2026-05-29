import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { match } from 'venum';
import { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId, paramId } from '../../shared/lib/sessionAuth';
import { ActionController } from './index';
import { Action } from '@piano/shared';

const sendNotFound = (res: Response) => ({
  notFound: (err: { message: string }) => res.status(404).json({ error: err }),
});

export const createActionRouter = (services: Services): Router => {
  const router = Router();
  router.use(sessionAuth(services));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const action = await ActionController.create(authUserId(req), Action.validate.create(req.body));
    res.status(201).json(action);
  }));

  router.post('/seed-defaults', asyncHandler(async (req: Request, res: Response) => {
    const data = z.array(Action.DTO.CreateSchema).parse(req.body);
    const actions = await ActionController.seedDefaults(authUserId(req), data);
    res.status(201).json(actions);
  }));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json(await ActionController.findByUser(authUserId(req)));
  }));

  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const r = await ActionController.findById(paramId(req), authUserId(req));
    match(r, { ok: (d) => res.json(d), ...sendNotFound(res) });
  }));

  router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
    const r = await ActionController.update(paramId(req), authUserId(req), Action.validate.update(req.body));
    match(r, { ok: (d) => res.json(d), ...sendNotFound(res) });
  }));

  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const r = await ActionController.delete(paramId(req), authUserId(req));
    match(r, { ok: (d) => res.json(d), ...sendNotFound(res) });
  }));

  return router;
};
