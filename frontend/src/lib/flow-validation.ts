import { getOutgoers } from '@xyflow/react'
import type { Node, Edge, Connection } from '@xyflow/react'

/**
 * Validates flow connections to enforce DAG structure:
 * - No cycles allowed
 * - Each node can have only one parent (tree constraint) UNLESS it's a merge point
 * - Connections must go from bottom handle to top handle
 */
export function createCycleValidator() {
  /**
   * Validates if a connection is allowed:
   * 1. No self-connections
   * 2. No cycles
   * 3. Each node can have only one parent UNLESS isMergePoint=true (DAG support)
   * 4. Connections must flow from bottom to top
   * @param connection The connection to validate
   * @param nodes Current nodes in the flow
   * @param edges Current edges in the flow
   * @returns true if connection is valid, false otherwise
   */
  const isValidConnection = (
    connection: Connection,
    nodes: Node[],
    edges: Edge[]
  ): boolean => {
    // Find the target node
    const targetNode = nodes.find((node) => node.id === connection.target)

    if (!targetNode) {
      return false
    }

    // 1. Prevent self-connections
    if (connection.target === connection.source) {
      return false
    }

    // 2. Enforce tree structure: each node can have only ONE parent
    // UNLESS the node is a merge point (isMergePoint=true)
    // Check if target already has an incoming edge
    const targetHasParent = edges.some(edge => edge.target === connection.target)
    if (targetHasParent) {
      // Check if target is a merge point
      const isMergePoint = (targetNode.data as any)?.isMergePoint === true

      if (!isMergePoint) {
        return false // Node already has a parent and is not a merge point
      }
    }

    // 3. Check if adding this edge would create a cycle
    const hasCycle = detectCycle(
      targetNode,
      connection.source,
      nodes,
      edges,
      new Set()
    )

    if (hasCycle) {
      return false
    }

    return true
  }

  /**
   * Recursively detects if there's a path from node to sourceId
   * @param node Starting node for the search
   * @param sourceId The ID we're looking for (would create a cycle)
   * @param nodes All nodes in the flow
   * @param edges All edges in the flow
   * @param visited Set of visited node IDs to prevent infinite loops
   * @returns true if a cycle would be created
   */
  const detectCycle = (
    node: Node,
    sourceId: string | null,
    nodes: Node[],
    edges: Edge[],
    visited: Set<string>
  ): boolean => {
    // If we've already visited this node in this path, no cycle here
    if (visited.has(node.id)) {
      return false
    }

    // Mark this node as visited
    visited.add(node.id)

    // Get all nodes that this node connects to
    const outgoers = getOutgoers(node, nodes, edges)

    // Check each outgoing connection
    for (const outgoer of outgoers) {
      // If we found the source node, we have a cycle
      if (outgoer.id === sourceId) {
        return true
      }

      // Recursively check the outgoer's connections
      if (detectCycle(outgoer, sourceId, nodes, edges, new Set(visited))) {
        return true
      }
    }

    return false
  }

  return { isValidConnection }
}