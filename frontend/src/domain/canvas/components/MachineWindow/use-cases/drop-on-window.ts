import { venum } from 'venum'
import { CanvasDragPayload } from '../../../drag/payloads'
import { useCanvasStore } from '../../../store'
import {
  importPaneAsTab,
  importPaneAtEdge,
  movePaneWithinToEdge,
  movePaneWithinToTab,
} from './index'

export type DropZone = 'top' | 'right' | 'bottom' | 'left' | 'tab'

export type DropResult =
  | ReturnType<typeof venum<'ok', { what: 'moved' | 'imported' }>>
  | ReturnType<typeof venum<'refused', { reason: string }>>
  | ReturnType<typeof venum<'ignored'>>

// Single dispatcher for "something was dropped on a machine window". Reads
// the payload, routes by kind, applies the right use case. UI handlers
// call this and `match` the result. Files dropped on the window are
// intentionally ignored — the canvas-level drop handler owns files.
export function dropOnWindow(input: {
  machineNodeId: string
  zone: DropZone
  dataTransfer: DataTransfer
}): DropResult {
  const payload = CanvasDragPayload.parse(input.dataTransfer)
  if (!payload) return venum('ignored')

  if (payload.kind === 'pane') {
    if (payload.parentMachineNodeId !== input.machineNodeId) {
      return venum('refused', { reason: 'Cross-window pane move is not supported yet' })
    }
    const moveResult =
      input.zone === 'tab'
        ? movePaneWithinToTab({ machineNodeId: input.machineNodeId, paneId: payload.paneId })
        : movePaneWithinToEdge({
            machineNodeId: input.machineNodeId,
            paneId: payload.paneId,
            edge: input.zone,
          })
    if (moveResult.tag === 'refused') return moveResult
    return venum('ok', { what: 'moved' })
  }

  if (payload.kind === 'canvas-terminal') {
    // Demote the canvas TERMINAL note (keeps the daemon pane alive) and
    // attach the same paneId into this window.
    const demoted = useCanvasStore.getState().demoteTerminal(payload.sourceNoteId)
    if (!demoted) return venum('refused', { reason: 'Could not import terminal' })
    if (input.zone === 'tab') {
      importPaneAsTab({ machineNodeId: input.machineNodeId, paneId: demoted.paneId, name: demoted.label })
    } else {
      importPaneAtEdge({ machineNodeId: input.machineNodeId, paneId: demoted.paneId, edge: input.zone })
    }
    return venum('ok', { what: 'imported' })
  }

  // 'file' — not our concern, fall through.
  return venum('ignored')
}
