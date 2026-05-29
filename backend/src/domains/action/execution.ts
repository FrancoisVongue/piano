import { venum } from 'venum';
import { services } from '../../services/init';
import { Action, Note, Arrangement, Canvas } from '@piano/shared';
import { Subjects } from '../../services/nats';
import { InvocationCtx } from '../../shared/lib/invocation';
import { getAncestorsForAllPaths } from './ancestors';
import { createChildNode } from './shared';
import { ArrangementController } from '../arrangement/controller';
import * as Optimistic from './optimistic';
import * as NoteDb from '../arrangement/adapters/db';

// Batched action: run a single action over many notes combined. Distinct from
// the single-node optimistic flow because the caller has already decided the
// exact source set; there is no Cartesian fan-out and no per-note ancestry.
export type BatchInvocation = { actionId: string; noteIds: string[] };

// -----------------------------------------------------------------------------
// Action execution. HTTP entry points only. No throws.
// Variants routes map to HTTP: ok→200/202, notFound→404,
// invalidSource→400, invalidInput→400, invalidReparent→(from Arrangement.patch).
// `notFound` intentionally conflates "missing" and "not owned" — leaking the
// distinction would be an ID-probe oracle.
// -----------------------------------------------------------------------------

// PUBLIC. Run an action on a single node with optimistic UI and Cartesian
// fan-out over ancestor paths. Six steps, top to bottom, as prose.
export const executeWithOptimisticUpdate = async (
  ctx: InvocationCtx,
  dto: Arrangement.DTO.ExecuteAction,
) => {
  const { nodeId, patchPayload } = dto;

  // 1. Apply any in-flight client edits. Running against a stale world is
  //    worse than returning an error.
  if (patchPayload) {
    const patched = await ArrangementController.patch(ctx.arrangementId, ctx.userId, patchPayload);
    if (patched.tag !== 'ok') return patched;
  }

  // 2. The API boundary never trusts the client — re-check capability.
  const src = await validateActionSource(nodeId);
  if (src.tag !== 'ok') return src;

  // 3. Resolve the action definition (ownership-scoped).
  const fetched = await fetchAction(dto.actionId, ctx.userId);
  if (fetched.tag !== 'ok') return fetched;
  const action = fetched.data;

  // 4. Write the optimistic DB state — a RUNNING child note + edge under
  //    the source. AI fills it when it returns.
  const opt = await buildOptimisticState({
    ctx,
    sourceNodeId: nodeId,
    childOffset: dto.childNodeOffset,
    model: dto.model,
    parentScale: dto.parentScale,
  });
  if (opt.tag !== 'ok') return opt;

  // 5. Queue worker(s). Cartesian fan-out (one extra child per ancestor path)
  //    lives inside spawnWorkers — the outer story stays prose.
  const finalState = await spawnWorkers({
    ctx, actionId: dto.actionId, nodeId, model: dto.model,
    optimistic: opt.data,
  });

  // 6. Respond with the canvas-facing shape.
  return venum('ok', Optimistic.toRunResult(finalState));
};

// PUBLIC. Run an action over a batch of notes combined into one prompt.
// No per-note source capability check: batch callers (unifier-like flows)
// have already validated the selection shape client-side.
export const execute = async (ctx: InvocationCtx, inv: BatchInvocation) => {
  if (inv.noteIds.length === 0) {
    return venum('invalidInput', { message: 'At least one noteId is required' });
  }

  const fetched = await fetchAction(inv.actionId, ctx.userId);
  if (fetched.tag !== 'ok') return fetched;

  const opt = await buildOptimisticState({
    ctx,
    sourceNodeId: inv.noteIds[0]!,
    childOffset: { x: 0, y: 150 },
  });
  if (opt.tag !== 'ok') return opt;

  await publishJob(Action.Job.fill({
    actionId: inv.actionId,
    sourceNoteIds: inv.noteIds,
    targetNoteId: opt.data.child.id,
    userId: ctx.userId,
    arrangementId: ctx.arrangementId,
    model: '',
  }));

  return venum('ok', Optimistic.toRunResult(opt.data));
};

