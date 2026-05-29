/**
 * SSE (Server-Sent Events) Types
 * 
 * General-purpose event types for real-time updates.
 * These events are domain-agnostic and can be used for any real-time update scenario.
 */

export namespace SSE {
  // ============================================
  // EVENT TYPES (Domain-Agnostic)
  // ============================================
  
  /**
   * Generic event type - all SSE events follow this structure
   */
  export type Event = 'node:created' | 'node:updated' | 'node:deleted' | 'edge:created' | 'edge:updated' | 'edge:deleted' | 'machine:activity';

  /**
   * Generic SSE message payload
   */
  export interface Message<TData = any> {
    userId: string;
    event: Event;
    data: TData;
  }

  // ============================================
  // SPECIFIC EVENT PAYLOADS
  // ============================================

  /**
   * Node created event - sent when a new node is created
   */
  export interface NodeCreated {
    node: any; // ReactFlow node format
    edge?: any; // Optional edge if node is connected to parent
  }

  /**
   * Node updated event - sent when a node's content/status changes
   */
  export interface NodeUpdated {
    node: any; // ReactFlow node format (partial or full)
  }

  /**
   * Node deleted event - sent when a node is removed server-side. Optional
   * reason surfaces in the UI as a toast (e.g. provisioning failed, cron
   * cleanup of orphaned PROVISIONING rows).
   */
  export interface NodeDeleted {
    nodeId: string;
    reason?: string;
  }

  /**
   * Edge created event - sent when a new edge is created
   */
  export interface EdgeCreated {
    edge: any; // ReactFlow edge format
  }

  /**
   * Edge updated event - sent when an edge changes
   */
  export interface EdgeUpdated {
    edge: any; // ReactFlow edge format (partial or full)
  }

  /**
   * Edge deleted event - sent when an edge is removed
   */
  export interface EdgeDeleted {
    edgeId: string;
  }

  /**
   * Machine activity event — the live, on-change push of a machine's terminal
   * activity (and container rollup for the primary). `activity`/`activityGroup`
   * are the daemon shapes (kept `any` here like the node payloads, since their
   * concrete types live in the backend/frontend services layer).
   */
  export interface MachineActivity {
    machineId: string;
    activity?: any;
    activityGroup?: any;
  }

  // ============================================
  // HELPER FUNCTIONS (Pure)
  // ============================================

  /**
   * Creates a properly formatted SSE message
   */
  export const createMessage = <TData>(
    userId: string,
    event: Event,
    data: TData
  ): Message<TData> => ({
    userId,
    event,
    data,
  });

  /**
   * Creates a node:created event message
   */
  export const nodeCreated = (
    userId: string,
    node: any,
    edge?: any
  ): Message<NodeCreated> => createMessage(userId, 'node:created', { node, edge });

  /**
   * Creates a node:updated event message
   */
  export const nodeUpdated = (
    userId: string,
    node: any
  ): Message<NodeUpdated> => createMessage(userId, 'node:updated', { node });

  /**
   * Creates a node:deleted event message
   */
  export const nodeDeleted = (
    userId: string,
    nodeId: string,
    reason?: string,
  ): Message<NodeDeleted> => createMessage(userId, 'node:deleted', { nodeId, reason });

  /**
   * Creates a machine:activity event message
   */
  export const machineActivity = (
    userId: string,
    machineId: string,
    activity?: any,
    activityGroup?: any,
  ): Message<MachineActivity> => createMessage(userId, 'machine:activity', { machineId, activity, activityGroup });

  /**
   * Creates an edge:created event message
   */
  export const edgeCreated = (
    userId: string,
    edge: any
  ): Message<EdgeCreated> => createMessage(userId, 'edge:created', { edge });

  /**
   * Creates an edge:updated event message
   */
  export const edgeUpdated = (
    userId: string,
    edge: any
  ): Message<EdgeUpdated> => createMessage(userId, 'edge:updated', { edge });

  /**
   * Creates an edge:deleted event message
   */
  export const edgeDeleted = (
    userId: string,
    edgeId: string
  ): Message<EdgeDeleted> => createMessage(userId, 'edge:deleted', { edgeId });

  /**
   * Serializes an SSE message for transmission
   */
  export const serialize = <TData>(message: Message<TData>): string => 
    JSON.stringify(message);

  /**
   * Deserializes an SSE message from JSON
   */
  export const deserialize = <TData = any>(json: string): Message<TData> => 
    JSON.parse(json);
}
