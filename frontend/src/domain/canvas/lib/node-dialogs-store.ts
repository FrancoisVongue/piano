/**
 * Global store for node-action dialogs (label rename, color picker, tags
 * editor, ancestor info). Any surface — card, edit panel, window dock —
 * triggers them through the action registry; a single <NodeDialogsHost>
 * mounted once by Canvas renders them in a React portal. This kills the
 * previous per-surface popover state duplication that caused the
 * card/panel menu lists to drift out of sync.
 */

import { create } from 'zustand'

export type NodeDialogKind = 'label' | 'color' | 'tags' | 'ancestors' | 'cache' | 'info' | 'branch' | 'workflow'

/** Rect of the trigger element (the clicked menu item or icon), used to
 * anchor the portaled popover near the click site. Stored as plain data,
 * not a DOMRect, so React's shallow compare stays stable. */
export interface DialogAnchor {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

interface NodeDialogsState {
  kind: NodeDialogKind | null
  nodeId: string | null
  anchor: DialogAnchor | null
  open: (kind: NodeDialogKind, nodeId: string, anchor: DialogAnchor) => void
  close: () => void
}

export const useNodeDialogsStore = create<NodeDialogsState>((set) => ({
  kind: null,
  nodeId: null,
  anchor: null,
  open: (kind, nodeId, anchor) => set({ kind, nodeId, anchor }),
  close: () => set({ kind: null, nodeId: null, anchor: null }),
}))

/** Helper — captures a click event's trigger rect as a DialogAnchor. */
export function anchorFromEvent(e: { currentTarget: EventTarget | null }): DialogAnchor | null {
  const el = e.currentTarget as HTMLElement | null
  if (!el || typeof el.getBoundingClientRect !== 'function') return null
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}
