/**
 * Execute Workflow Workflow — orchestrator only, no AI logic.
 *
 * Each level: plant USER notes (parents × contexts), create RUNNING
 * ASSISTANT placeholders under them, then run the level's Action as a
 * child workflow per (USER, placeholder) pair. The Action child returns
 * string[] of note ids it filled / created — those become the next
 * level's frontier.
 *
 * Idempotency: all node + edge ids are pre-generated via Temporal's
 * deterministic `uuid4()` so activity retries hit the same primary keys
 * (createMany skipDuplicates makes the second insert a no-op).
 *
 * Failure: child Action workflow has its own retry / non-retry mapping.
 * If a cell rejects we let it bubble — `Promise.all` rejects the parent
 * workflow rather than silently dropping cells.
 */

import { proxyActivities, executeChild, uuid4 } from '@temporalio/workflow';
import { log } from '../log';
import type * as activities from '../activities';
import { Action, Workflow } from '@piano/shared';
import { executeActionWorkflow } from './execute-action.workflow';

const { loadWorkflowDefinition, plantUserNodes, createOptimisticPlaceholders } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 3 },
  });

export interface ExecuteWorkflowInput {
  workflowId: string;
  runId: string;
  targetNoteId: string;
  arrangementId: string;
  userId: string;
  model: string;
}

const ROOT_KEY = '__root__';
const ids = (n: number): string[] => Array.from({ length: n }, () => uuid4());

export async function executeWorkflowWorkflow(input: ExecuteWorkflowInput): Promise<string[]> {
  log.info({ workflowId: input.workflowId, runId: input.runId, phase: 'start' }, 'workflow start');

  const def = await loadWorkflowDefinition(input.workflowId);
  if (!def || def.levels.length === 0) {
    log.warn({ workflowId: input.workflowId }, 'no workflow definition or empty levels — abort');
    return [];
  }

  const ordered = Workflow.topoSort(def.levels);
  const frontiers = new Map<string, string[]>([[ROOT_KEY, [input.targetNoteId]]]);
  let lastProduced: string[] = [];

  for (const level of ordered) {
    const parents = frontiers.get(level.inputLevelId || ROOT_KEY) ?? [];
    if (parents.length === 0) {
      log.debug({ levelId: level.id, name: level.name }, 'level has no parents — skipping');
      frontiers.set(level.id, []);
      continue;
    }
    const frontier = await runLevel(level, parents, input);
    frontiers.set(level.id, frontier);
    lastProduced = frontier;
  }

  log.info({ workflowId: input.workflowId, runId: input.runId, lastProduced: lastProduced.length, phase: 'done' }, 'workflow done');
  return lastProduced;
}

// One level: plant USER notes under each parent for each context, plant a
// RUNNING ASSISTANT placeholder under each USER, then fan out the chosen
// Action as child workflows. Returns the produced ASSISTANT ids — that's
// the next level's parent frontier.
async function runLevel(
  level: Workflow.Level,
  parents: string[],
  input: ExecuteWorkflowInput,
): Promise<string[]> {
  const userCells = parents.flatMap(parentId =>
    level.contexts.map((text, contextIdx) => ({ parentId, text, contextIdx })),
  );
  const userNoteIds = ids(userCells.length);
  await plantUserNodes({
    cells: userCells,
    noteIds: userNoteIds,
    edgeIds: ids(userCells.length),
    arrangementId: input.arrangementId,
    userId: input.userId,
  });

  const placeholderNoteIds = ids(userNoteIds.length);
  await createOptimisticPlaceholders({
    parentIds: userNoteIds,
    noteIds: placeholderNoteIds,
    edgeIds: ids(userNoteIds.length),
    arrangementId: input.arrangementId,
    userId: input.userId,
    model: input.model,
  });

  const cellResults = await Promise.all(userNoteIds.map((userNodeId, i) =>
    executeChild(executeActionWorkflow, {
      workflowId: `${input.runId}-${level.id}-${i}`,
      args: [Action.Job.fill({
        actionId: level.actionId,
        sourceNoteIds: [userNodeId],
        targetNoteId: placeholderNoteIds[i]!,
        userId: input.userId,
        arrangementId: input.arrangementId,
        model: input.model,
      })],
    }),
  ));
  return cellResults.flat();
}
