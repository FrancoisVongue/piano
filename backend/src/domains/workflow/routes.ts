import { Request, Response, Router } from 'express';
import { match } from 'venum';
import { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId, paramId } from '../../shared/lib/sessionAuth';
import { WorkflowController } from './index';
import { Workflow } from '@piano/shared';

const sendNotFound = (res: Response) => ({
  notFound: (err: { message: string }) => res.status(404).json({ error: err }),
});
const sendInvalidInput = (res: Response) => ({
  invalidInput: (err: { message: string }) => res.status(400).json({ error: err }),
});

export const createWorkflowRouter = (services: Services): Router => {
  const router = Router();
  router.use(sessionAuth(services));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const wf = await WorkflowController.create(authUserId(req), Workflow.validate.create(req.body));
    res.status(201).json(wf);
  }));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json(await WorkflowController.findByUser(authUserId(req)));
  }));

  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const r = await WorkflowController.findById(paramId(req), authUserId(req));
    match(r, { ok: (d) => res.json(d), ...sendNotFound(res) });
  }));

  router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
    const r = await WorkflowController.update(paramId(req), authUserId(req), Workflow.validate.update(req.body));
    match(r, { ok: (d) => res.json(d), ...sendNotFound(res) });
  }));

  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const r = await WorkflowController.delete(paramId(req), authUserId(req));
    match(r, { ok: (d) => res.json(d), ...sendNotFound(res) });
  }));

  // POST /api/workflows/:id/run → 202 Accepted, returns runId.
  router.post('/:id/run', asyncHandler(async (req: Request, res: Response) => {
    const dto = Workflow.validate.run(req.body);
    const r = await WorkflowController.run({
      workflowId: paramId(req),
      targetNoteId: dto.targetNoteId,
      model: dto.model,
      userId: authUserId(req),
    });
    match(r, {
      ok: (d) => res.status(202).json(d),
      ...sendNotFound(res),
      ...sendInvalidInput(res),
    });
  }));

  return router;
};
