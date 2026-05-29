import { ApplicationFailure } from '@temporalio/activity';
import { z } from 'zod';
import { services } from '../../services/init';
import { Action, Note, Edge, Canvas, LLM } from '@piano/shared';
import { getAncestors } from './ancestors';
import { emitNodeUpdated, emitNodeCreated } from './shared';
import { resolveApiKey } from '../../services/ai/keys';
import * as NoteCache from '../note-cache/runtime';
import { persistRun } from '../note-runs/persist';
import { obs } from '../../services/observability';
import type { CompletionRequest, CompletionResult } from '../../services/ai';

const log = obs.child({ domain: 'action:worker' });

// -----------------------------------------------------------------------------
// Action worker — Temporal activities. Three steps:
//   1. buildPrompt       — fetch + split into (system, prefix, fresh) with
//                          cacheDirective baked in.
//   2. callAI            — one call through AiService; returns text + any
//                          newly-minted cache handle to persist.
//   3. processResults    — write results to DB, emit SSE.
//
// Error policy: adapter-level venum variants map to Temporal failures with
// explicit retry semantics. missingKey / invalidApiKey / invalidInput /
// cacheTooSmall are non-retryable — retrying won't fix them and each
// attempt costs a round-trip. rateLimited / providerError are retryable
// (transient provider issues).
// -----------------------------------------------------------------------------

export type PreparedRun = {
  action: { outputStyle: Action.OutputStyle; prompt: string };
  request: CompletionRequest;
  anchor: Note.Model | null; // carried by ref so callAI persists handles without re-reading
  modelId: LLM.ModelId;
};

// Throw helpers — one place per retry class so call sites stay thin.
const nonRetryable = (code: string, message: string): never => {
  throw ApplicationFailure.nonRetryable(message, code);
};

// Drop the JSON-Schema meta header. Some provider strict modes (notably
// OpenAI's response_format: json_schema) reject unknown root keys; safer
// to send a clean schema everywhere than gamble per-provider tolerance.
const stripMetaSchema = (schema: unknown): Record<string, unknown> => {
  const { $schema: _drop, ...rest } = schema as Record<string, unknown>;
  return rest;
};

// "Missing target" is a normal user action, not a bug — the user deleted
// the optimistic node before our AI response landed. Log + drop, and let
// the activity complete cleanly so Temporal doesn't retry an undoable op.
const onUserDeleted = (where: string, ctx: object) => {
  log.warn({ where, ...ctx }, 'user-deleted-target: AI response discarded');
  return null;
};

export const buildPrompt = async (
  input: Action.Worker.BuildPromptInput & { model: string },
): Promise<PreparedRun> => {
  const modelId = input.model as LLM.ModelId;

  const [action, arrangement, sourceNotes, apiKey] = await Promise.all([
    services.prisma.action.findUniqueOrThrow({ where: { id: input.actionId } }),
    services.prisma.arrangement.findUnique({
      where: { id: input.arrangementId },
      select: { systemPrompt: true, user: { select: { defaultSystemPrompt: true } } },
    }),
    services.prisma.note.findMany({ where: { id: { in: input.sourceNoteIds } } }),
    resolveKeyOrFail(input.userId, modelId),
  ]);

  const ancestors = await resolveAncestors({
    arrangementId: input.arrangementId,
    sourceNotes,
    ancestorContext: input.ancestorContext,
    useAncestors: action.useAncestors,
  });

  const split = LLM.getModelById(modelId)?.cache.controllable
    ? NoteCache.splitByAnchor(ancestors, modelId)
    : { prefix: [], fresh: ancestors, anchor: null };

  const cacheDirective = NoteCache.directiveFor(split.anchor, modelId);
  log.debug(
    {
      model: modelId,
      ancestors: ancestors.length,
      anchorId: split.anchor?.id ?? null,
      prefixNotes: split.prefix.length,
      freshNotes: split.fresh.length,
      directive: cacheDirective
        ? { ttlSeconds: cacheDirective.ttlSeconds, hasLiveHandle: !!cacheDirective.existingHandle }
        : null,
    },
    'buildPrompt',
  );

  // Pre-convert Zod → JSON Schema HERE, before the activity boundary. Zod
  // schemas have methods/closures that don't survive Temporal's JSON
  // serialization (zod v4 also reshapes _def → def, which incidentally
  // breaks zod-to-json-schema@3). z.toJSONSchema() ships in zod v4 itself,
  // so we don't need a third-party converter at all.
  const jsonSchema =
    action.outputStyle === 'MULTIPLE_CHILDREN'
      ? stripMetaSchema(z.toJSONSchema(Action.MultipleResultsSchema))
      : undefined;

  const request: CompletionRequest = {
    model: modelId,
    apiKey,
    system: buildSystemLayers(arrangement),
    prefix: Action.combineNoteContents(split.prefix) || undefined,
    fresh: buildFreshBlock(action, split.fresh, sourceNotes),
    cacheDirective,
    jsonSchema,
  };

  return {
    action: { outputStyle: action.outputStyle as Action.OutputStyle, prompt: action.prompt },
    request,
    anchor: split.anchor,
    modelId,
  };
};

