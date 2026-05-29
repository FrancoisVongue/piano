import { services } from '../../services/init';
import { Note, Edge } from '@piano/shared';

/**
 * Get ancestors for a node (single path, top-to-bottom order)
 * Returns [Root, Parent] (excludes current node)
 */
export const getAncestors = async (nodeId: string, arrangementId: string): Promise<Note.Model[]> => {
  const paths = await getAncestorsForAllPaths(nodeId, arrangementId);
  if (!paths[0]?.length) return [];
  return paths[0].slice(1).reverse();
};

/**
 * Get all ancestor paths for a node (DAG support)
 * Returns array of paths in bottom-to-top order: [CurrentNode, Parent, Root]
 */
export const getAncestorsForAllPaths = async (nodeId: string, arrangementId: string): Promise<Note.Model[][]> => {
  const edges = await services.prisma.edge.findMany({ where: { arrangementId } });
  const allPossibleIds = collectAllPossibleNodeIds(nodeId, edges);
  const allNotes = await services.prisma.note.findMany({
    where: { id: { in: Array.from(allPossibleIds) }, arrangementId }
  });
  const ancestorOverrides = buildAncestorOverrideMap(allNotes);
  const pathIds = Edge.findPathsWithOverrides(nodeId, edges, ancestorOverrides);
  return convertPathIdsToNotes(pathIds, arrangementId);
};

const collectAllPossibleNodeIds = (nodeId: string, edges: Edge.Model[]): Set<string> => {
  const ids = new Set<string>([nodeId]);
  Edge.getAllPathsToRoots(nodeId, edges).forEach((path: string[]) =>
    path.forEach((id: string) => ids.add(id))
  );
  return ids;
};

const buildAncestorOverrideMap = (notes: Note.Model[]): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  notes.forEach(note => {
    if (note.ancestorOverride?.length > 0) {
      map.set(note.id, note.ancestorOverride);
    }
  });
  return map;
};

const convertPathIdsToNotes = async (pathIds: string[][], arrangementId: string): Promise<Note.Model[][]> => {
  const allIds = new Set<string>();
  pathIds.forEach(path => path.forEach(id => allIds.add(id)));

  const notes = await services.prisma.note.findMany({
    where: { id: { in: Array.from(allIds) }, arrangementId }
  });
  const noteMap = new Map(notes.map((n) => [n.id, n]));

  return pathIds.map(path =>
    path.map(id => noteMap.get(id)!).filter(Boolean)
  );
};
