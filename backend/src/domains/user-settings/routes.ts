import { Request, Response, Router } from 'express';
import { match } from 'venum';
import { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId } from '../../shared/lib/sessionAuth';
import { UserSettingsController } from './controller';
import { User, UserApiKey } from '@piano/shared';

export const createUserSettingsRouter = (services: Services): Router => {
  const router = Router();

  router.use(sessionAuth(services));

  // ============ PROFILE ============

  router.get('/profile', asyncHandler(async (req: Request, res: Response) => {
    const profile = await UserSettingsController.getProfile(authUserId(req));
    if (!profile) return res.status(404).json({ error: 'User not found' });
    res.json(profile);
  }));

  router.patch('/profile', asyncHandler(async (req: Request, res: Response) => {
    const profile = await UserSettingsController.updateProfile(
      authUserId(req), User.validate.updateProfile(req.body),
    );
    res.json(profile);
  }));

  // ============ API KEYS (BYOK) ============

  router.get('/api-keys', asyncHandler(async (req: Request, res: Response) => {
    res.json({ keys: await UserSettingsController.getApiKeys(authUserId(req)) });
  }));

  router.post('/api-keys', asyncHandler(async (req: Request, res: Response) => {
    const data = UserApiKey.validate.upsert(req.body);
    const key = await UserSettingsController.upsertApiKey(authUserId(req), data.provider, data.apiKey);
    res.status(201).json({ success: true, key });
  }));

  router.delete('/api-keys/:provider', asyncHandler(async (req: Request, res: Response) => {
    const provider = UserApiKey.validate.provider(req.params.provider);
    await UserSettingsController.deleteApiKey(authUserId(req), provider);
    res.json({ success: true, provider });
  }));

  // Per-provider model visibility. PATCH replaces the list wholesale —
  // simpler than add/remove endpoints for a 6-checkbox UI.
  router.patch('/api-keys/:provider/models', asyncHandler(async (req: Request, res: Response) => {
    const provider = UserApiKey.validate.provider(req.params.provider);
    const { modelIds } = UserApiKey.validate.setEnabledModels(req.body);
    const r = await UserSettingsController.setEnabledModels(authUserId(req), provider, modelIds);
    match(r, {
      ok: (key) => res.json({ key }),
      notFound: (err) => res.status(404).json({ error: err }),
    });
  }));

  // Model catalog pre-filtered by the user's active keys + checkbox state.
  router.get('/active-models', asyncHandler(async (req: Request, res: Response) => {
    const models = await UserSettingsController.getActiveModels(authUserId(req));
    res.json({ models });
  }));

  return router;
};
