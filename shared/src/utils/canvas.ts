/**
 * Canvas utility functions for node operations
 * These are business logic utilities that work with any node structure
 */

export interface CanvasNode {
  id: string
  parentId?: string | null
  [key: string]: any
}

/**
 * Remove orphaned nodes (nodes with invalid parentId references)
 * Returns a cleaned array with orphaned nodes having their parentId cleared
 */
export function clearOrphanedNodes<T extends CanvasNode>(nodes: T[]): T[] {
  const nodeIds = new Set(nodes.map(n => n.id))
  
  return nodes.map(node => {
    if (node.parentId && !nodeIds.has(node.parentId)) {
      console.warn(`Clearing invalid parentId ${node.parentId} from node ${node.id}`)
      // Remove parentId and extent properties
      const { parentId, extent, ...rest } = node as any
      return rest as T
    }
    return node
  })
}

/**
 * Topological sort - ensures parent nodes appear before their children
 * This is critical for React Flow to maintain parent-child relationships
 */
export function topologicalSort<T extends CanvasNode>(nodes: T[]): T[] {
  const sorted: T[] = []
  const visited = new Set<string>()
  const nodeIds = new Set(nodes.map(n => n.id))
  
  const visit = (nodeId: string) => {
    if (visited.has(nodeId)) return
    visited.add(nodeId)
    
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return
    
    // Visit parent first (if exists and is valid)
    if (node.parentId && nodeIds.has(node.parentId)) {
      visit(node.parentId)
    }
    
    sorted.push(node)
  }
  
  // Visit all nodes
  nodes.forEach(node => visit(node.id))
  return sorted
}

/**
 * Filter nodes to only root-level nodes (no parentId)
 * Child nodes use relative positioning and should not be layout-ed independently
 */
export function filterRootNodes<T extends CanvasNode>(nodes: T[]): T[] {
  return nodes.filter(n => !n.parentId)
}

/**
 * Check if a node has a valid parent
 */
export function hasValidParent<T extends CanvasNode>(node: T, nodeIds: Set<string>): boolean {
  return !!(node.parentId && nodeIds.has(node.parentId))
}
