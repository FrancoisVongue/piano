/**
 * Temporal Activities: Thin wrappers around ActionController methods
 *
 * Following backend principles:
 * - Activities just delegate to controller methods (1-line!)
 * - Controllers = orchestrators (business logic)
 * - Zero code duplication
 */

import { ActionController } from '../../domains/action';
import { Note } from '@piano/shared';

// Temporal activities throw on failure — that's how Temporal retries work.
// We bridge the controller's venum → throw here, in one named place, so the
// rest of the domain never needs to know about Temporal's convention.

export async function createChildNode(
  parentId: string,
  arrangementId: string,
  userId: string,
  offset: { x: number; y: number },
): Promise<{ nodeId: string; edgeId: string }> {
  const r = await ActionController.createChildNode(parentId, arrangementId, userId, offset, 'RUNNING');
  if (r.tag !== 'ok') throw new Error(r.data.message);
  return { nodeId: r.data.node.id, edgeId: r.data.edge.id };
}

export async function updateNodeWithResult(
  nodeId: string,
  content: string,
): Promise<Note.Model> {
  return ActionController.updateNodeWithResult(nodeId, content);
}