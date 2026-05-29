import { z } from 'zod';
import { Edge as RfEdge } from '@xyflow/react';
import { pickDefined } from '../utils/object';

export namespace Edge {
  // ============================================
  // CORE MODEL
  // ============================================
  
  export interface Model {
    id: string;
    arrangementId: string;
    sourceId: string;
    targetId: string;
    sourceHandleId?: string;
    targetHandleId?: string;
    type: string;
    label?: string;
    version: number; // For optimistic sync and LWW conflict resolution
    createdAt: Date;
    updatedAt: Date;
  }

  // ============================================
  // DTOs (what frontend sends)
  // ============================================
  
  export namespace DTO {
    export const CreateSchema = z.object({
      sourceId: z.string().min(1),
      targetId: z.string().min(1),
      sourceHandleId: z.string().optional(),
      targetHandleId: z.string().optional(),
      type: z.string().default('default'),
      label: z.string().optional(),
    });

    export const UpdateSchema = z.object({
      label: z.string().optional(),
      type: z.string().optional(),
    });

    export type Create = z.infer<typeof CreateSchema>;
    export type Update = z.infer<typeof UpdateSchema>;
  }

  // ============================================
  // VALIDATION & CREATION
  // ============================================
  
  export const validate = {
    create: (data: unknown): DTO.Create => DTO.CreateSchema.parse(data),
    update: (data: unknown): DTO.Update => DTO.UpdateSchema.parse(data),
  };

  export const create = (
    data: DTO.Create,
    arrangementId: string
  ): Omit<Model, 'id' | 'createdAt' | 'updatedAt'> => ({
    arrangementId,
    sourceId: data.sourceId,
    targetId: data.targetId,
    sourceHandleId: data.sourceHandleId,
    targetHandleId: data.targetHandleId,
    type: data.type,
    label: data.label,
    version: 1, // New edges start at version 1
  });

  // ============================================
  // PATCH OPERATIONS (Pure business logic)
  // ============================================

  const EDGE_DEFAULTS = {
    sourceHandleId: '',
    targetHandleId: '',
    type: 'default',
    label: '',
    version: 1,
  };

  /** Data for creating a parent-child edge (used by AI response nodes) */
  export const childEdgeData = (arrangementId: string, sourceId: string, targetId: string) => ({
    arrangementId,
    sourceId,
    targetId,
    type: 'custom',
    label: '',
    sourceHandleId: '',
    targetHandleId: '',
  });

  export namespace Patch {
    // Validation
    export type ValidationResult = { valid: true } | { valid: false; reason: string };

    export const canCreate = (ctx: { targetExists: boolean; isMergePoint: boolean; hasParent: boolean }): ValidationResult => {
      if (!ctx.targetExists) return { valid: false, reason: 'Target node not found' };
      if (ctx.hasParent && !ctx.isMergePoint) {
        return { valid: false, reason: 'Target already has a parent. Enable "Allow Multiple Parents".' };
      }
      return { valid: true };
    };

    // Create data from patch DTO (frontend field names → model field names)
    export const toCreateData = (
      dirty: { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; type?: string; label?: string },
      arrangementId: string
    ) => ({
      ...EDGE_DEFAULTS,
      id: dirty.id,
      arrangementId,
      sourceId: dirty.source,
      targetId: dirty.target,
      ...pickDefined({
        sourceHandleId: dirty.sourceHandle ?? undefined,
        targetHandleId: dirty.targetHandle ?? undefined,
        type: dirty.type,
        label: dirty.label
      }),
    });

    export const toUpdateData = (dirty: { sourceHandle?: string | null; targetHandle?: string | null; type?: string; label?: string }) =>
      pickDefined({
        sourceHandleId: dirty.sourceHandle ?? undefined,
        targetHandleId: dirty.targetHandle ?? undefined,
        type: dirty.type,
        label: dirty.label
      });
  }

  // ============================================
  // TRANSFORMS
  // ============================================

  export const Transform = {
    toRfEdge: (edge: Model): RfEdge => ({
      id: edge.id,
      source: edge.sourceId,
      target: edge.targetId,
      sourceHandle: edge.sourceHandleId,
      targetHandle: edge.targetHandleId,
      type: edge.type || 'smoothstep',
      label: edge.label,
    }),

    fromRfEdge: (
      edge: RfEdge,
      arrangementId: string
    ) => ({
      id: edge.id,
      arrangementId,
      sourceId: edge.source,
      targetId: edge.target,
      sourceHandleId: edge.sourceHandle || '',
      targetHandleId: edge.targetHandle || '',
      type: edge.type || 'smoothstep',
      label: (edge.label as string) || '',
    }),
  };

