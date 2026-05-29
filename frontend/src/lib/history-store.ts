// History store - undo/redo functionality for canvas
import { create } from 'zustand'
import type { Node, Edge } from '@xyflow/react'

// History state for undo/redo
interface HistoryState {
  nodes: Node[]
  edges: Edge[]
}

interface HistoryStore {
  past: HistoryState[]
  present: HistoryState
  future: HistoryState[]
  canUndo: boolean
  canRedo: boolean
  pushState: (state: HistoryState) => void
  undo: () => HistoryState | null
  redo: () => HistoryState | null
}

// Create history store
export const useHistoryStore = create<HistoryStore>((set, get) => ({
  past: [],
  present: { nodes: [], edges: [] },
  future: [],
  
  get canUndo() { return get().past.length > 0 },
  get canRedo() { return get().future.length > 0 },
  
  pushState(newState: HistoryState) {
    const { present } = get()
    set({
      past: [...get().past, present].slice(-50), // Keep last 50 states
      present: newState,
      future: [] // Clear future on new action
    })
  },
  
  undo() {
    const { past, present, future } = get()
    if (past.length === 0) return null
    
    const previous = past[past.length - 1]
    set({
      past: past.slice(0, -1),
      present: previous,
      future: [present, ...future]
    })
    return previous
  },
  
  redo() {
    const { past, present, future } = get()
    if (future.length === 0) return null
    
    const next = future[0]
    set({
      past: [...past, present],
      present: next,
      future: future.slice(1)
    })
    return next
  }
}))
