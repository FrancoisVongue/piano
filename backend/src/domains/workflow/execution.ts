import { venum } from 'venum';
import { services } from '../../services/init';
import { Workflow, Note } from '@piano/shared';
import { Subjects } from '../../services/nats';

// -----------------------------------------------------------------------------
// Workflow execution — HTTP entry point. Validates ownership of every
// referenced entity (workflow + target node + every action used in any
// level), then publishes a single trigger to NATS. The actual fan-out is
// done by the Temporal orchestrator (executeWorkflowWorkflow), which calls
// executeActionWorkflow as a child workflow per cell.
//
// Variants:
//   ok           → 202, { runId, workflowId, targetNoteId }
//   notFound     → 404 (workflow / target / referenced action missing or unowned)
//   invalidInput → 400 (workflow has no levels, or target isn't a content note)
// -----------------------------------------------------------------------------

export type RunInvocation = {
  workflowId: string;
  targetNoteId: string;
  model: string;
  userId: string;
};

const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const run = async (inv: RunInvocation) => {
  const { workflowId, targetNoteId, model, userId } = inv;

  const wf = await services.prisma.workflow.findFirst({
    where: { id: workflowId, userId },
  });
  if (!wf) return venum('notFound', { message: `Workflow ${workflowId} not found or access denied` });

  const levels = Array.isArray(wf.levels) ? (wf.levels as unknown as Workflow.Level[]) : [];
  if (levels.length === 0) {
    return venum('invalidInput', { message: 'Workflow has no levels to run' });
  }

  // All actions referenced anywhere in the workflow must exist and belong
  // to the caller. One round-trip — set semantics, then membership check.
  const actionIds = Array.from(new Set(levels.map(l => l.actionId)));
  const actions = await services.prisma.action.findMany({
    where: { id: { in: actionIds }, userId },
    select: { id: true },
  });
  if (actions.length !== actionIds.length) {
    const found = new Set(actions.map(a => a.id));
    const missing = actionIds.filter(id => !found.has(id));
    return venum('notFound', { message: `Action(s) not found or access denied: ${missing.join(', ')}` });
  }

  const note = await services.prisma.note.findFirst({
    where: { id: targetNoteId, userId },
    select: { id: true, type: true, arrangementId: true },
  });
  if (!note) return venum('notFound', { message: `Target note ${targetNoteId} not found or access denied` });
  if (!Note.capabilities({ type: note.type as Note.Type }).canRunAction) {
    return venum('invalidInput', { message: `Cannot run workflow on node of type ${note.type}` });
  }

  const runId = `wfrun-${workflowId.slice(0, 6)}-${stamp()}`;
  const job: Workflow.Job.Run = {
    workflowId,
    runId,
    targetNoteId,
    arrangementId: note.arrangementId,
    userId,
    model,
  };

  await services.nats.publishToQueue(Subjects.AIWorkflow, job, 5);

  return venum('ok', { runId, workflowId, targetNoteId });
};
