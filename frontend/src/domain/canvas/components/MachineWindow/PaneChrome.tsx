'use client'

import React, { memo, useCallback } from 'react'
import { Move, X } from 'lucide-react'
import { match } from 'venum'
import { CanvasDragPayload } from '../../drag/payloads'
import { closePane } from './use-cases'
import { toast } from 'sonner'
import { confirmDestructive } from '@/lib/confirmDestructive'
import { useMachineCenterStore, selectMachineMetrics } from '@/domain/machine-center/store'
import { ActivityView } from '@/domain/machine-center/types'
import { ActivityDot } from '@/domain/machine-center/components/ActivityBadge'

// PaneChrome: drag-out + close, rendered inside TerminalPanel's top-right
// chrome cluster (same row as font-size). One spot for all per-pane
// affordances. Close is hidden for the machine's main PTY (since closing
// the main session would orphan the user — main PTY exits when the
// machine itself does).

type Props = {
  paneId: string
  parentMachineNodeId: string
  parentMachineId: string
}

const PaneChromeComponent = ({ paneId, parentMachineNodeId, parentMachineId }: Props) => {
  const isMainPty = paneId === parentMachineId

  // This pane's own activity. The container's primary machine carries the
  // rollup breakdown of every terminal (primary + shared panes), so we read
  // our own line out of the parent's group by paneId (== this pane's daemon
  // machine id). Calm panes render nothing.
  const parentMetrics = useMachineCenterStore(selectMachineMetrics(parentMachineId))
  const paneActivity = ActivityView.terminalIn(parentMetrics?.activityGroup, paneId)

  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLButtonElement>) =>
      CanvasDragPayload.serialize(e.dataTransfer, {
        kind: 'pane',
        paneId,
        parentMachineNodeId,
      }),
    [paneId, parentMachineNodeId],
  )

  const onClose = useCallback(async () => {
    // Blocking modal — closing a pane kills its daemon session and any
    // running process is gone. User explicitly Confirms to proceed; Esc
    // / overlay click cancels.
    const proceed = await confirmDestructive({
      title: 'Close this terminal?',
      description: 'The session and any running process will be terminated.',
      confirmLabel: 'Close terminal',
    })
    if (!proceed) return
    match(await closePane({ machineNodeId: parentMachineNodeId, parentMachineId, paneId }), {
      ok: () => undefined,
      closedTab: () => undefined,
      refused: ({ reason }) => toast.info(reason),
    })
  }, [paneId, parentMachineNodeId, parentMachineId])

  return (
    <>
      <ActivityDot activity={paneActivity} className="mr-0.5 shrink-0" />
      <button
        type="button"
        draggable
        onDragStart={onDragStart}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        className="flex h-6 w-6 cursor-grab items-center justify-center rounded text-gray-300 transition-colors hover:bg-white/10 hover:text-white active:cursor-grabbing"
        title="Drag to canvas (extract) or to a window edge (split)"
      >
        <Move className="h-3 w-3" />
      </button>
      {!isMainPty && (
        <button
          type="button"
          onMouseDown={e => e.stopPropagation()}
          onClick={e => {
            e.stopPropagation()
            void onClose()
          }}
          className="flex h-6 w-6 items-center justify-center rounded text-gray-300 transition-colors hover:bg-red-500/20 hover:text-red-300"
          title="Close this pane"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </>
  )
}

export const PaneChrome = memo(PaneChromeComponent)