  // ============================================
  // TREE TRAVERSAL FUNCTIONS (Pure)
  // ============================================

  /**
   * Find the parent of a node (pure function)
   * @param nodeId - The ID of the node to find parent for
   * @param edges - Array of edges to search through
   * @returns Parent node ID or null if no parent exists (root node)
   */
  export const findParent = (nodeId: string, edges: Model[]): string | null => {
    const parentEdge = edges.find(edge => edge.targetId === nodeId);
    return parentEdge?.sourceId ?? null;
  };

  /**
   * Find all parents of a node (for DAG support)
   * @param nodeId - The ID of the node to find parents for
   * @param edges - Array of edges to search through
   * @returns Array of parent node IDs
   */
  export const findParents = (nodeId: string, edges: Model[]): string[] => {
    return edges
      .filter(edge => edge.targetId === nodeId)
      .map(edge => edge.sourceId);
  };

  /**
   * Find all children of a node (pure function)
   * @param nodeId - The ID of the node to find children for
   * @param edges - Array of edges to search through
   * @returns Array of child node IDs
   */
  export const findChildren = (nodeId: string, edges: Model[]): string[] => {
    return edges
      .filter(edge => edge.sourceId === nodeId)
      .map(edge => edge.targetId);
  };

  /**
   * Get all ancestor IDs from root to parent of the given node (pure function)
   * For trees, returns single path. For DAGs with merge points, returns first path found.
   * @param nodeId - The ID of the node to get ancestors for
   * @param edges - Array of edges to search through
   * @returns Array of ancestor IDs ordered from root to immediate parent
   */
  export const getAncestorIds = (nodeId: string, edges: Model[]): string[] => {
    const ancestors: string[] = [];
    let currentId: string | null = nodeId;

    // Traverse up the tree from node to root
    while (currentId) {
      currentId = findParent(currentId, edges);
      if (currentId) {
        ancestors.unshift(currentId); // Add to beginning for root->parent order
      }
    }

    return ancestors;
  };

  /**
   * Find all unique root nodes reachable from a given node
   * @param nodeId - The ID of the node to find roots for
   * @param edges - Array of edges to search through
   * @returns Array of root node IDs
   */
  export const findAllRoots = (nodeId: string, edges: Model[]): string[] => {
    const roots: Set<string> = new Set();
    const visited: Set<string> = new Set();

    const traverse = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      const parents = findParents(id, edges);
      if (parents.length === 0) {
        // This is a root node
        roots.add(id);
      } else {
        parents.forEach(parentId => traverse(parentId));
      }
    };

