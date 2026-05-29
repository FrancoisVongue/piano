import { Router } from 'express';
import { match } from 'venum';
import { z } from 'zod';
import { MachineController } from './controller';
import { DaemonController } from '../daemon/controller';
import type { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId, paramId } from '../../shared/lib/sessionAuth';
import { sendDaemonError } from '../../services/daemon.adapter';

const ChildIdSchema = z.object({
  childId: z.string().min(1),
  machineName: z.string().trim().min(1).max(128).optional(),
});
const FreezeSchema = z.object({ name: z.string().min(1).max(80).trim().optional() });
const DeactivateSchema = z.object({ machineId: z.string().min(1) });
const PaneIdSchema = z.object({ paneId: z.string().min(1) });

export const createMachineRouter = (services: Services) => {
  const router = Router();
  router.use(sessionAuth(services));

  router.post('/:id/freeze', asyncHandler(async (req, res) => {
    const { name } = FreezeSchema.parse(req.body ?? {});
    const result = await MachineController.freeze(authUserId(req), paramId(req), name);
    match(result, { ok: (d) => res.json({ success: d }), ...sendDaemonError(res) });
  }));

  router.post('/:id/branch', asyncHandler(async (req, res) => {
    const { childId, machineName } = ChildIdSchema.parse(req.body);
    const result = await MachineController.branch(authUserId(req), paramId(req), childId, machineName);
    match(result, { ok: (d) => res.status(201).json({ success: d }), ...sendDaemonError(res) });
  }));

  router.post('/:id/share', asyncHandler(async (req, res) => {
    const { childId } = ChildIdSchema.parse(req.body);
    const result = await MachineController.share(authUserId(req), paramId(req), childId);
    match(result, { ok: (d) => res.status(201).json({ success: d }), ...sendDaemonError(res) });
  }));

  router.post('/:id/activate', asyncHandler(async (req, res) => {
    const result = await MachineController.activate(authUserId(req), paramId(req));
    match(result, { ok: (d) => res.json({ success: d }), ...sendDaemonError(res) });
  }));

  router.post('/deactivate', asyncHandler(async (req, res) => {
    const { machineId } = DeactivateSchema.parse(req.body ?? {});
    const result = await MachineController.deactivate(authUserId(req), machineId);
    match(result, { ok: () => res.json({ success: true }), ...sendDaemonError(res) });
  }));

  router.post('/:id/ssh', asyncHandler(async (req, res) => {
    const result = await MachineController.startSsh(authUserId(req), paramId(req));
    match(result, { ok: (d) => res.json({ success: d }) });
  }));

  router.get('/:id/output', asyncHandler(async (req, res) => {
    const result = await MachineController.getOutput(authUserId(req), paramId(req));
    match(result, { ok: (d) => res.json({ success: d }), ...sendDaemonError(res) });
  }));

  // In-window pane lifecycle. Same daemon substrate as `share`, but no
  // canvas Note row is created — the pane is layout-state owned by the
  // frontend's MachineWindow.Layout. Routed by parent machineId.
  router.post('/:id/panes', asyncHandler(async (req, res) => {
    const { paneId } = PaneIdSchema.parse(req.body);
    const result = await MachineController.spawnPane(authUserId(req), paramId(req), paneId);
    match(result, { ok: (d) => res.status(201).json({ success: d }), ...sendDaemonError(res) });
  }));

  router.delete('/:id/panes/:paneId', asyncHandler(async (req, res) => {
    const result = await MachineController.closePane(
      authUserId(req),
      paramId(req),
      paramId(req, 'paneId'),
    );
    match(result, { ok: (d) => res.json({ success: d }), ...sendDaemonError(res) });
  }));

  // Mint a per-machine bearer token for the /api/canvas/* surface. Returns
  // plaintext ONCE; persisted as a sha256 hash. See domains/canvas-gateway
  // and shared/lib/machineAuth.ts for how the token gets used downstream.
  router.post('/:id/canvas-token', asyncHandler(async (req, res) => {
    const result = await MachineController.issueCanvasToken(authUserId(req), paramId(req));
    match(result, {
      ok:       (data) => res.status(201).json({ success: data }),
      notFound: (err)  => res.status(404).json({ error: err }),
    });
  }));

  router.get('/:id/ssh-info', asyncHandler(async (req, res) => {
    const result = await DaemonController.sshInfoForMachine(authUserId(req), paramId(req));
    match(result, {
      ok:       (data) => res.json({ success: data }),
      notFound: (err)  => res.status(404).json({ error: err }),
      offline:  (err)  => res.status(503).json({ error: err }),
    });
  }));

  return router;
};
