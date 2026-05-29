import { venum } from 'venum';
import { services } from '../../services/init';
import { Unifier, Note } from '@piano/shared';
import { Subjects } from '../../services/nats';
import { InvocationCtx } from '../../shared/lib/invocation';

// Named invocation shape. Replaces the previous 6-positional-arg signature;
// routes now forward the validated DTO verbatim.
export type UnifierInvocation = {
  unifierId: string;
  noteIds: string[];
  userPrompt?: string;
  model: string;
};

// -----------------------------------------------------------------------------
// Unifier execution (HTTP entry point). No throws. Variants:
//   ok            → 200, RunResult payload
//   invalidInput  → 400 (empty noteIds, no valid source notes in selection)
//   notFound      → 404 (unifier missing or not owned)
//
// Unifier always spawns a single independent result node (no edges).
// -----------------------------------------------------------------------------

export const execute = async (ctx: InvocationCtx, inv: UnifierInvocation) => {
  const { arrangementId, userId } = ctx;
  const { unifierId, noteIds, userPrompt, model } = inv;

  if (noteIds.length === 0) {
    return venum('invalidInput', { message: 'At least one noteId is required' });
  }

  const unifier = await services.prisma.unifier.findUnique({ where: { id: unifierId, userId } });
  if (!unifier) {
    return venum('notFound', { message: `Unifier ${unifierId} not found or access denied` });
  }

  // Defensive filter — TEXT annotations aren't LLM context (visual labels
  // for humans). Infra notes (logs, terminal output) ARE valid content and
  // are kept. Frontend pre-filters too, but we never trust client state.
  const fetched = await services.prisma.note.findMany({ where: { id: { in: noteIds }, arrangementId } });
  const sources = fetched.filter(n => Note.capabilities({ type: n.type as Note.Type }).canBeUnifierSource);
  if (sources.length === 0) {
    return venum('invalidInput', { message: 'No valid content notes found for the given IDs' });
  }

  // Place the result node below the centroid of the selected notes.
  const pos = Unifier.calculateResultPosition(sources);

  // Inherit the union of source layers — a summary should be visible
  // wherever any of its sources is visible. A global source contributes
  // nothing (its `[]` would otherwise short-circuit the result to global),
  // matching the "global is the universal layer" semantics.
  const resultLayers = Array.from(
    new Set(sources.flatMap(s => s.layers ?? [])),
  ).sort();

  // Optimistic result node (no edges — unifier results are independent).
  const resultNode = await services.prisma.note.create({
    data: {
      arrangementId, userId,
      content: '', type: 'ASSISTANT', status: 'RUNNING',
      x: pos.x, y: pos.y,
      layers: resultLayers,
      assistantProvider: model,
    },
  });

  await services.nats.publishToQueue(Subjects.AIUnifier, {
    unifierId,
    sourceNoteIds: sources.map(n => n.id),
    userPrompt,
    optimisticTargetNodeId: resultNode.id,
    userId, arrangementId, model,
  }, 5);

  return venum('ok', { responseNode: Note.Transform.toRfNode(resultNode) });
};
