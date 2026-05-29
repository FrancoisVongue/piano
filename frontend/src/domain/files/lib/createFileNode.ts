import { venum } from 'venum'
import { Files } from '@piano/shared'
import { useCanvasStore } from '@/domain/canvas/store'
import { FileService } from '../services'

// Use case: turn a file inside a machine into a USER (white note) on the canvas.
// Two surfaces call this — the FilesPanel's "Create as node" button and the
// canvas drop handler. Same flow, same guard rails, single source of truth.
//
// Why USER not TEXT: TEXT is for short headings / annotations and renders
// without a card. A pasted file content needs a real card (scroll, label,
// tags, status). Filename becomes the node label, content goes into body.

// Threshold above which we ask the user to confirm. Below it, drop silently.
// 100 KiB is chosen to roughly match "fits comfortably on screen as a note";
// beyond that the canvas turns into a wall of text and the user usually
// didn't mean to paste the whole thing.
const LARGE_FILE_CONFIRM_BYTES = 100 * 1024

// Hard cap on what we'll try to load into a node. Bigger than this, the user
// should download instead — a 5 MiB note destroys canvas perf on its own.
const MAX_NODE_BYTES = 1024 * 1024

export type CreateFileNodeInput = {
  machineId: string
  path: string
  name: string
  sizeB: number
  position?: { x: number; y: number } | null
}

export type CreateFileNodeResult =
  | ReturnType<typeof venum<'ok', { nodeId: string; name: string }>>
  | ReturnType<typeof venum<'cancelled'>>
  | ReturnType<typeof venum<'tooLarge', { sizeB: number }>>
  | ReturnType<typeof venum<'binary'>>
  | ReturnType<typeof venum<'error', { message: string }>>

export async function createFileNodeFromMachine(
  input: CreateFileNodeInput,
): Promise<CreateFileNodeResult> {
  if (input.sizeB > MAX_NODE_BYTES) {
    return venum('tooLarge', { sizeB: input.sizeB })
  }
  if (input.sizeB > LARGE_FILE_CONFIRM_BYTES) {
    const proceed = window.confirm(
      `${input.name} is ${Files.formatSize(input.sizeB)}. Drop the entire file content into a note?`,
    )
    if (!proceed) return venum('cancelled')
  }

  const result = await FileService.read(input.machineId, input.path, MAX_NODE_BYTES)
  if ('error' in result) return venum('error', { message: result.error.message })
  // Notes are text — image/binary files can't be coerced. The UI already
  // disables the "Create as node" button for non-text previews; this is the
  // belt-and-braces guard for the drag-to-canvas path.
  if (result.success.kind !== 'text') return venum('binary')

  const store = useCanvasStore.getState()
  const nodeId = store.createNode(input.position ?? null, result.success.content)
  if (!nodeId) return venum('error', { message: 'Could not create node' })
  store.updateNodeLabel(nodeId, input.name)
  return venum('ok', { nodeId, name: input.name })
}
