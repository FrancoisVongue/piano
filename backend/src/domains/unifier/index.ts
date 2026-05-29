/**
 * UnifierController - modular controller with clear separation of concerns
 *
 * Files:
 * - crud.ts: CRUD operations
 * - execution.ts: HTTP handler (optimistic update + queue)
 * - worker.ts: Temporal activities
 */

import * as crud from './crud';
import * as execution from './execution';
import * as worker from './worker';

export class UnifierController {
  // CRUD
  static create = crud.create;
  static findByUser = crud.findByUser;
  static findById = crud.findById;
  static update = crud.update;
  static delete = crud.remove;

  // HTTP execution (called from routes)
  static executeUnifier = execution.execute;

  // Temporal worker methods (called from activities)
  static buildUnifierPrompt = worker.buildPrompt;
  static callAIForUnifier = worker.callAI;
  static processUnifierResults = worker.processResults;
}
