/**
 * Action Activities — thin wrappers around ActionController.
 *
 * The "prepared run" object from buildActionPrompt flows through callAI
 * and downstream: it already contains the resolved API key + cache
 * directive, so callAI needs no extra args.
 */

import { ActionController } from '../../domains/action';
import type { PreparedRun } from '../../domains/action/worker';
import type { Action, LLM } from '@piano/shared';

export async function buildActionPrompt(input: {
  actionId: string;
  sourceNoteIds: string[];
  arrangementId: string;
  userId: string;
  model: string;
  ancestorContext?: string[];
}): Promise<PreparedRun> {
  return ActionController.buildActionPrompt(input);
}

export async function callAIForAction(prepared: PreparedRun) {
  return ActionController.callAIForAction(prepared);
}

export async function processActionResults(input: {
  job: Action.Job.Any;
  action: { outputStyle: Action.OutputStyle };
  aiResponse: string | string[];
  usage?: LLM.RunUsage;
}) {
  return ActionController.processActionResults(input);
}
