import { Router } from 'express';
import { match } from 'venum';
import { z } from 'zod';
import { MachineTemplate } from '@piano/shared';
import { MachineTemplateController } from './controller';
import type { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId, paramId } from '../../shared/lib/sessionAuth';
import { sendDaemonError } from '../../services/daemon.adapter';

const CreateMachineSchema = z.object({
  machineId: z.string().min(1),
  templateId: z.string().optional().default(''),
  // Required: every new machine has to live on a specific daemon.
  daemonId: z.string().min(1),
});
const SandboxSchema = z.object({
  templateId: z.string().optional().default(''),
  daemonId: z.string().min(1),
  // Optional user-supplied name → becomes the container hostname (shell prompt).
  // Daemon normalises it; empty/missing → falls back to sandboxId.
  name: z.string().max(128).optional(),
});
const SandboxCleanupSchema = z.object({
  // Sandbox machines have no Note row — frontend tracks daemonId itself.
  daemonId: z.string().min(1),
});

export const createTemplateRouter = (services: Services) => {
  const router = Router();
  router.use(sessionAuth(services));

  router.get('/', asyncHandler(async (req, res) => {
    const templates = await MachineTemplateController.list(authUserId(req));
    res.json({ success: templates });
  }));

  router.post('/save', asyncHandler(async (req, res) => {
    const dto = MachineTemplate.validate.saveFromMachine(req.body);
    const result = await MachineTemplateController.saveFromMachine(authUserId(req), dto);
    match(result, {
      ok: (data) => res.status(201).json({ success: data }),
      ...sendDaemonError(res),
    });
  }));

  router.post('/create-machine', asyncHandler(async (req, res) => {
    const { machineId, templateId, daemonId } = CreateMachineSchema.parse(req.body ?? {});
    const result = await MachineTemplateController.createMachineFromTemplate(
      authUserId(req), machineId, templateId, daemonId,
    );
    match(result, {
      ok: (data) => res.status(201).json({ success: data }),
      notFound: (err) => res.status(404).json({ error: err }),
      ...sendDaemonError(res),
    });
  }));

  router.post('/sandbox', asyncHandler(async (req, res) => {
    const { templateId, daemonId, name } = SandboxSchema.parse(req.body ?? {});
    const result = await MachineTemplateController.createSandbox(authUserId(req), templateId, daemonId, name);
    match(result, {
      ok: (data) => res.status(201).json({ success: data }),
      notFound: (err) => res.status(404).json({ error: err }),
      ...sendDaemonError(res),
    });
  }));

  router.post('/sandbox/:id/cleanup', asyncHandler(async (req, res) => {
    const { daemonId } = SandboxCleanupSchema.parse(req.body ?? {});
    const result = await MachineTemplateController.cleanupSandbox(authUserId(req), paramId(req), daemonId);
    match(result, {
      ok: () => res.json({ success: true }),
      notFound: (err) => res.status(404).json({ error: err }),
      ...sendDaemonError(res),
    });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const result = await MachineTemplateController.delete(authUserId(req), paramId(req));
    match(result, {
      ok: () => res.json({ success: true }),
      notFound: (err) => res.status(404).json({ error: err }),
      forbidden: (err) => res.status(403).json({ error: err }),
    });
  }));

  return router;
};
