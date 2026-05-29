/**
 * ActionController - modular controller with clear separation of concerns
 *
 * Files:
 * - crud.ts: CRUD operations
 * - execution.ts: HTTP handlers (optimistic update + queue)
 * - worker.ts: Temporal activities
 * - ancestors.ts: Ancestor path logic
 * - shared.ts: Shared utilities
 */

import * as crud from './crud';
import * as execution from './execution';
import * as worker from './worker';
import * as ancestors from './ancestors';
import * as shared from './shared';

export class ActionController {
  // CRUD
  static create = crud.create;
  static seedDefaults = crud.seedDefaults;
  static findByUser = crud.findByUser;
  static findById = crud.findById;
  static update = crud.update;
  static delete = crud.remove;

  // HTTP execution (called from routes)
  static executeActionWithOptimisticUpdate = execution.executeWithOptimisticUpdate;
  static executeAction = execution.execute;

  // Temporal worker methods (called from activities)
  static buildActionPrompt = worker.buildPrompt;
  static callAIForAction = worker.callAI;
  static processActionResults = worker.processResults;

  // Ancestor utilities
  static getAncestors = ancestors.getAncestors;
  static getAncestorsForAllPaths = ancestors.getAncestorsForAllPaths;

  // Shared utilities (used by Temporal activities + UnifierController)
  static updateNodeWithResult = shared.updateNodeWithResult;
  static createChildNode = shared.createChildNode;
}