// -----------------------------------------------------------------------------
// Named steps — each does one thing, reads like a sentence at the call site.
// -----------------------------------------------------------------------------

const resolveKeyOrFail = async (userId: string, modelId: LLM.ModelId): Promise<string> => {
  const key = await resolveApiKey(userId, modelId);
  if (key.tag !== 'ok') return nonRetryable('MissingApiKey', key.data.message);
  return key.data;
};

const resolveAncestors = async (p: {
  arrangementId: string;
  sourceNotes: Note.Model[];
  ancestorContext: string[] | undefined;
  useAncestors: boolean;
}): Promise<Note.Model[]> => {
  if (!p.useAncestors || p.sourceNotes.length !== 1 || !p.sourceNotes[0]) return [];
  const raw = p.ancestorContext
    ? await loadAncestorsFromContext(p.ancestorContext, p.arrangementId)
    : await getAncestors(p.sourceNotes[0].id, p.arrangementId);
  // TEXT headings are for humans, not the LLM. Infra notes stay.
  return raw.filter(n => Note.capabilities({ type: n.type as Note.Type }).canBeAIContext);
};

// ancestorContext comes leaf-to-root including the source. Strip source,
// reverse → [Root, ..., Parent] top-to-bottom (our internal convention).
const loadAncestorsFromContext = async (
  ancestorContext: string[],
  arrangementId: string,
): Promise<Note.Model[]> => {
  const rows = await services.prisma.note.findMany({
    where: { id: { in: ancestorContext }, arrangementId },
  });
  const byId = new Map(rows.map(n => [n.id, n]));
  const leafToRoot = ancestorContext.map(id => byId.get(id)).filter(Boolean) as Note.Model[];
  return leafToRoot.slice(1).reverse();
};

const buildSystemLayers = (
  arrangement: { systemPrompt: string | null; user?: { defaultSystemPrompt: string | null } | null } | null,
): string | undefined => {
  const layers = [
    arrangement?.user?.defaultSystemPrompt?.trim(),
    arrangement?.systemPrompt?.trim(),
  ].filter((s): s is string => !!s && s.length > 0);
  return layers.length > 0 ? layers.join('\n\n') : undefined;
};

const buildFreshBlock = (
  action: { prompt: string; outputStyle: string },
  freshAncestors: Note.Model[],
  sourceNotes: Note.Model[],
): string => {
  const combinedSource = Action.combineNoteContents(sourceNotes);
  const taskBlock = freshAncestors.length > 0
    ? `Context:\n${Action.combineNoteContents(freshAncestors)}\n\n---\n\nTask:\n${combinedSource}`
    : combinedSource;
  const base = Action.buildFinalPrompt(action.prompt, taskBlock);
  return action.outputStyle === 'MULTIPLE_CHILDREN' ? Action.wrapForMultipleChildren(base) : base;
};

// -----------------------------------------------------------------------------
// Call the AI. Failures are mapped to retryable / non-retryable per variant.
// -----------------------------------------------------------------------------

