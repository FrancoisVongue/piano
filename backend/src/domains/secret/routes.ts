import { Router } from 'express';
import { match } from 'venum';
import { Secret } from '@piano/shared';
import { SecretController } from './controller';
import type { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId, paramId } from '../../shared/lib/sessionAuth';

export const createSecretRouter = (services: Services) => {
  const router = Router();
  router.use(sessionAuth(services));

  router.get('/', asyncHandler(async (req, res) => {
    const secrets = await SecretController.list(authUserId(req));
    res.json({ success: secrets });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const dto = Secret.validate.create(req.body);
    const result = await SecretController.create(authUserId(req), dto);
    match(result, {
      ok: (data) => res.status(201).json({ success: data }),
    });
  }));

  router.put('/:id', asyncHandler(async (req, res) => {
    const dto = Secret.validate.update(req.body);
    const result = await SecretController.update(authUserId(req), paramId(req), dto);
    match(result, {
      ok: (data) => res.json({ success: data }),
      notFound: (err) => res.status(404).json({ error: err }),
    });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const result = await SecretController.delete(authUserId(req), paramId(req));
    match(result, {
      ok: () => res.json({ success: true }),
      notFound: (err) => res.status(404).json({ error: err }),
    });
  }));

  return router;
};
