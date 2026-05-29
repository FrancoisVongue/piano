import { useEffect } from 'react'
import { useCanvasStore } from '../store'
import { isTypingTarget } from '@/lib/keyboard'

interface KeyboardShortcutsOptions {
  save?: () => Promise<any>
  onPasteAtCursor?: () => void
  onNewNote?: () => void
  onNewText?: () => void
  onNewMachine?: () => void
}

export function useKeyboardShortcuts({
  save,
  onPasteAtCursor,
  onNewNote,
  onNewText,
  onNewMachine,
}: KeyboardShortcutsOptions = {}) {
  // Selective subscriptions — Zustand methods are stable refs so each
  // selector returns the same value across renders; equality bails the
  // re-render. `useCanvasStore()` with no selector returns the WHOLE state
  // object, which is a new ref after every set() (immer produce) — that
  // re-renders the host (Canvas) 60Hz during drag.
  const createNode = useCanvasStore((s) => s.createNode)
  const createTextNode = useCanvasStore((s) => s.createTextNode)
  const hasUnsavedChanges = useCanvasStore((s) => s.hasUnsavedChanges)
  const undo = useCanvasStore((s) => s.undo)
  const redo = useCanvasStore((s) => s.redo)
  const canUndo = useCanvasStore((s) => s.canUndo)
  const canRedo = useCanvasStore((s) => s.canRedo)
  const copySelectedNodes = useCanvasStore((s) => s.copySelectedNodes)
  const cutSelectedNodes = useCanvasStore((s) => s.cutSelectedNodes)
  const pasteNodes = useCanvasStore((s) => s.pasteNodes)
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return

      const isMod = e.metaKey || e.ctrlKey

      // Undo: Cmd/Ctrl + Z
      if (isMod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        if (canUndo()) {
          undo()
        }
        return // Ensure no other handler processes this
      }

      // Redo: Cmd/Ctrl + Shift + Z
      if (isMod && e.shiftKey && e.key === 'z') {
        e.preventDefault()
        e.stopPropagation()
        if (canRedo()) {
          redo()
        }
        return
      }

      // Save: Cmd/Ctrl + S
      if (isMod && e.key === 's') {
        e.preventDefault()
        e.stopPropagation()
        if (save && hasUnsavedChanges) {
          save()
        }
        return
      }

      // Copy nodes (structured, for paste): Cmd/Ctrl + C
      if (isMod && e.key === 'c') {
        e.preventDefault()
        e.stopPropagation()
        copySelectedNodes()
        return
      }

      // Cut: Cmd/Ctrl + X
      if (isMod && e.key === 'x') {
        e.preventDefault()
        e.stopPropagation()
        cutSelectedNodes()
        return
      }

      // Paste: Cmd/Ctrl + V
      if (isMod && e.key === 'v') {
        e.preventDefault()
        e.stopPropagation()
        if (onPasteAtCursor) onPasteAtCursor()
        else pasteNodes()
        return
      }

      // Create new node: N
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        e.stopPropagation()
        if (onNewNote) onNewNote()
        else createNode(null)
        return
      }

      // New text: T
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        e.stopPropagation()
        if (onNewText) onNewText()
        else createTextNode(null)
        return
      }

      // New machine: M
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        e.stopPropagation()
        onNewMachine?.()
        return
      }
    }

    // Use capture phase to intercept events before other handlers
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [undo, redo, createNode, createTextNode, hasUnsavedChanges, save, canUndo, canRedo, copySelectedNodes, cutSelectedNodes, pasteNodes, onPasteAtCursor, onNewNote, onNewText, onNewMachine])
}
