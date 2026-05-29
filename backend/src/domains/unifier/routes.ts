import { Request, Response, Router } from 'express';
import { match } from 'venum';
import { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId, paramId } from '../../shared/lib/sessionAuth';
import { UnifierController } from './index';
import { Unifier } from '@piano/shared';

const sendNotFound = (res: Response) => ({
  notFound: (err: { message: string }) => res.status(404).json({ error: err }),
});

export const createUnifierRouter = (services: Services): Router => {
  const router = Router();
  router.use(sessionAuth(services));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const unifier = await UnifierController.create(authUserId(req), Unifier.validate.create(req.body));
    res.status(201).json(unifier);
  }));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json(await UnifierController.findByUser(authUserId(req)));
  }));

  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const r = await UnifierController.findById(paramId(req), authUserId(req));
    match(r, { ok: (d) => res.json(d), ...sendNotFound(res) });
  }));

  router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
    const r = await UnifierController.update(paramId(req), authUserId(req), Unifier.validate.update(req.body));
    match(r, { ok: (d) => res.json(d), ...sendNotFound(res) });
  }));

  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const r = await UnifierController.delete(paramId(req), authUserId(req));
    match(r, { ok: (d) => res.json(d), ...sendNotFound(res) });
  }));

  return router;
};
