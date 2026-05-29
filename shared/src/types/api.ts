export namespace API {
  export interface SuccessResponse<T> {
    success: true;
    data: T;
  }

  export interface ErrorResponse {
    success: false;
    error: {
      message: string;
      code?: string;
      details?: unknown;
    };
  }

  export type Response<T> = SuccessResponse<T> | ErrorResponse;

  export interface PaginatedResponse<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  }

  export interface SSEMessage {
    type: 'update' | 'delete' | 'create' | 'error';
    data: unknown;
    timestamp: number;
  }

  // SSE Event Types (server -> client)
  export namespace SSE {
    export type EventType = 
      | 'node:updated'
      | 'node:created'
      | 'node:deleted'
      | 'edge:updated'
      | 'edge:created'
      | 'edge:deleted';

    export interface NodeUpdatedEvent {
      type: 'node:updated';
      data: any; // ReactFlow node (RfNode from backend)
    }

    export interface NodeCreatedEvent {
      type: 'node:created';
      data: any; // ReactFlow node
    }

    export interface EdgeUpdatedEvent {
      type: 'edge:updated';
      data: any; // ReactFlow edge
    }

    export type Event = NodeUpdatedEvent | NodeCreatedEvent | EdgeUpdatedEvent;
  }
}