'use client'

import { useEffect } from 'react'
import { useCanvasStore } from '../../store'
import { useMachineWindowStore } from './store'

// Bridge: when a MACHINE node's window layout changes, mark the canvas node
// dirty so the existing canvas sync pipeline (`useCanvasSync`) picks it up
// and patches `windowLayout` to the backend.
//
// Implemented as a top-level hook used once per Canvas mount. We compare
// layout references — Immer gives us new top-level objects only when fields
// change, so reference equality is a reliable change signal here.
export function usePersistMachineLayouts() {
  useEffect(() => {
    let prev = useMachineWindowStore.getState().layouts
    const unsub = useMachineWindowStore.subscribe(
      s => s.layouts,
      next => {
        const setDirty = useCanvasStore.getState().setDirty
        for (const [machineNodeId, layout] of Object.entries(next)) {
          if (prev[machineNodeId] !== layout) {
            setDirty(machineNodeId, true, 'node')
          }
        }
        prev = next
      },
    )
    return () => {
      unsub()
    }
  }, [])
}
