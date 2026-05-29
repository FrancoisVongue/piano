import { useCallback, useEffect, useMemo } from 'react'
import { ReactFlowInstance } from '@xyflow/react'
import { toast } from 'sonner'
import { isTypingTarget } from '@/lib/keyboard'
import {
  useWorkspacesStore,
  SLOT_KEYS,
  SlotKey,
  Workspace,
} from './useWorkspacesStore'
import { Analytics } from '@/lib/analytics'

interface UseWorkspacesArgs {
  arrangementId: string | null
  reactFlowInstance: ReactFlowInstance | null
}

interface UseWorkspacesReturn {
  /** Slot key → Workspace or null (always 9-entry, ordered '1'..'9'). */
  slots: Array<{ key: SlotKey; workspace: Workspace | null }>
  save: (slot: SlotKey) => void
  jump: (slot: SlotKey) => void
  rename: (slot: SlotKey, name: string) => void
  reset: (slot: SlotKey) => void
  /**
   * Returns the slot whose saved viewport currently matches the canvas, or
   * null. Computed on demand because React Flow pan/zoom doesn't re-render
   * consumers — call when you actually need the answer (e.g. popover open).
   */
  getActiveSlot: () => SlotKey | null
}

const VIEWPORT_TOLERANCE = 0.5
const ZOOM_TOLERANCE = 0.001

const matchesViewport = (a: Workspace['viewport'], b: Workspace['viewport']): boolean =>
  Math.abs(a.x - b.x) < VIEWPORT_TOLERANCE
  && Math.abs(a.y - b.y) < VIEWPORT_TOLERANCE
  && Math.abs(a.zoom - b.zoom) < ZOOM_TOLERANCE

/**
 * Bridges the workspaces store with the React Flow instance + global keyboard:
 *   bare 1..9   → jump to slot
 *   Alt + 1..9  → save current viewport into slot
 * Reset/rename live in the WorkspacesButton popover, not on the keyboard.
 */
export function useWorkspaces({ arrangementId, reactFlowInstance }: UseWorkspacesArgs): UseWorkspacesReturn {
  const byArrangement = useWorkspacesStore(state => state.byArrangement)
  const saveSlot = useWorkspacesStore(state => state.save)
  const renameSlot = useWorkspacesStore(state => state.rename)
  const resetSlot = useWorkspacesStore(state => state.reset)

  const arrSlots = arrangementId ? byArrangement[arrangementId] ?? {} : {}

  const slots = useMemo(
    () => SLOT_KEYS.map(key => ({ key, workspace: arrSlots[key] ?? null })),
    [arrSlots],
  )

  const save = useCallback((slot: SlotKey) => {
    if (!arrangementId || !reactFlowInstance) return
    const viewport = reactFlowInstance.getViewport()
    saveSlot(arrangementId, slot, viewport)
    Analytics.track('workspace_saved', { arrangementId, slot })
    toast.success(`Workspace ${slot} saved`)
  }, [arrangementId, reactFlowInstance, saveSlot])

  const jump = useCallback((slot: SlotKey) => {
    if (!arrangementId || !reactFlowInstance) return
    const ws = byArrangement[arrangementId]?.[slot]
    if (!ws) {
      toast.info(`Workspace ${slot} is empty — Alt+${slot} to set`)
      return
    }
    reactFlowInstance.setViewport(ws.viewport, { duration: 320 })
  }, [arrangementId, reactFlowInstance, byArrangement])

  const rename = useCallback((slot: SlotKey, name: string) => {
    if (!arrangementId) return
    renameSlot(arrangementId, slot, name)
  }, [arrangementId, renameSlot])

  const reset = useCallback((slot: SlotKey) => {
    if (!arrangementId) return
    resetSlot(arrangementId, slot)
    toast.success(`Workspace ${slot} cleared`)
  }, [arrangementId, resetSlot])

  // Keyboard bindings. Capture phase + input-guard to match the rest of the
  // canvas-level shortcuts in useKeyboardShortcuts.
  //
  // We match by `e.code` (physical key), NOT `e.key`, because on macOS Option
  // mutates `e.key` into a typographic char (Option+1 → "¡") — bare-`e.key`
  // matching against '1'..'9' rejected the save shortcut entirely. `e.code`
  // (`Digit1`/`Numpad1`/…) stays stable across modifiers and keyboard layouts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return

      // Bare digit / Alt+digit only — never claim Ctrl+digit (browser tabs)
      // or Cmd+digit (macOS Safari spaces).
      if (e.metaKey || e.ctrlKey) return

      const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
      if (!m) return

      e.preventDefault()
      e.stopPropagation()

      const slot = m[1] as SlotKey
      if (e.altKey) save(slot)
      else jump(slot)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [save, jump])

  const getActiveSlot = useCallback((): SlotKey | null => {
    if (!reactFlowInstance) return null
    let cur: Workspace['viewport']
    try {
      cur = reactFlowInstance.getViewport()
    } catch {
      return null
    }
    for (const { key, workspace } of slots) {
      if (workspace && matchesViewport(cur, workspace.viewport)) return key
    }
    return null
  }, [reactFlowInstance, slots])

  return { slots, save, jump, rename, reset, getActiveSlot }
}
