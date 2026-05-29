/**
 * Unifier Activities — thin wrappers around UnifierController.
 */

import { UnifierController } from '../../domains/unifier';
import type { PreparedUnifierRun } from '../../domains/unifier/worker';
import type { LLM } from '@piano/shared';

export async function buildUnifierPrompt(input: {
  unifierId: string;
  sourceNoteIds: string[];
  userPrompt: string | undefined;
  arrangementId: string;
  userId: string;
  model: string;
}): Promise<PreparedUnifierRun> {
  return UnifierController.buildUnifierPrompt(input);
}

export async function callAIForUnifier(prepared: PreparedUnifierRun) {
  return UnifierController.callAIForUnifier(prepared);
}

export async function processUnifierResults(input: {
  unifier: any;
  aiResponse: string | string[];
  sourceNoteIds: string[];
  optimisticTargetNodeId: string;
  arrangementId: string;
  userId: string;
  usage?: LLM.RunUsage;
}) {
  return UnifierController.processUnifierResults(input);
}
