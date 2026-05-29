/**
 * WorkflowController — modular controller. Mirrors action/unifier layout.
 *
 * Files:
 * - crud.ts:      CRUD over Workflow rows (Json levels[] in/out).
 * - execution.ts: HTTP entry point — validate ownership, publish NATS job.
 *
 * No worker file: workflow has no AI logic of its own. The Temporal
 * orchestrator (temporal/workflows/execute-workflow.workflow.ts) builds
 * the level graph and delegates AI work to executeActionWorkflow as a
 * child workflow per cell.
 */

import * as crud from './crud';
import * as execution from './execution';

export class WorkflowController {
  static create = crud.create;
  static findByUser = crud.findByUser;
  static findById = crud.findById;
  static update = crud.update;
  static delete = crud.remove;

  static run = execution.run;
}
