import { Subjects } from '../services/nats';

// -----------------------------------------------------------------------------
// NATS → Temporal dispatch registry.
//
// One table maps each AI queue subject to the workflow that consumes it.
// The message-consumer loop in temporal-worker.ts is now subject-agnostic:
// lookup, start, ack. Adding a new subject = adding a row here.
//
// `toJob` derives the (workflowId, args) pair from the NATS payload. Keeping
// that shape per-subject here (instead of inside the consumer if/else) means
// the consumer has zero knowledge of payload shapes.
// -----------------------------------------------------------------------------

export type WorkflowJob = { id: string; name: string; args: unknown };

type SubjectConfig = {
  workflowName: string;
  toJob: (payload: any) => WorkflowJob;
};

const uniqueStamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const DISPATCH: Record<string, SubjectConfig> = {
  [Subjects.AIAction]: {
    workflowName: 'executeActionWorkflow',
    toJob: (p) => ({
      id: `action-${p.actionId}-${uniqueStamp()}`,
      name: 'executeActionWorkflow',
      args: p,
    }),
  },
  [Subjects.AIUnifier]: {
    workflowName: 'executeUnifierWorkflow',
    toJob: (p) => ({
      id: `unifier-${p.unifierId}-${uniqueStamp()}`,
      name: 'executeUnifierWorkflow',
      args: p,
    }),
  },
  [Subjects.AIWorkflow]: {
    workflowName: 'executeWorkflowWorkflow',
    // payload already carries runId — reuse it as the temporal workflowId
    // so the user's run shows up under one stable id.
    toJob: (p) => ({
      id: p.runId ?? `workflow-${p.workflowId}-${uniqueStamp()}`,
      name: 'executeWorkflowWorkflow',
      args: p,
    }),
  },
};

export const jobFor = (subject: string, payload: unknown): WorkflowJob => {
  const config = DISPATCH[subject];
  if (!config) throw new Error(`Unknown subject: ${subject}`);
  return config.toJob(payload);
};
