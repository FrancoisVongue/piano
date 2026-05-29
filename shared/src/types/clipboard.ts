import { Note } from './note'
import { Edge } from './edge'

/**
 * Clipboard namespace for copy/paste operations
 * Supports copying/pasting multiple nodes with their internal edges
 */
export namespace Clipboard {
  /**
   * Current clipboard data version
   * Increment when making breaking changes to the data structure
   */
  export const CURRENT_VERSION = 1

  /**
   * Clipboard data structure
   * Contains nodes and edges where both endpoints are within the copied nodes
   */
  export type Data = {
    nodes: Note.Model[]
    edges: Edge.Model[]  // Only edges where both source and target are in nodes
    version: number       // For future compatibility
  }

  /**
   * Validate clipboard data structure
   * Ensures data is well-formed and all edge endpoints exist in nodes
   */
  export const validate = (data: unknown): data is Data => {
    if (!data || typeof data !== 'object') return false

    const d = data as Partial<Data>

    // Check required properties exist
    if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) return false
    if (typeof d.version !== 'number') return false

    // Check version compatibility (only accept current version for now)
    if (d.version !== CURRENT_VERSION) return false

    // Validate each node has required fields
    for (const node of d.nodes) {
      if (!node || typeof node !== 'object') return false
      if (typeof node.id !== 'string') return false
      if (typeof node.content !== 'string') return false
      if (typeof node.type !== 'string') return false
    }

    // Build set of node IDs for edge validation
    const nodeIds = new Set(d.nodes.map(n => n.id))

    // Validate each edge
    for (const edge of d.edges) {
      if (!edge || typeof edge !== 'object') return false
      if (typeof edge.id !== 'string') return false
      if (typeof edge.sourceId !== 'string') return false
      if (typeof edge.targetId !== 'string') return false

      // Ensure both edge endpoints exist in the copied nodes
      if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId)) {
        return false
      }
    }

    return true
  }

  /**
   * Create clipboard data from nodes and edges
   * Filters edges to only include those connecting copied nodes
   */
  export const create = (
    nodes: Note.Model[],
    allEdges: Edge.Model[]
  ): Data => {
    const nodeIds = new Set(nodes.map(n => n.id))

    // Only include edges where both endpoints are in copied nodes
    const edges = allEdges.filter(
      edge => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId)
    )

    return {
      nodes,
      edges,
      version: CURRENT_VERSION
    }
  }
}