const handleAiFailure = (variant: string, message: string): never => {
  // These are business facts; retrying won't change anything.
  if (variant === 'invalidApiKey') return nonRetryable('InvalidApiKey', message);
  if (variant === 'cacheTooSmall') return nonRetryable('CacheTooSmall', message);
  if (variant === 'invalidInput') return nonRetryable('InvalidInput', message);
  // rateLimited / providerError — transient, let Temporal retry.
  throw new Error(message);
};

const persistHandleIfCreated = async (prepared: PreparedRun, created?: { handle: string; expiresAt: Date; tokens: number }) => {
  if (!created || !prepared.anchor) return;
  log.debug(
    { anchorId: prepared.anchor.id, model: prepared.modelId, handle: created.handle },
    'persisting new cache handle',
  );
  await NoteCache.persistHandle({ anchor: prepared.anchor, modelId: prepared.modelId, ...created });
};

const unwrap = <T>(result: CompletionResult<T>) => {
  if (result.tag === 'ok') return result.data;
  return handleAiFailure(result.tag, result.data.message);
};

export type AiCallResult = {
  text: string | string[];
  usage?: LLM.RunUsage;
};

export const callAI = async (prepared: PreparedRun): Promise<AiCallResult> => {
  if (prepared.action.outputStyle === 'MULTIPLE_CHILDREN') {
    const result = await services.ai.completeJSON<unknown>(prepared.request);
    const ok = unwrap(result);
    await persistHandleIfCreated(prepared, ok.cacheCreated);
    // Adapters return raw parsed JSON; the only place that knows the Zod
    // shape is the worker (Zod can't cross the activity boundary safely).
    // Validate here — if a provider returned malformed structure, surface a
    // non-retryable error rather than silently feeding `[]` downstream.
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
  await persistHandleIfCreated(prepared, ok.cacheCreated);
  return { text: ok.text, usage: ok.usage };
};

// -----------------------------------------------------------------------------
// Result processing.
//
// Input is the original Job (fill | create) + the action's outputStyle +
// AI response. Discriminates on `job.kind` first — that tells us whether the
// target node already exists (fill) or we need to mint one (create) — then
// on outputStyle for any fan-out inside the fill path.
// -----------------------------------------------------------------------------

// Returns ids of every note this run touched — primary first, siblings after.
// Empty array means the user deleted the target before the AI returned (we
// drop the response quietly so Temporal doesn't retry an undoable op). The
// workflow orchestrator consumes these ids as the next-level frontier; the
// HTTP route ignores the return value.
export const processResults = async (input: {
  job: Action.Job.Any;
  action: { outputStyle: Action.OutputStyle };
  aiResponse: string | string[];
  usage?: LLM.RunUsage;
}): Promise<string[]> => {
  const { job, action, aiResponse, usage } = input;

  let producedIds: string[];
  if (job.kind === 'create') {
    producedIds = await createNewChild(job, aiResponse as string);
  } else if (action.outputStyle === 'MULTIPLE_CHILDREN') {
    producedIds = await fanOutChildren(job, aiResponse as string[]);
  } else {
    producedIds = await fillExisting(job, aiResponse as string);
  }

  if (usage && producedIds[0]) {
    await persistRun({
      noteId: producedIds[0],
      arrangementId: job.arrangementId,
      userId: job.userId,
      usage,
    });
  }
  return producedIds;
};


// Write AI content into the pre-existing target (the optimistic child for
// SINGLE_CHILD; the unifier result node for batch flows).
//
// updateManyAndReturn instead of update: missing target returns [] rather
// than throwing P2025, so we read intent from a count check — the same
// idempotent pattern the codebase already uses for `deleteMany`.
// Returns null if the user deleted the target mid-flight.
const fillExisting = async (job: Action.Job.Fill, content: string): Promise<string[]> => {
  const [updated] = await services.prisma.note.updateManyAndReturn({
    where: { id: job.targetNoteId },
    data: { content, status: null },
  });
  if (!updated) {
    onUserDeleted('fillExisting', { targetNoteId: job.targetNoteId, userId: job.userId });
    return [];
  }
  emitNodeUpdated(job.userId, updated);
  return [updated.id];
};

// Cartesian follow-up: mint a fresh child under sourceNoteIds[0] with the
// path's ancestor chain baked into ancestorOverride.
//
// Pre-check parent existence (the common case: user deleted the parent),
// then create node + edge in a transaction so the rare race — parent
// vanishes between findUnique and the insert — rolls back cleanly with
// no orphan note. The FK throw bubbles to Temporal retry; on retry, the
// pre-check sees the missing parent and returns null gracefully.
const createNewChild = async (job: Action.Job.Create, content: string): Promise<string[]> => {
  const parentId = job.sourceNoteIds[0]!;
  const parent = await services.prisma.note.findUnique({
    where: { id: parentId },
    select: { id: true, layers: true },
  });
  if (!parent) {
    onUserDeleted('createNewChild', { parentId, userId: job.userId });
    return [];
  }

  const childData = Action.Result.buildCartesianChildData({
    content,
    position: job.position,
    arrangementId: job.arrangementId,
    userId: job.userId,
    ancestorContext: job.ancestorContext,
    layers: parent.layers,
  });
  const { node, edge } = await services.prisma.$transaction(async (tx) => {
    const node = await tx.note.create({ data: childData });
    const edge = await tx.edge.create({
      data: Edge.childEdgeData(job.arrangementId, parentId, node.id),
    });
    return { node, edge };
  });
  emitNodeCreated(job.userId, node, edge);
  return [node.id];
};

// MULTIPLE_CHILDREN: the first result fills the optimistic target; the
// rest become siblings created from scratch under sourceNoteIds[0].
const fanOutChildren = async (job: Action.Job.Fill, contents: string[]): Promise<string[]> => {
  if (contents.length === 0) return [job.targetNoteId];

  const [primary] = await services.prisma.note.updateManyAndReturn({
    where: { id: job.targetNoteId },
    data: { content: contents[0]!, status: null },
  });
  if (!primary) {
    onUserDeleted('fanOutChildren:primary', { targetNoteId: job.targetNoteId, userId: job.userId });
    return [];
  }
  emitNodeUpdated(job.userId, primary);

  if (contents.length < 2) return [primary.id];

  // Siblings hang off sourceNoteIds[0]. Pre-check parent — if user deleted
  // it between optimistic stage and now, keep the primary and skip the rest.
  const parentId = job.sourceNoteIds[0]!;
  const parent = await services.prisma.note.findUnique({
    where: { id: parentId },
    select: { id: true, layers: true },
  });
  if (!parent) {
    onUserDeleted('fanOutChildren:siblings (parent gone, kept primary)', { parentId, userId: job.userId });
    return [primary.id];
  }

  const basePosition = { x: primary.x, y: primary.y };
  const nodesData = Action.Result.buildMultipleChildrenData({
    contents: contents.slice(1),
    basePosition,
    spacing: Canvas.NODE_SPACING.CHILD_SIBLING,
    arrangementId: job.arrangementId,
    userId: job.userId,
    layers: parent.layers,
  });
  // Tx so notes + edges are atomic; if parent vanishes mid-insert (rare
  // race past the pre-check) the whole batch rolls back. Temporal retry
  // re-fills primary idempotently and the second pre-check sees null.
  const { createdNotes, createdEdges } = await services.prisma.$transaction(async (tx) => {
    const createdNotes = await tx.note.createManyAndReturn({ data: nodesData });
    const edgesData = createdNotes.map((note: Note.Model) =>
      Edge.childEdgeData(job.arrangementId, parentId, note.id),
    );
    const createdEdges = await tx.edge.createManyAndReturn({ data: edgesData });
    return { createdNotes, createdEdges };
  });
  createdNotes.forEach((node: Note.Model, i: number) =>
    emitNodeCreated(job.userId, node, createdEdges[i]!),
  );
  return [primary.id, ...createdNotes.map((n: Note.Model) => n.id)];
};
