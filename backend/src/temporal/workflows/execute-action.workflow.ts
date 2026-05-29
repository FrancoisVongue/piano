/**
 * Execute Action Workflow
 *
 * Input is Action.Job.Any — a discriminated union (`fill` | `create`). Both
 * variants carry the common fields buildPrompt needs; only processResults
 * branches on kind.
 *
 *   1. Build the prepared run (prompt split, cache directive, resolved key).
 *   2. Call AI.
 *   3. Process results → DB + SSE.
 */

import { proxyActivities } from '@temporalio/workflow';
import { log } from '../log';
import type * as activities from '../activities';
import type { Action } from '@piano/shared';

export type ExecuteActionWorkflowInput = Action.Job.Any;

const {
  buildActionPrompt,
  callAIForAction,
  processActionResults,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

export async function executeActionWorkflow(job: ExecuteActionWorkflowInput): Promise<string[]> {
  log.info({ actionId: job.actionId, kind: job.kind, workflow: 'executeAction', phase: 'start' }, 'workflow start');

  const prepared = await buildActionPrompt({
    actionId: job.actionId,
    sourceNoteIds: job.sourceNoteIds,
    arrangementId: job.arrangementId,
    userId: job.userId,
    model: job.model,
    ancestorContext: job.ancestorContext,
  });

  const { text, usage } = await callAIForAction(prepared);

  const producedIds = await processActionResults({ job, action: prepared.action, aiResponse: text, usage });

  log.info({ actionId: job.actionId, workflow: 'executeAction', phase: 'done', produced: producedIds.length }, 'workflow done');
  return producedIds;
}
