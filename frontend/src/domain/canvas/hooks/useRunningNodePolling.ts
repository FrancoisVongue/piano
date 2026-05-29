import { useEffect } from 'react';
import { toast } from 'sonner';
import { useCanvasStore } from '../store';
import { useMachineCenterStore } from '@/domain/machine-center/store';
import { SSE_CONFIG } from '@/config';

const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 30_000;

/**
 * Simple SSE-based updates for running nodes
 * Listens to server-sent events and updates specific nodes when they complete
 */
export function useRunningNodeUpdates(userId: string | null) {
  useEffect(() => {
    if (!userId) {
      return;
    }

    let eventSource: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = INITIAL_RETRY_DELAY;
    let closed = false;

    const clearRetry = () => {
      if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
      }
    };

    // RAF-coalesced SSE node:updated handler.
    //
    // Without coalescing, N events that arrive in the same frame (e.g.
    // several running nodes pushing output-sync updates at once) each
    // trigger a full Zustand notify → Canvas re-render → React Flow
    // reconcile. That stacks into long tasks (~350ms with ~500 nodes
    // and a handful of concurrent updates).
    //
    // With coalescing: events accumulate in `pending` (last-write-wins
    // per node id), one RAF later we apply all of them in a SINGLE
    // setState. One reconcile per frame regardless of arrival rate.
    let pending = new Map<string, { node: any; finished: boolean }>();
    let flushRaf: number | null = null;

    const flushUpdates = () => {
      flushRaf = null;
      if (pending.size === 0) return;
      // Swap to a fresh Map BEFORE setState — any event arriving during the
      // reducer lands in the new `pending`, not in the batch we're flushing.
      const batch = pending;
      pending = new Map();

      useCanvasStore.setState((state) => {
        let nextNodes = state.nodes;

        for (let i = 0; i < state.nodes.length; i++) {
          const node = state.nodes[i];
          const upd = batch.get(node.id);
          if (!upd) continue;

          const nextContent = upd.node.data.content;
          const nextStatus = upd.node.data.status;
          if (node.data.content === nextContent && node.data.status === nextStatus) continue;

          if (nextNodes === state.nodes) nextNodes = state.nodes.slice();
          nextNodes[i] = {
            ...node,
            data: {
              ...node.data,
              content: nextContent,
              status: nextStatus,
            },
          };
        }

        // Run-completed nodes also drop their grace-window entry. Clone
        // the Map once if there's anything to drop.
        let nextRunStartedAt: Map<string, number> | undefined;
        for (const [id, upd] of batch) {
          if (upd.finished && state.runStartedAt.has(id)) {
            if (!nextRunStartedAt) nextRunStartedAt = new Map(state.runStartedAt);
            nextRunStartedAt.delete(id);
          }
        }

        if (nextNodes === state.nodes && !nextRunStartedAt) return state;
        return nextRunStartedAt
          ? { nodes: nextNodes, runStartedAt: nextRunStartedAt }
          : { nodes: nextNodes };
      });
    };

    const handleNodeUpdated = (event: MessageEvent) => {
      const payload = JSON.parse(event.data); // { node: ReactFlowNode }
      const updatedRfNode = payload.node;
      const finished = updatedRfNode.data.status !== 'RUNNING';
      pending.set(updatedRfNode.id, { node: updatedRfNode, finished });
      if (flushRaf === null) flushRaf = requestAnimationFrame(flushUpdates);
    };

    // Server-initiated deletion (provisioning failure, cron cleanup of
    // orphaned PROVISIONING rows). Removes the optimistic node and surfaces
    // the reason as a toast so the user knows WHY it disappeared.
    const handleNodeDeleted = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { nodeId: string; reason?: string };
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.filter(n => n.id !== payload.nodeId),
        edges: state.edges.filter(e => e.source !== payload.nodeId && e.target !== payload.nodeId),
      }));
      if (payload.reason) toast.error(payload.reason);
    };

    const handleNodeCreated = (event: MessageEvent) => {
      const payload = JSON.parse(event.data); // { node: ReactFlowNode, edge?: ReactFlowEdge }
      const newNode = payload.node;
      const newEdge = payload.edge;

      useCanvasStore.setState((state) => {
        const nodeExists = state.nodes.some(n => n.id === newNode.id);
        const nextNodes = nodeExists
          ? state.nodes.map(n => (n.id === newNode.id ? newNode : n))
          : [...state.nodes, newNode];

        let nextEdges = state.edges;
        if (newEdge) {
          const edgeExists = state.edges.some(e => e.id === newEdge.id);
          nextEdges = edgeExists
            ? state.edges.map(e => (e.id === newEdge.id ? newEdge : e))
            : [...state.edges, newEdge];
        }

        // Same delete-grace as the runNode HTTP path: a sibling fresh out of
        // the worker is just as easy to fat-finger as the primary.
        const nextRunStartedAt = new Map(state.runStartedAt);
        nextRunStartedAt.set(newNode.id, Date.now());

        return { nodes: nextNodes, edges: nextEdges, runStartedAt: nextRunStartedAt };
      });
    };

    // Live machine activity (running/exit/attention) — patch the machine-center
    // store so MachineNode bodies + pane chrome reflect it instantly, no poll.
    const handleMachineActivity = (event: MessageEvent) => {
      try {
        const { machineId, activity, activityGroup } = JSON.parse(event.data);
        useMachineCenterStore.getState().applyActivity(machineId, activity, activityGroup);
      } catch {
        // best-effort — a malformed frame just means a missed tick
      }
    };

    const connect = () => {
      if (closed) return;

      eventSource?.close();
      const next = new EventSource(`${SSE_CONFIG.BASE_URL}/events?clientId=${userId}`);
      eventSource = next;

      next.onopen = () => {
        retryDelay = INITIAL_RETRY_DELAY;
      };

      // Listen for node update events.
      next.addEventListener('node:updated', handleNodeUpdated);

      // Live machine activity stream.
      next.addEventListener('machine:activity', handleMachineActivity);

      // Listen for node created events (MULTIPLE_CHILDREN support).
      // Defensive dedup: an EventSource that reconnects can re-deliver the same
      // node:created (or it can race with the runNode HTTP response that already
      // pushed the same id). Without this guard we land duplicate React keys.
      next.addEventListener('node:created', handleNodeCreated);

      // Server-initiated deletion (provisioning failure, cron cleanup).
      next.addEventListener('node:deleted', handleNodeDeleted);

      next.onerror = () => {
        next.close();
        if (eventSource === next) {
          eventSource = null;
          scheduleReconnect();
        }
      };
    };

    const scheduleReconnect = () => {
      if (closed || retryTimeout) return;
      retryTimeout = setTimeout(() => {
        retryTimeout = null;
        connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    };

    connect();

    return () => {
      closed = true;
      if (flushRaf !== null) cancelAnimationFrame(flushRaf);
      clearRetry();
      eventSource?.close();
      eventSource = null;
    };
  }, [userId]);
}
