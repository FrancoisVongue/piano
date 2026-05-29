'use client'

import { useEffect, useMemo, useState } from 'react'
import { useOnlineDaemons } from '../hooks/useDaemons'

// State + auto-select + pin-handling for any UI that picks a daemon.
// Two surfaces today (Canvas machine picker, /machines SandboxPanel) used
// to copy/paste the same useState + useEffect + filter logic.
//
// `pinnedDaemonId` — when set, the picker locks to that daemon (template
// pinned to a specific host). `availableDaemons` reflects the constraint;
// callers pass `disabled={isPinned}` to their dropdown.
export function useDaemonPicker(opts: { pinnedDaemonId?: string | null } = {}) {
  const { onlineDaemons, isLoading } = useOnlineDaemons()
  const pinnedDaemonId = opts.pinnedDaemonId ?? null

  const availableDaemons = useMemo(
    () => pinnedDaemonId
      ? onlineDaemons.filter(d => d.id === pinnedDaemonId)
      : onlineDaemons,
    [onlineDaemons, pinnedDaemonId],
  )

  const [selectedDaemonId, setSelectedDaemonId] = useState<string | null>(null)

  useEffect(() => {
    if (pinnedDaemonId) {
      setSelectedDaemonId(pinnedDaemonId)
      return
    }
    if (selectedDaemonId && onlineDaemons.some(d => d.id === selectedDaemonId)) return
    setSelectedDaemonId(onlineDaemons[0]?.id ?? null)
  }, [onlineDaemons, selectedDaemonId, pinnedDaemonId])

  return {
    selectedDaemonId,
    setSelectedDaemonId,
    onlineDaemons,
    availableDaemons,
    isLoading,
    isPinned: !!pinnedDaemonId,
  }
}