    traverse(nodeId);
    return Array.from(roots);
  };

  /**
   * Get all distinct paths from a node to all reachable root nodes
   * Each path is an array of node IDs ordered from root to the node (exclusive of the node itself)
   * @param nodeId - The ID of the node to find paths for
   * @param edges - Array of edges to search through
   * @returns Array of paths, where each path is an array of node IDs from root to parent
   */
  export const getAllPathsToRoots = (nodeId: string, edges: Model[]): string[][] => {
    const allPaths: string[][] = [];

    // Cycle guard: the visiting set is path-scoped, not function-scoped, so a
    // node can still appear in sibling paths but cannot recurse into itself.
    // Flow-validation on the frontend prevents cycles via the UI, but this
    // function is pure and may be called on any edge list — defend in depth.
    const buildPaths = (currentId: string, currentPath: string[], visiting: Set<string>): void => {
      if (visiting.has(currentId)) return; // cycle — stop this branch
      const nextVisiting = new Set(visiting);
      nextVisiting.add(currentId);

      const parents = findParents(currentId, edges);

      if (parents.length === 0) {
        // Reached a root - save the path (reversed to be root->parent order)
        allPaths.push([...currentPath].reverse());
      } else {
        // Continue up each parent branch
        parents.forEach(parentId => {
          buildPaths(parentId, [...currentPath, parentId], nextVisiting);
        });
      }
    };

    buildPaths(nodeId, [], new Set());
    return allPaths;
  };

  /**
   * Find all paths from a node to roots, respecting ancestorOverride.
   * This is the CORE algorithm used by both frontend and backend.
   *
   * Algorithm:
   * - Start at node, traverse bottom-to-top recursively
   * - At each node: check if it has ancestorOverride
   * - If YES: SHORT-CIRCUIT this path, use the override
   * - If NO: continue up via edges
   *
   * Returns paths in bottom-to-top order: [CurrentNode, Parent, Root]
   *
   * @param nodeId - Starting node ID
   * @param edges - Array of edges for traversal
   * @param ancestorOverrides - Map of nodeId -> ancestorOverride array (bottom-to-top order, includes the node itself)
   * @returns Array of paths, each path is [CurrentNode, Parent, ..., Root]
   */
  export const findPathsWithOverrides = (
    nodeId: string,
    edges: Model[],
    ancestorOverrides: Map<string, string[]>
  ): string[][] => {
    // Cycle guard: tracks nodes on the current recursion branch. Overrides
    // short-circuit before recursing, so they're safe without the guard;
    // plain edge traversal needs it in case of accidental cycles.
    const findPaths = (currentId: string, visiting: Set<string>): string[][] => {
      // Check if this node has ancestorOverride - SHORT-CIRCUIT if found
      const override = ancestorOverrides.get(currentId);
      if (override && override.length > 0) {
        // Override contains ancestor IDs only (not including current node)
        // Prepend current node to match bottom-to-top format: [CurrentNode, Parent, Root]
        return [[currentId, ...override]];
      }

      if (visiting.has(currentId)) {
        // Cycle — truncate this path with just the current node so the caller
        // still gets a usable partial chain rather than an infinite loop.
        return [[currentId]];
      }
      const nextVisiting = new Set(visiting);
      nextVisiting.add(currentId);

      // No override - find parents and recurse
      const parents = findParents(currentId, edges);

      // Base case: no parents (root node)
      if (parents.length === 0) {
        return [[currentId]]; // Just this node
      }

      // Recursive case: get paths from each parent
      const allPaths: string[][] = [];

      for (const parentId of parents) {
        const parentPaths = findPaths(parentId, nextVisiting);

        // Prepend current node to each parent path
        parentPaths.forEach(path => {
          allPaths.push([currentId, ...path]);
        });
      }

      return allPaths;
    };

    return findPaths(nodeId, new Set());
  };

  /**
   * Get all unique ancestor IDs for a node (union of all paths)
   * Useful when you need all context regardless of path
   * @param nodeId - The ID of the node to get ancestors for
   * @param edges - Array of edges to search through
   * @returns Array of unique ancestor IDs (order not guaranteed)
   */
  export const getAllAncestorIds = (nodeId: string, edges: Model[]): string[] => {
    const ancestors: Set<string> = new Set();
    const visited: Set<string> = new Set();

    const traverse = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      const parents = findParents(id, edges);
      parents.forEach(parentId => {
        ancestors.add(parentId);
        traverse(parentId);
      });
    };

    traverse(nodeId);
    return Array.from(ancestors);
  };

  /**
   * Get all unique descendant IDs for a node (transitive children via BFS).
   * Respects DAGs — each node visited once, avoiding cycles.
   * @param nodeId - The ID of the node to get descendants for
   * @param edges - Array of edges to search through
   * @returns Array of unique descendant IDs (breadth-first order, excluding the node itself)
   */
  export const getDescendantIds = (nodeId: string, edges: Model[]): string[] => {
    const descendants: string[] = [];
    const visited: Set<string> = new Set([nodeId]);
    const queue: string[] = [nodeId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = findChildren(currentId, edges);
      for (const childId of children) {
        if (!visited.has(childId)) {
          visited.add(childId);
          descendants.push(childId);
          queue.push(childId);
        }
      }
    }

    return descendants;
  };

  /**
   * Check if a node is a root (has no parent) (pure function)
   * @param nodeId - The ID of the node to check
   * @param edges - Array of edges to search through
   * @returns True if the node is a root, false otherwise
   */
  export const isRoot = (nodeId: string, edges: Model[]): boolean => {
    return !edges.some(edge => edge.targetId === nodeId);
  };

  /**
   * Check if a node has multiple parents (is a merge point or descendant of one)
   * @param nodeId - The ID of the node to check
   * @param edges - Array of edges to search through
   * @returns True if the node has multiple paths to roots
   */
  export const hasMultiplePaths = (nodeId: string, edges: Model[]): boolean => {
    const paths = getAllPathsToRoots(nodeId, edges);
    return paths.length > 1;
  };

  /**
   * Get the depth of a node in the tree (pure function)
   * @param nodeId - The ID of the node to get depth for
   * @param edges - Array of edges to search through
   * @returns Number representing the depth (0 for root, 1 for children of root, etc.)
   */
  export const getDepth = (nodeId: string, edges: Model[]): number => {
    return getAncestorIds(nodeId, edges).length;
  };
}
