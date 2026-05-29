/**
 * Execute Unifier Workflow
 *
 * 1. Build prepared run (prompt + resolved API key).
 * 2. Call AI.
 * 3. Process results → DB + SSE.
 */

import { proxyActivities } from '@temporalio/workflow';
import { log } from '../log';
import type * as activities from '../activities';

export interface ExecuteUnifierWorkflowInput {
  unifierId: string;
  sourceNoteIds: string[];
  userPrompt: string | undefined;
  optimisticTargetNodeId: string;
  userId: string;
  arrangementId: string;
  model: string;
}

const { buildUnifierPrompt, callAIForUnifier, processUnifierResults } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 3 },
  });

export async function executeUnifierWorkflow(
  input: ExecuteUnifierWorkflowInput,
): Promise<void> {
  log.info({ unifierId: input.unifierId, workflow: 'executeUnifier', phase: 'start' }, 'workflow start');

  const prepared = await buildUnifierPrompt({
    unifierId: input.unifierId,
    sourceNoteIds: input.sourceNoteIds,
    userPrompt: input.userPrompt,
    arrangementId: input.arrangementId,
    userId: input.userId,
    model: input.model,
  });

  const { text, usage } = await callAIForUnifier(prepared);

  await processUnifierResults({
    unifier: prepared.unifier,
    aiResponse: text,
    sourceNoteIds: input.sourceNoteIds,
    optimisticTargetNodeId: input.optimisticTargetNodeId,
    arrangementId: input.arrangementId,
    userId: input.userId,
    usage,
  });

  log.info({ unifierId: input.unifierId, workflow: 'executeUnifier', phase: 'done' }, 'workflow done');
}
