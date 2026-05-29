'use client';

import { useCallback, useEffect } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import { useCanvasStore } from '../store';
import { useMachineWindowStore } from '../components/MachineWindow/store';
import { ArrangementService } from '@/domain/arrangement/services';
import { Union } from '@/lib/types';
import { Note } from '@piano/shared';
import { toast } from 'sonner';

/**
 * Hook for optimistic canvas synchronization (Chapter 2: LWW for structural changes)
 * Watches dirty entities and syncs them to the backend in batches after a debounce period
 */
export function useCanvasSync(arrangementId: string | null) {
  // Subscribe to lastChangeTimestamp - this updates on EVERY edit, even same node
  const lastChange = useCanvasStore(state => state.lastChangeTimestamp);
  const isSyncing = useCanvasStore(state => state.isSyncing);

  // Core patch body, extracted so it can be called with an EXPLICIT id. This
  // matters for the tab-switch cleanup path: `useDebouncedCallback` resolves
  // its callback from the latest render's closure, so flushing at cleanup
  // time would otherwise use the NEW arrangementId for edits that belong to
  // the previous one. With an explicit parameter the leaving-tab flush
  // writes to the correct arrangement.
  const runPatch = useCallback(async (id: string) => {
    const state = useCanvasStore.getState();
    if (!id || state.isSyncing || state.dirtyEntityIds.size === 0) {
      return;
    }

    // IMPORTANT: Push history right before sync to keep undo/redo coordinated with backend
    state.pushHistory();

    state.setIsSyncing(true);

    // TWO-PHASE: move dirty → inFlight ATOMICALLY. Any edits that land while
    // the PATCH below is still flying go into a fresh `dirty` set and survive
    // the success handler, so e.g. a Ctrl+Z mid-PATCH isn't silently wiped.
    const { ids: currentDirtyIds, types: dirtyTypes } = state.beginSync();
    const existingNodeIds = new Set(state.nodes.map(n => n.id));
    const existingEdgeIds = new Set(state.edges.map(e => e.id));

    const dirtyNodeIds = currentDirtyIds.filter(id => existingNodeIds.has(id));
    const dirtyEdgeIds = currentDirtyIds.filter(id => existingEdgeIds.has(id));

    // Separate deleted nodes from deleted edges using the type map.
    // Within deleted nodes, peel off DEMOTIONS — terminal nodes moving into
    // machine-window panes. Backend skips the daemon RPC for those so we don't
    // kill the pane we're about to embed. See ArrangementController.applyNodeDemotions.
    const demotedSnapshot = new Set(state.demotedNodeIds);
    const deletedIds = currentDirtyIds.filter(id => !existingNodeIds.has(id) && !existingEdgeIds.has(id));
    const deletedNodeIds: string[] = [];
    const deletedEdgeIds: string[] = [];
    const demotedNodeIds: string[] = [];

    deletedIds.forEach(id => {
      const type = dirtyTypes.get(id);
      if (type === 'edge') {
        deletedEdgeIds.push(id);
      } else if (demotedSnapshot.has(id)) {
        demotedNodeIds.push(id);
      } else {
        // Default to node if type not tracked (shouldn't happen with new code)
        deletedNodeIds.push(id);
      }
    });
    
    // Build patch payload — Note.Patch.fromRfNode owns the wire-shape; this
    // hook just decides which nodes to include. MachineWindow layouts live
    // in a separate store and don't ride on `node.data`, so we overlay them
    // here for MACHINE nodes after the base mapping.
    const machineLayouts = useMachineWindowStore.getState().layouts;
    const dirtyNodes: Note.DTO.PatchEntity[] = state.nodes
      .filter(node => dirtyNodeIds.includes(node.id))
      .map(node => {
        const base = Note.Patch.fromRfNode(node);
        if (base.type === 'MACHINE') {
          base.windowLayout = machineLayouts[node.id] ?? undefined;
        }
        return base;
      });

    const dirtyEdges: Note.DTO.PatchEdge[] = state.edges
      .filter(edge => dirtyEdgeIds.includes(edge.id))
      .map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle || null,
        targetHandle: edge.targetHandle || null,
        type: edge.type || 'default',
        label: (edge.label as string) || '',
      }));

    // Nothing to sync — give the in-flight buffer back to `dirty` so we don't
    // silently drop markers we just moved.
    if (dirtyNodes.length === 0 && dirtyEdges.length === 0 && deletedNodeIds.length === 0 && deletedEdgeIds.length === 0 && demotedNodeIds.length === 0) {
      useCanvasStore.getState().endSyncFailure(id);
      state.setIsSyncing(false);
      return;
    }

    const payload: Note.DTO.PatchPayload = {
      dirtyNodes,
      dirtyEdges,
      deletedNodeIds,
      deletedEdgeIds,
      demotedNodeIds,
    };
    
    // Sending patch to backend
    
    try {
      const result = await ArrangementService.patch(id, payload);

      Union.match({
        success: ({ processed, failed }) => {
          // TWO-PHASE: clear ONLY processed IDs from in-flight; any in-flight
          // items the backend didn't acknowledge are merged back into `dirty`
          // by endSyncSuccess for the next retry. Edits that landed in the
          // FRESH `dirty` set during the PATCH are untouched and will trigger
          // the next sync round.
          const allProcessed = [...processed.nodes, ...processed.edges];
          useCanvasStore.getState().endSyncSuccess(id, allProcessed);
          // Clear demotion tags ONLY for ids the backend acknowledged. If a
          // demoted id wasn't processed, endSyncSuccess merges it back into
          // dirty; keeping it in demotedNodeIds ensures the retry still
          // routes it as a demotion and not a destructive delete.
          const acked = Array.from(demotedSnapshot).filter(idOf => processed.nodes.includes(idOf));
          useCanvasStore.getState().clearDemoted(acked);

          // NOTE: Do not invalidate ['arrangement', id] here. With an active
          // observer it forces a background refetch → loadCanvasState wipes
          // history mid-session. Per-arrangement snapshots in the store keep
          // the cache from being authoritative on tab return anyway.

          if (failed.length > 0) {
            console.error('[SYNC] Some patches failed:', failed);
            const first = failed[0];
            if (first?.reason) toast.error(`Sync failed: ${first.reason}`);
          }
        },
        error: ({ message }) => {
          console.error('[SYNC] Failed:', message);
          // Restore in-flight back to dirty so the next debounce retries.
          useCanvasStore.getState().endSyncFailure(id);
        },
      }, result);
    } catch (error) {
      console.error('[SYNC] Exception:', error);
      useCanvasStore.getState().endSyncFailure(id);
    }

    useCanvasStore.getState().setIsSyncing(false);
  }, []);

  // Debounced wrapper: waits 2s after last change, then patches the CURRENT
  // arrangement. Safe because it only runs while the user is still on it.
  const sync = useDebouncedCallback(() => {
    if (arrangementId) void runPatch(arrangementId);
  }, 2000);

  // Trigger sync on EVERY change (lastChange updates on each keystroke)
  // This resets the debounce timer, so it waits 2s after LAST change, not first
  useEffect(() => {
    if (lastChange > 0 && !isSyncing) {
      sync(); // Debounced - timer resets on each call
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastChange, isSyncing]); // sync is stable from useDebouncedCallback

  // On tab switch: cancel the pending debounce (it would fire with the NEW
  // arrangementId and could write A's edits to B — especially bad for creates
  // since `tryUpdateNote` isn't arrangement-scoped and `toCreateData` stamps
  // the incoming `arrangementId` onto new notes). Then fire-and-forget a
  // patch for the PREVIOUS id so pending edits still make it to the backend.
  useEffect(() => {
    const capturedId = arrangementId;
    return () => {
      sync.cancel();
      if (capturedId && useCanvasStore.getState().dirtyEntityIds.size > 0) {
        void runPatch(capturedId);
      }
    };
  }, [arrangementId, runPatch, sync]);

  // Return forceSync for Cmd+S - immediately flushes pending changes for the
  // current arrangement.
  return {
    forceSync: () => {
      sync.cancel();
      if (arrangementId) void runPatch(arrangementId);
    },
  };
}
