import { useEffect, useCallback } from 'react'
import { useCanvasStore } from '../store'
import { useArrangement } from '@/domain/arrangement/hooks/useArrangements'
import { useCanvasSync } from './useCanvasSync'
import { Note, Edge as EdgeModel } from '@piano/shared'
import { useShallow } from 'zustand/react/shallow'

export function useCanvas(arrangementId: string | null) {
  // Use useShallow to prevent infinite loops while keeping performance
  const canvasState = useCanvasStore(
    useShallow(state => ({
      nodes: state.nodes,
      edges: state.edges,
      hasUnsavedChanges: state.hasUnsavedChanges,
      isSyncing: state.isSyncing,
      onNodesChange: state.onNodesChange,
      onEdgesChange: state.onEdgesChange,
      onConnect: state.onConnect,
      onNodeDragStop: state.onNodeDragStop,
      loadCanvasState: state.loadCanvasState,
      setHasUnsavedChanges: state.setHasUnsavedChanges,
      setNodeRunning: state.setNodeRunning,
      runNode: state.runNode
    }))
  )

  const { arrangement, isRunning } = useArrangement(arrangementId)
  const { forceSync } = useCanvasSync(arrangementId)

  // Load arrangement data into canvas
  useEffect(() => {
    if (arrangement && typeof arrangement === 'object' && 'notes' in arrangement && 'edges' in arrangement) {
      const rfNodes = (arrangement.notes as Note.Model[])?.map(Note.Transform.toRfNode) || []
      const rfEdges = (arrangement.edges as EdgeModel.Model[])?.map(EdgeModel.Transform.toRfEdge) || []
      canvasState.loadCanvasState(rfNodes, rfEdges)
    }
  }, [arrangement, canvasState.loadCanvasState])

  // Save canvas state (Cmd+S) - forces immediate patch sync
  const save = useCallback(() => {
    forceSync()
    return { success: true }
  }, [forceSync])

  return {
    // Canvas state
    nodes: canvasState.nodes,
    edges: canvasState.edges,
    hasUnsavedChanges: canvasState.hasUnsavedChanges,
    isSaving: canvasState.isSyncing,
    isRunning,

    // Canvas actions
    onNodesChange: canvasState.onNodesChange,
    onEdgesChange: canvasState.onEdgesChange,
    onConnect: canvasState.onConnect,
    onNodeDragStop: canvasState.onNodeDragStop,

    // Business actions
    save,
    runNode: canvasState.runNode,
  }
}