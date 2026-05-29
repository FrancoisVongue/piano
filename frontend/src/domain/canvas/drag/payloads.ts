// CanvasDragPayload — the single source of truth for every drag-and-drop
// that crosses canvas boundaries (file → canvas, pane → canvas, pane → window,
// canvas-terminal → window). One typed union with one MIME per variant, one
// serializer for sources, one parser for sinks. No JSON.parse anywhere in
// the UI: every callsite goes through this namespace.

export namespace CanvasDragPayload {
  // ---- variants ----

  /** A file inside a machine's filesystem (dragged from FilesPanel). */
  export type File = {
    kind: 'file'
    machineId: string
    path: string
    name: string
    sizeB: number
  }

  /** A pane inside a machine window (dragged from PaneChrome). */
  export type Pane = {
    kind: 'pane'
    paneId: string
    parentMachineNodeId: string
  }

  /** A canvas-level TERMINAL note (dragged from TerminalNode). */
  export type CanvasTerminal = {
    kind: 'canvas-terminal'
    sourceNoteId: string
    paneId: string
    parentMachineNodeId: string | null
  }

  export type Any = File | Pane | CanvasTerminal

  // ---- MIME registry ----

  // Tied to the variant tag at the type level so adding a new payload kind
  // forces a new MIME row here (and vice versa) — drift between sender and
  // receiver becomes a compile error.
  export const MIME: Record<Any['kind'], string> = {
    'file': 'application/x-piano-file',
    'pane': 'application/x-piano-pane',
    'canvas-terminal': 'application/x-piano-canvas-terminal',
  }

  const KINDS = Object.keys(MIME) as Array<Any['kind']>

  // ---- serialize / parse ----

  /** Attach a payload to a DataTransfer at the start of a drag. */
  export const serialize = (dt: DataTransfer, payload: Any, effect: 'copy' | 'move' = 'move'): void => {
    dt.setData(MIME[payload.kind], JSON.stringify(payload))
    dt.effectAllowed = effect
  }

  /** Pull a payload off a DataTransfer at drop time. Returns null if no
   * recognised payload is present or the JSON is corrupt — callers should
   * treat that as "not a drop we handle". */
  export const parse = (dt: DataTransfer): Any | null => {
    for (const kind of KINDS) {
      const raw = dt.getData(MIME[kind])
      if (!raw) continue
      try {
        return JSON.parse(raw) as Any
      } catch {
        return null
      }
    }
    return null
  }

  /** True if any of our MIME types are present in the dataTransfer types
   * list. Cheap; safe to call from dragenter / dragover handlers (which
   * fire often and shouldn't allocate). */
  export const isOurs = (types: ReadonlyArray<string> | DOMStringList): boolean => {
    const list = Array.isArray(types) ? types : Array.from(types as DOMStringList)
    return KINDS.some(k => list.includes(MIME[k]))
  }
}