// -----------------------------------------------------------------------------
// Private steps. Each returns a venum or a plain value; nothing throws.
// -----------------------------------------------------------------------------

const validateActionSource = async (nodeId: string) => {
  const row = await services.prisma.note.findUnique({
    where: { id: nodeId }, select: { type: true },
  });
  if (!row) return venum('notFound', { message: `Source note ${nodeId} not found` });
  const type = row.type as Note.Type;
  if (!Note.capabilities({ type }).canRunAction) {
    return venum('invalidSource', { message: `Cannot run action on node of type ${type}` });
  }
  return venum('ok', type);
};

const fetchAction = async (actionId: string, userId: string) => {
  const action = await services.prisma.action.findUnique({ where: { id: actionId, userId } });
  return action
    ? venum('ok', action)
    : venum('notFound', { message: `Action ${actionId} not found or access denied` });
};

// Spawn a RUNNING child note + edge under the source — this is what the
// AI fills when it returns. Single shape, no nullables.
const buildOptimisticState = async (input: {
  ctx: InvocationCtx;
  sourceNodeId: string;
  childOffset: { x: number; y: number };
  model?: string;
  parentScale?: number;
}) => {
  const { ctx, sourceNodeId, childOffset, model, parentScale } = input;
  const created = await createChildNode(
    sourceNodeId, ctx.arrangementId, ctx.userId, childOffset,
    'RUNNING', model, parentScale,
  );
  if (created.tag !== 'ok') return created;
  return venum('ok', { child: created.data.node, edge: created.data.edge });
};

// Queue the primary job, then — only if this node has multiple ancestor paths —
// fan out extra Cartesian children for the remaining paths. Returns the
// optimistic state, possibly updated when we tag the first child with its
// ancestor chain.
const spawnWorkers = async (input: {
  ctx: InvocationCtx;
  actionId: string;
  nodeId: string;
  model: string;
  optimistic: Optimistic.OptimisticState;
}): Promise<Optimistic.OptimisticState> => {
  const { ctx, actionId, nodeId, model, optimistic } = input;

  const paths = await getAncestorsForAllPaths(nodeId, ctx.arrangementId);
  const isCartesian = paths.length > 1;

  // Primary job: fill the optimistic child.
  await publishJob(Action.Job.fill({
    actionId, sourceNoteIds: [nodeId],
    targetNoteId: optimistic.child.id,
    userId: ctx.userId, arrangementId: ctx.arrangementId, model,
    ancestorContext: isCartesian ? paths[0]?.map(n => n.id) : undefined,
  }));

  if (!isCartesian) return optimistic;

  // Cartesian: tag the first optimistic child with path #0's ancestor chain
  // so the worker picks that conversational context, then create jobs for
  // the remaining paths.
  const firstChild = await NoteDb.setAncestorOverride(
    optimistic.child.id,
    Action.Execution.extractAncestorIds(paths[0] || []),
  );

  const positions = Action.Execution.calculateCartesianPositions(
    { x: firstChild.x, y: firstChild.y },
    paths.length,
    Canvas.NODE_SPACING.CHILD_SIBLING,
  );
  await Promise.all(paths.slice(1).map((pathNotes, i) =>
    publishJob(Action.Job.create({
      actionId, sourceNoteIds: [nodeId],
      position: positions[i]!,
      userId: ctx.userId, arrangementId: ctx.arrangementId, model,
      ancestorContext: Action.Execution.extractAncestorIds(pathNotes),
    })),
  ));

  return { child: firstChild, edge: optimistic.edge };
};

// Single point of NATS contact for action worker jobs. Subject + priority
// live in exactly one place; payload is the already-discriminated Job.
const publishJob = (job: Action.Job.Any): Promise<void> =>
  services.nats.publishToQueue(Subjects.AIAction, job, 5);
