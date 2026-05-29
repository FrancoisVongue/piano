import { ApplicationFailure } from '@temporalio/activity';
import { z } from 'zod';
import { services } from '../../services/init';
import { Unifier, Note, SSE, Canvas, Action, LLM } from '@piano/shared';
import { resolveApiKey } from '../../services/ai/keys';
import { persistRun } from '../note-runs/persist';
import { obs } from '../../services/observability';
import type { CompletionRequest, CompletionResult } from '../../services/ai';

const log = obs.child({ domain: 'unifier:worker' });

// Shared retry policy with action/worker: business facts are non-retryable,
// transient provider issues aren't.
const nonRetryable = (code: string, message: string): never => {
  throw ApplicationFailure.nonRetryable(message, code);
};

// Same rationale as in action/worker.ts — strip JSON-Schema meta header
// before handing the schema to provider strict modes.
const stripMetaSchema = (schema: unknown): Record<string, unknown> => {
  const { $schema: _drop, ...rest } = schema as Record<string, unknown>;
  return rest;
};

const onUserDeleted = (where: string, ctx: object) => {
  log.warn({ where, ...ctx }, 'user-deleted-target: AI response discarded');
  return null;
};

const handleAiFailure = (variant: string, message: string): never => {
  if (variant === 'invalidApiKey') return nonRetryable('InvalidApiKey', message);
  if (variant === 'cacheTooSmall') return nonRetryable('CacheTooSmall', message);
  if (variant === 'invalidInput') return nonRetryable('InvalidInput', message);
  throw new Error(message);
};

const unwrap = <T>(result: CompletionResult<T>) => {
  if (result.tag === 'ok') return result.data;
  return handleAiFailure(result.tag, result.data.message);
};

// -----------------------------------------------------------------------------
// Unifier worker — Temporal activities.
//
// Unifiers are flatter than actions: no ancestor walk (the user selected
// notes explicitly), so no cache-anchor logic applies here. We still go
// through the new AI dispatcher — one pipe, same venum contract.
// -----------------------------------------------------------------------------

export type PreparedUnifierRun = {
  unifier: { id: string; outputStyle: Unifier.OutputStyle; prompt: string };
  request: CompletionRequest;
};

export const buildPrompt = async (
  input: Unifier.Worker.BuildPromptInput & { model: string },
): Promise<PreparedUnifierRun> => {
  const { unifierId, sourceNoteIds, userPrompt, arrangementId, userId } = input;
  const modelId = input.model as LLM.ModelId;

  const [unifier, sourceNotes] = await Promise.all([
    services.prisma.unifier.findUniqueOrThrow({ where: { id: unifierId } }),
    services.prisma.note.findMany({ where: { id: { in: sourceNoteIds }, arrangementId } }),
  ]);

  const keyResult = await resolveApiKey(userId, modelId);
  if (keyResult.tag !== 'ok') return nonRetryable('MissingApiKey', keyResult.data.message);

  const combinedContent = Unifier.combineNoteContents(sourceNotes);
  let fresh = Unifier.buildFinalPrompt(unifier.prompt, userPrompt, combinedContent);
  if (unifier.outputStyle === 'MULTIPLE_NODES') {
    fresh = Unifier.wrapForMultipleNodes(fresh);
  }

  // Same Temporal-serialization concern as the action worker — pre-convert
  // here so adapters never see Zod.
  const jsonSchema =
    unifier.outputStyle === 'MULTIPLE_NODES'
      ? stripMetaSchema(z.toJSONSchema(Action.MultipleResultsSchema))
      : undefined;

  const request: CompletionRequest = {
    model: modelId,
    apiKey: keyResult.data,
    fresh,
    jsonSchema,
  };

  return {
    unifier: { id: unifier.id, outputStyle: unifier.outputStyle as Unifier.OutputStyle, prompt: unifier.prompt },
    request,
  };
};

export type UnifierAiCallResult = {
  text: string | string[];
  usage?: LLM.RunUsage;
};

export const callAI = async (prepared: PreparedUnifierRun): Promise<UnifierAiCallResult> => {
  if (prepared.unifier.outputStyle === 'MULTIPLE_NODES') {
    const result = await services.ai.completeJSON<unknown>(prepared.request);
    const ok = unwrap(result);
    const parsed = Action.MultipleResultsSchema.safeParse(ok.text);
    if (!parsed.success) {
      return nonRetryable(
        'InvalidStructuredOutput',
        `Provider returned shape that doesn't match MultipleResultsSchema: ${parsed.error.message}`,
      );
    }
    return { text: parsed.data.results, usage: ok.usage };
  }
  const result = await services.ai.complete(prepared.request);
  const ok = unwrap(result);
  return { text: ok.text, usage: ok.usage };
};

export const processResults = async (
  input: Unifier.Worker.ProcessResultsInput & { usage?: LLM.RunUsage },
) => {
  const { usage, ...rest } = input;
  const primaryNoteId = await writeResults(rest);
  if (usage && primaryNoteId) {
    await persistRun({
      noteId: primaryNoteId,
      arrangementId: rest.arrangementId,
      userId: rest.userId,
      usage,
    });
  }
};

const writeResults = async (input: Unifier.Worker.ProcessResultsInput): Promise<string | null> => {
  const { unifier, aiResponse, optimisticTargetNodeId, arrangementId, userId } = input;

  if (unifier.outputStyle === 'SINGLE_NODE') {
    const [node] = await services.prisma.note.updateManyAndReturn({
      where: { id: optimisticTargetNodeId },
      data: { content: aiResponse as string, status: null },
    });
    if (!node) return onUserDeleted('writeResults:single', { optimisticTargetNodeId, userId });
    emitNodeUpdated(userId, node);
    return node.id;
  }

  const contents = aiResponse as string[];
  if (contents.length === 0) return optimisticTargetNodeId;

  const [primary] = await services.prisma.note.updateManyAndReturn({
    where: { id: optimisticTargetNodeId },
    data: { content: contents[0]!, status: null },
  });
  if (!primary) return onUserDeleted('writeResults:multi:primary', { optimisticTargetNodeId, userId });
  emitNodeUpdated(userId, primary);

  if (contents.length > 1) {
    // Siblings inherit the primary's layers — the primary was already
    // stamped with the source-union by unifier/execution.ts, so just
    // propagate that to the rest of the fan-out.
    const siblingLayers = primary.layers ?? [];
    const newNodesData = contents.slice(1).map((content, index) => ({
      arrangementId,
      userId,
      content,
      type: 'ASSISTANT' as Note.Type,
      x: primary.x + (index + 1) * Canvas.NODE_SPACING.CHILD_SIBLING,
      y: primary.y,
      layers: siblingLayers,
    }));
    // Siblings have no FK to a parent note (no edge in unifier flow), only
    // arrangementId — which the pre-existing primary update has already
    // proven is alive. Plain createManyAndReturn is safe.
    const createdNotes = await services.prisma.note.createManyAndReturn({ data: newNodesData });
    createdNotes.forEach(node => emitNodeCreated(userId, node));
  }
  return primary.id;
};

const emitNodeUpdated = (userId: string, node: Note.Model): void => {
  const message = SSE.nodeUpdated(userId, Note.Transform.toRfNode(node));
  services.nats.client.publish('sse.node.updated', SSE.serialize(message));
};

const emitNodeCreated = (userId: string, node: Note.Model): void => {
  const message = SSE.nodeCreated(userId, Note.Transform.toRfNode(node), undefined);
  services.nats.client.publish('sse.node.created', SSE.serialize(message));
};
