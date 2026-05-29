'use client'

/**
 * Renders the global node-action dialogs (label/color/tags/ancestors)
 * in a portal anchored to the button that triggered them. Mounted once
 * from Canvas. Single source of UI for these pickers — no surface-local
 * duplicates.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCanvasStore } from '../store'
import { useReactiveNode } from '../store-valtio'
import { useNodeDialogsStore, type DialogAnchor } from '../lib/node-dialogs-store'
import { TagsEditor } from '@/components/TagsEditor'
import { Z } from '../lib/z-layers'
import { cn } from '@/lib/utils'
import { NodeCachePanel } from './NodeCachePanel'
import { NodeInfoDialog } from './NodeInfoDialog'
import { WorkflowRunnerPopover } from './WorkflowRunnerPopover'
import type { LLM } from '@piano/shared'
import { GitBranch } from 'lucide-react'

// Keep in lock-step with NoteCard.USER_COLORS / ASSISTANT_COLORS.
// Purple is forbidden per DESIGN.md (intro — purple gradients are the
// canonical example of visual garbage; §1.1 — one accent colour only).
const USER_COLORS = [
  { name: 'Light Blue', bg: 'bg-blue-50', border: 'border-blue-200' },
  { name: 'Light Green', bg: 'bg-green-50', border: 'border-green-200' },
  { name: 'Light Pink', bg: 'bg-pink-50', border: 'border-pink-200' },
  { name: 'Light Yellow', bg: 'bg-yellow-50', border: 'border-yellow-200' },
]
const ASSISTANT_COLORS = [
  { name: 'AI Citrine', bg: 'bg-amber-50', border: 'border-amber-300' },
  { name: 'AI Mint', bg: 'bg-emerald-50', border: 'border-emerald-300' },
  { name: 'AI Sky', bg: 'bg-sky-50', border: 'border-sky-300' },
  { name: 'AI Rose', bg: 'bg-rose-50', border: 'border-rose-300' },
]

/** Given an anchor and desired popover size, pick a position that keeps
 * the popover within the viewport. Below-right of the trigger by default. */
function positionFor(anchor: DialogAnchor, width: number, height: number) {
  const margin = 8
  let top = anchor.bottom + 6
  let left = anchor.right - width
  if (left < margin) left = margin
  if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin
  if (top + height > window.innerHeight - margin) top = anchor.top - height - 6
  if (top < margin) top = margin
  return { top, left }
}

