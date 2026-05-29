import { venum } from 'venum';
import { services } from '../../services/init';
import { Note, Edge, SSE } from '@piano/shared';
import { obs } from '../../services/observability';

const log = obs.child({ domain: 'action.shared' });

// -----------------------------------------------------------------------------
// Shared helpers used by both HTTP execution and Temporal workers.
//
// AI-facing helpers now live in ./worker.ts (buildPrompt / callAI) —
// they rely on the cache-aware request shape and aren't useful in isolation.
// This file holds only the DB-facing utilities + SSE emitters.
// -----------------------------------------------------------------------------

// Called only from Temporal activities.
export const updateNodeWithResult = (nodeId: string, content: string) =>
  services.prisma.note.update({
    where: { id: nodeId },
    data: { content, status: null },
  });

// Create a child note + edge under a parent.
// Called from HTTP execution AND from Temporal activities. Returns venum;
// the Temporal activity wrapper converts `notFound` to a throw so Temporal
// retry stays correct.
export const createChildNode = async (
  parentId: string,
  arrangementId: string,
  userId: string,
  offset: { x: number; y: number } = { x: 0, y: 150 },
  initialStatus: 'RUNNING' | null = 'RUNNING',
  model?: string,
  parentScale?: number,
) => {
  const parentNote = await services.prisma.note.findFirst({
    where: { id: parentId, arrangementId },
  });
  if (!parentNote) return venum('notFound', { message: `Parent note ${parentId} not found` });

  const childScale = parentScale && parentScale < 1.0 ? parentScale : 1.0;
  const childNode = await services.prisma.note.create({
    data: {
      arrangementId, userId,
      content: '', type: 'ASSISTANT', status: initialStatus,
      x: parentNote.x + offset.x,
      y: parentNote.y + offset.y,
      scale: childScale,
      // Inherit layer membership: a spawned reply lives on the same layer(s)
      // as the prompt that produced it. Otherwise the new node would show
      // up as "global" and clutter every layer view.
      layers: parentNote.layers ?? [],
      assistantProvider: model,
    },
  });
  const edge = await services.prisma.edge.create({
    data: Edge.childEdgeData(arrangementId, parentId, childNode.id),
  });
  return venum('ok', { node: childNode, edge });
};

// SSE helpers — use services.nats.publish (not .client.publish) so trace
// context is injected into the NATS headers, keeping the SSE delivery on
// the same Cloud Trace span as the action that produced it.
//
// We catch publish failures rather than letting them bubble (the SSE pipe is
// best-effort — a missed event is recoverable on next canvas reload), but
// we log them so a broken NATS connection doesn't disappear in silence.
export const emitNodeUpdated = (userId: string, node: Note.Model): void => {
  const message = SSE.nodeUpdated(userId, Note.Transform.toRfNode(node));
  services.nats.publish('sse.node.updated', message).catch(err =>
    log.warn({ err, userId, noteId: node.id }, 'sse.node.updated publish failed'),
  );
};

export const emitNodeCreated = (userId: string, node: Note.Model, edge: Edge.Model): void => {
  const message = SSE.nodeCreated(userId, Note.Transform.toRfNode(node), Edge.Transform.toRfEdge(edge));
  services.nats.publish('sse.node.created', message).catch(err =>
    log.warn({ err, userId, noteId: node.id, edgeId: edge.id }, 'sse.node.created publish failed'),
  );
};

// Server-initiated deletion (provisioning failure, cron cleanup, etc.). The
// frontend removes the node and surfaces `reason` as a toast — see
// useRunningNodeUpdates.handleNodeDeleted.
export const emitNodeDeleted = (userId: string, noteId: string, reason?: string): void => {
  const message = SSE.nodeDeleted(userId, noteId, reason);
  services.nats.publish('sse.node.deleted', message).catch(err =>
    log.warn({ err, userId, noteId }, 'sse.node.deleted publish failed'),
  );
};
