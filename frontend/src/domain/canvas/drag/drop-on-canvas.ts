import { venum, match } from 'venum'
import { Files } from '@piano/shared'
import { CanvasDragPayload } from './payloads'
import { useCanvasStore } from '../store'
import { removePaneFromLayout } from '../components/MachineWindow/use-cases'
import {
  createFileNodeFromMachine,
  type CreateFileNodeResult,
} from '@/domain/files/lib/createFileNode'

// Drop on the canvas pane (not inside a machine window). Two sources:
//   - File drag → make a USER note from the file content.
//   - Pane drag → promote the in-window pane to a canvas TERMINAL node.
// Canvas-terminal drag from one canvas spot to another is currently a
// no-op (React Flow handles regular node move; we don't catch it here).

export type DropResult =
  | ReturnType<typeof venum<'ok', { what: 'note-from-file' | 'pane-promoted'; name?: string }>>
  | ReturnType<typeof venum<'refused', { reason: string }>>
  | ReturnType<typeof venum<'fileResult', CreateFileNodeResult>>
  | ReturnType<typeof venum<'ignored'>>

export async function dropOnCanvas(input: {
  dataTransfer: DataTransfer
  position: { x: number; y: number }
}): Promise<DropResult> {
  const payload = CanvasDragPayload.parse(input.dataTransfer)
  if (!payload) return venum('ignored')

  if (payload.kind === 'file') {
    const r = await createFileNodeFromMachine({
      machineId: payload.machineId,
      path: payload.path,
      name: payload.name,
      sizeB: payload.sizeB,
      position: input.position,
    })
    if (r.tag === 'ok') return venum('ok', { what: 'note-from-file', name: r.data.name })
    return venum('fileResult', r)
  }

  if (payload.kind === 'pane') {
    const parent = useCanvasStore.getState().nodes.find(n => n.id === payload.parentMachineNodeId)
    const parentMachineId =
      (parent?.data as { machineId?: string })?.machineId || payload.parentMachineNodeId
    if (payload.paneId === parentMachineId) {
      return venum('refused', {
        reason: "Can't extract the machine's main terminal — open a new tab and drag that one",
      })
    }
    const newNodeId = useCanvasStore
      .getState()
      .promotePane(payload.paneId, payload.parentMachineNodeId, input.position)
    if (!newNodeId) return venum('refused', { reason: 'Could not promote pane' })
    removePaneFromLayout(payload.parentMachineNodeId, payload.paneId)
    return venum('ok', { what: 'pane-promoted' })
  }

  return venum('ignored')
}

// Toast helper for CreateFileNodeResult (uses a `tag` discriminator from
// before venum adoption — co-located here so this drop surface is one stop).
export const toastForFileResult = (
  r: CreateFileNodeResult,
  toast: { success: (m: string) => void; error: (m: string) => void },
): void => {
  match(r, {
    ok: ({ name }) => toast.success(`Created note from ${name}`),
    cancelled: () => undefined,
    binary: () => toast.error('Cannot drop a binary file as a node'),
    tooLarge: ({ sizeB }) =>
      toast.error(`File is too large (${Files.formatSize(sizeB)}) — download instead`),
    error: ({ message }) => toast.error(message),
  })
}

// Stable predicate for dragover: returns the right dropEffect for our payloads.
export const canvasAcceptsDrop = (
  types: ReadonlyArray<string> | DOMStringList,
): 'copy' | 'move' | null => {
  const list = Array.isArray(types) ? types : Array.from(types as DOMStringList)
  if (list.includes(CanvasDragPayload.MIME['pane'])) return 'move'
  if (list.includes(CanvasDragPayload.MIME['file'])) return 'copy'
  return null
}
