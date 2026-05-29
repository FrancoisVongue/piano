'use client';

/**
 * Valtio reactive shadow of the canvas nodes.
 *
 * One-way mirror from the Zustand canvas store. Writes still go through
 * Zustand (which keeps history/sync/undo coordination intact); this
 * proxy exists so consumers can subscribe to ONE specific node by id
 * with fine-grained reactivity, instead of subscribing to the whole
 * `state.nodes` array and skipping re-renders via custom equality.
 *
 * Why a plain object keyed by id (and not `proxyMap`):
 * `proxyMap` docs explicitly note plain objects are faster for string
 * keys, and we never need Map's insertion-order semantics here — render
 * order is owned by React Flow.
 */

import { proxy, useSnapshot } from 'valtio';
import { useEffect } from 'react';
import type { Node } from '@xyflow/react';
import { useCanvasStore } from './store';
import type { CanvasNode } from './types';

type CanvasNodeShape = Node<CanvasNode.UI>;

interface CanvasReactiveState {
  nodesById: Record<string, CanvasNodeShape>;
}

export const canvasReactive = proxy<CanvasReactiveState>({
  nodesById: {},
});

const emptyReactiveNode = proxy({}) as CanvasNodeShape;
const canvasReactivePresence = proxy({ version: 0 });

/**
 * Mounts the Zustand → Valtio sync. Call ONCE near the canvas root.
 *
 * Per drag tick React Flow replaces the dragged node object and preserves
 * every untouched node object. Track the last raw node ref per id so the
 * proxy only receives writes for refs that actually changed.
 */
export function useCanvasReactiveSync(): void {
  useEffect(() => {
    const lastById = new Map<string, CanvasNodeShape>();

    const apply = (next: readonly CanvasNodeShape[]) => {
      const seen = new Set<string>();
      for (const n of next) {
        seen.add(n.id);
        const existing = canvasReactive.nodesById[n.id];
        if (!existing) {
          // Shallow-clone before insert: Zustand outputs are Immer-frozen,
          // which makes their properties non-writable. Valtio's set trap
          // would throw on subsequent sync writes against such a target.
          // Inner refs (data, position) stay shared with Zustand because
          // we only ever REPLACE them, never mutate them in place.
          canvasReactive.nodesById[n.id] = { ...n };
          lastById.set(n.id, n);
          canvasReactivePresence.version += 1;
          continue;
        }
        if (lastById.get(n.id) === n) continue;
        // Unconditional reassign. We can't use `existing.X !== n.X` to skip
        // — reading `existing.X` returns a *child proxy*, so the comparison
        // would never be equal. Valtio's set trap compares against the raw
        // target value and short-circuits same-ref writes internally.
        existing.data = n.data;
        existing.position = n.position;
        existing.selected = n.selected;
        existing.hidden = n.hidden;
        existing.parentId = n.parentId;
        existing.type = n.type;
        existing.width = n.width;
        existing.height = n.height;
        existing.zIndex = n.zIndex;
        lastById.set(n.id, n);
      }
      for (const id of Object.keys(canvasReactive.nodesById)) {
        if (!seen.has(id)) {
          delete canvasReactive.nodesById[id];
          lastById.delete(id);
          canvasReactivePresence.version += 1;
        }
      }
    };

    apply(useCanvasStore.getState().nodes as CanvasNodeShape[]);

    return useCanvasStore.subscribe((state, prev) => {
      if (state.nodes === prev.nodes) return;
      apply(state.nodes as CanvasNodeShape[]);
    });
  }, []);
}

/**
 * Hook reading one node by id with fine-grained reactivity. Re-renders
 * only when this specific node's tracked fields change — not on drag
 * ticks of other nodes, not on add/remove of unrelated nodes.
 *
 * The runtime value is a Valtio snapshot (deep-frozen). We type it as the
 * regular `CanvasNodeShape` because every consumer in the codebase only
 * READS — making the snapshot's `Readonly<...>` propagate would force
 * every callsite to cast away readonly to interop with hooks/actions
 * that expect mutable types. The lie is local: any write to the returned
 * value WILL throw at runtime, which is the correct failure mode.
 */
export function useReactiveNode(id: string | null | undefined): CanvasNodeShape | undefined {
  const presenceSnap = useSnapshot(canvasReactivePresence);
  const nodeProxy = id ? canvasReactive.nodesById[id] : undefined;
  const nodeSnap = useSnapshot(nodeProxy ?? emptyReactiveNode);

  void presenceSnap.version;
  if (!id) return undefined;
  if (nodeProxy) return nodeSnap as CanvasNodeShape;
  return undefined;
}

/**
 * Composite of `state.selectedNodeId` + `useReactiveNode`. Used by the
 * edit panels which take either a prop-supplied id or fall back to the
 * canvas selection.
 */
export function useSelectedReactiveNode(override?: string | null): CanvasNodeShape | undefined {
  const storeSelectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  return useReactiveNode(override ?? storeSelectedNodeId);
}
