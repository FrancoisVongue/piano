import { Note, Edge, Arrangement } from '@piano/shared';

// OptimisticState — the (child note, edge) pair we wrote provisionally
// when an action started, before the AI call completed. The Action worker
// later fills the child's content via job.targetNoteId.

export type OptimisticState = { child: Note.Model; edge: Edge.Model };

// HTTP response for the canvas — converts DB models → FlowNode/FlowEdge.
export const toRunResult = (s: OptimisticState): Arrangement.Response.RunResult => ({
  responseNode: Note.Transform.toRfNode(s.child),
  responseEdge: Edge.Transform.toRfEdge(s.edge),
});