export function NodeDialogsHost() {
  const kind = useNodeDialogsStore((s) => s.kind)
  const nodeId = useNodeDialogsStore((s) => s.nodeId)
  const anchor = useNodeDialogsStore((s) => s.anchor)
  const close = useNodeDialogsStore((s) => s.close)

  // Per-id Valtio subscription — re-renders only when this specific node's
  // tracked fields change, not on drag ticks of other nodes.
  const node = useReactiveNode(nodeId)?.data ?? null
  const updateNodeLabel = useCanvasStore((s) => s.updateNodeLabel)
  const updateNodeColor = useCanvasStore((s) => s.updateNodeColor)
  const updateNodeTags = useCanvasStore((s) => s.updateNodeTags)
  const branchMachine = useCanvasStore((s) => s.branchMachine)
  const selectedModel = useCanvasStore((s) => s.selectedModel) as LLM.ModelId

  const panelRef = useRef<HTMLDivElement>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [branchDraft, setBranchDraft] = useState('')
  const currentNodeLabel = node?.label || ''

  // Seed from the label value, not the whole node. Machine nodes receive
  // content/status/layout updates while this popover is open, and those should
  // not clobber the user's in-progress rename draft.
  useEffect(() => {
    if (kind === 'label') setLabelDraft(currentNodeLabel)
  }, [kind, nodeId, currentNodeLabel])

  useEffect(() => {
    if (kind === 'branch') setBranchDraft('')
  }, [kind])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!kind) return
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [kind, close])

  const palette = useMemo(() => {
    if (!node) return USER_COLORS
    return node.type === 'ASSISTANT' ? ASSISTANT_COLORS : USER_COLORS
  }, [node])

  // 'info' is a shadcn Dialog (self-positioning modal). It doesn't need
  // an anchor; render it independently so its overlay covers the canvas.
  if (kind === 'info' && nodeId) {
    return (
      <NodeInfoDialog
        noteId={nodeId}
        open={true}
        onOpenChange={(v) => { if (!v) close() }}
      />
    )
  }

  if (!kind || !nodeId || !anchor || !node) return null

  // Each dialog declares its natural size so the positioner can flip it
  // above or clamp it inside the viewport. Values are approximate — big
  // enough to avoid measurement, small enough to stay usable.
  const size =
    kind === 'label'    ? { w: 280, h: 96 } :
    kind === 'color'    ? { w: 180, h: 220 } :
    kind === 'tags'     ? { w: 300, h: 220 } :
    kind === 'cache'    ? { w: 288, h: 260 } :
    kind === 'branch'   ? { w: 300, h: 120 } :
    kind === 'workflow' ? { w: 280, h: 280 } :
                          { w: 260, h: 100 }
  const { top, left } = positionFor(anchor, size.w, size.h)

  const commitLabel = () => {
    updateNodeLabel(nodeId, labelDraft.trim() || null)
    close()
  }

  const commitBranch = () => {
    const name = branchDraft.trim() || undefined
    close()
    void branchMachine(nodeId, name)
  }

  // 'cache' bypasses the generic wrapper because NodeCachePanel brings its
  // own border, padding, and dark/light theming (assistant nodes need the
  // dark palette). We give it a fixed positioner, it handles the rest.
  if (kind === 'cache') {
    return createPortal(
      <div
        ref={panelRef}
        style={{ position: 'fixed', top, left, width: size.w, zIndex: Z.nodeTooltip }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <NodeCachePanel
          noteId={nodeId}
          currentModelId={selectedModel}
          cacheConfig={node.cacheConfig}
          isAssistantNode={node.type === 'ASSISTANT'}
          onClose={close}
          className="block w-full"
          manageOutsideClick={false}
        />
      </div>,
      document.body,
    )
  }

  const content = (
    <div
      ref={panelRef}
      role="dialog"
      className={cn(
        'fixed rounded-lg border border-gray-200 bg-white shadow-xl p-3',
      )}
      style={{ top, left, width: size.w, zIndex: Z.nodeTooltip }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {kind === 'label' && (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold text-gray-700">Edit label</div>
          <input
            autoFocus
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLabel()
              if (e.key === 'Escape') close()
            }}
            placeholder="Node label"
            className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm outline-none focus:border-blue-500"
          />
          <div className="flex justify-end gap-2">
            <button className="text-xs text-gray-500 hover:text-gray-700" onClick={close}>Cancel</button>
            <button className="text-xs font-medium text-blue-600 hover:text-blue-700" onClick={commitLabel}>Save</button>
          </div>
        </div>
      )}

      {kind === 'color' && (
        <div className="flex flex-col gap-1">
          <div className="text-xs font-semibold text-gray-700 mb-1">Change color</div>
          <button
            className="p-2 text-xs text-left rounded text-gray-700 hover:bg-gray-100"
            onClick={() => { updateNodeColor(nodeId, null); close() }}
          >
            Default
          </button>
          {palette.map((c) => (
            <button
              key={c.name}
              className={cn('p-2 text-xs text-left rounded text-gray-900 hover:bg-opacity-80', c.bg)}
              onClick={() => { updateNodeColor(nodeId, `${c.bg}|${c.border}`); close() }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {kind === 'tags' && (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold text-gray-700">Manage tags</div>
          <TagsEditor
            value={node.tags || []}
            onChange={(tags) => updateNodeTags(nodeId, tags)}
            variant="inline"
            autoFocus
          />
        </div>
      )}

      {kind === 'ancestors' && (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold text-gray-700">Context Path</div>
          {(node.ancestorOverride?.length || 0) > 0 ? (
            <div className="text-xs text-gray-500">
              Custom path with {node.ancestorOverride!.length} ancestor
              {node.ancestorOverride!.length !== 1 ? 's' : ''}
            </div>
          ) : (
            <div className="text-xs text-gray-500">Using default path from edges</div>
          )}
        </div>
      )}

      {kind === 'workflow' && (
        <WorkflowRunnerPopover nodeId={nodeId} onClose={close} />
      )}

      {kind === 'branch' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <GitBranch className="h-3.5 w-3.5 text-gray-500" />
            <span className="text-xs font-semibold text-gray-700">Branch machine</span>
          </div>
          <input
            autoFocus
            value={branchDraft}
            onChange={(e) => setBranchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitBranch()
              if (e.key === 'Escape') close()
            }}
            placeholder="Branch name (optional)"
            className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm outline-none focus:border-blue-500"
          />
          <div className="flex justify-end gap-2">
            <button className="text-xs text-gray-500 hover:text-gray-700" onClick={close}>Cancel</button>
            <button className="text-xs font-medium text-blue-600 hover:text-blue-700" onClick={commitBranch}>Branch</button>
          </div>
        </div>
      )}

    </div>
  )

  return createPortal(content, document.body)
}
