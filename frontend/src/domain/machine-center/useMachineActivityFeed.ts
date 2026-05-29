'use client'

import { useEffect } from 'react'
import { useMachineCenterStore } from './store'

// Seeds machine metrics/activity when the canvas mounts, then lets the live
// `machine:activity` SSE stream (see useRunningNodeUpdates) keep it fresh — so
// MachineNode bodies + pane chrome update in ~realtime, not on a poll.
//
// The interval is just a slow safety net: it re-seeds in case the SSE
// connection dropped and missed events, or full metrics (cpu/mem/ports) drifted
// since the initial fetch. Liveness comes from SSE, not from this.
const ACTIVITY_FALLBACK_MS = 60_000

export function useMachineActivityFeed() {
  const fetchMachines = useMachineCenterStore(s => s.fetchMachines)
  useEffect(() => {
    fetchMachines()
    const id = setInterval(fetchMachines, ACTIVITY_FALLBACK_MS)
    return () => clearInterval(id)
  }, [fetchMachines])
}
