import { Router } from 'express';
import { match } from 'venum';
import { Files } from '@piano/shared';
import { FileController } from './controller';
import type { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId, paramId } from '../../shared/lib/sessionAuth';
import { sendDaemonError } from '../../services/daemon.adapter';

// Files are scoped per-machine — `:machineId` resolves to a daemon target
// via targetForMachine (cf. multi-daemon support).
export const createFilesRouter = (services: Services) => {
  const router = Router();
  router.use(sessionAuth(services));

  router.get('/:machineId/list', asyncHandler(async (req, res) => {
    const { path } = Files.validate.listQuery(req.query);
    const result = await FileController.list(authUserId(req), paramId(req, 'machineId'), path);
    match(result, {
      ok: (data) => res.json({ success: data }),
      ...sendDaemonError(res),
    });
  }));

  router.get('/:machineId/read', asyncHandler(async (req, res) => {
    const { path, maxBytes } = Files.validate.readQuery(req.query);
    const result = await FileController.read(authUserId(req), paramId(req, 'machineId'), path, maxBytes);
    match(result, {
      ok: (data) => res.json({ success: data }),
      ...sendDaemonError(res),
    });
  }));

  return router;
};
