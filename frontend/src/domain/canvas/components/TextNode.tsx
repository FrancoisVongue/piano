'use client'

import React, { memo, useState, useCallback, useEffect, useRef } from 'react'
import { type NodeProps, NodeToolbar, Position } from '@xyflow/react'
import { Trash2, Type, Bold, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Slider } from '@/components/ui/slider'
import { useCanvasStore } from '../store'
import { Note } from '@piano/shared'
import { fontFamilyToCss } from '../lib/reading-prefs'

/**
 * Standalone text node — not a card, just text on the canvas.
 *
 * Purpose: section headers, visual anchors, annotations. Replaces the old
 * GroupNode with something simpler. Renders at its configured font-size and
 * weight, so even at a zoomed-out view a large heading stays legible.
 *
 * Persistence: stored as a regular Note with `type='TEXT'` and font metadata
 * in the structured `style` JSONB field (TextStyle). See shared/types/note.ts.
 */

const DEFAULT_STYLE: Required<Note.TextStyle> = {
  fontSize: 64,
  fontWeight: 700,
  fontFamily: 'sans',
}

// Font-size range for the inline slider. Continuous — discrete presets felt
// coarse; the slider lets the user dial in exactly what the composition needs.
const FONT_SIZE_MIN = 16
const FONT_SIZE_MAX = 300
const FONT_SIZE_STEP = 2

function readStyle(raw: unknown): Required<Note.TextStyle> {
  const s = (raw ?? {}) as Note.TextStyle
  return {
    fontSize: s.fontSize ?? DEFAULT_STYLE.fontSize,
    fontWeight: s.fontWeight ?? DEFAULT_STYLE.fontWeight,
    fontFamily: s.fontFamily ?? DEFAULT_STYLE.fontFamily,
  }
}

function TextNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as {
    id: string
    content: string
    style?: Note.TextStyle
    arrangementId: string
    scale?: number
  }
  // fontSize = authored typographic size ("is this a heading or body?").
  // scale  = canvas-wide visual zoom shared with every other node type.
  // We multiply at render so the bulk scale slider grows TEXT alongside
  // cards. Doing this via fontSize (not transform) keeps RF's auto-measure
  // honest — the DOM bounding box really IS the visible size, so hit-test
  // and edge anchors line up.
  const nodeScale = nodeData.scale ?? 1

  const [isEditing, setIsEditing] = useState(false)
  // Toolbar visibility — distinct from React Flow's `selected`. Box-selecting
  // many text nodes used to flood the canvas with size sliders; we only want
  // the toolbar on the node the user actually clicked. Click shows it, any
  // deselect (pane click, esc, switching to another node) hides it.
  const [toolbarVisible, setToolbarVisible] = useState(false)
  const [draft, setDraft] = useState(nodeData.content || '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const style = readStyle(nodeData.style)

  useEffect(() => {
    if (isEditing) {
      textareaRef.current?.focus()
      textareaRef.current?.select()
    }
  }, [isEditing])

  useEffect(() => {
    if (!selected) setToolbarVisible(false)
  }, [selected])

  useEffect(() => {
    setDraft(nodeData.content || '')
  }, [nodeData.content])

  const commit = useCallback(() => {
    setIsEditing(false)
    if (draft !== nodeData.content) {
      useCanvasStore.getState().updateNodeContent(nodeData.id, nodeData.arrangementId, draft)
    }
  }, [draft, nodeData.id, nodeData.arrangementId, nodeData.content])

  // Delegates to the shared store action so patch sync picks up the change
  // through the standard dirty-tracking path.
  const setStyle = useCallback((patch: Partial<Note.TextStyle>) => {
    const next: Note.TextStyle = { ...style, ...patch }
    useCanvasStore.getState().updateNodeStyle(nodeData.id, next)
  }, [nodeData.id, style])

  // Slider shows a live px label during drag but does NOT resize the text
  // until the user releases. Why: NodeToolbar anchors to the node's bounding
  // rect — resizing text mid-drag grows the rect and slides the toolbar
  // (and the slider with it) out from under the cursor. Commit-on-release
  // keeps the node stable while dragging; the text snaps once at the end.
  const [draftFontSize, setDraftFontSize] = useState(style.fontSize)

  useEffect(() => {
    setDraftFontSize(style.fontSize)
  }, [style.fontSize])

  const handleSizeDrag = useCallback((values: number[]) => {
    if (typeof values[0] === 'number') setDraftFontSize(values[0])
  }, [])

  const handleSizeCommit = useCallback((values: number[]) => {
    const next = values[0]
    if (typeof next === 'number' && next !== style.fontSize) {
      setStyle({ fontSize: next })
    }
  }, [style.fontSize, setStyle])

  const toggleWeight = useCallback(() => {
    setStyle({ fontWeight: style.fontWeight >= 600 ? 400 : 700 })
  }, [style.fontWeight, setStyle])

  const handleDelete = useCallback(() => {
    useCanvasStore.getState().deleteNode(nodeData.id)
  }, [nodeData.id])

  const resolvedFontFamily = fontFamilyToCss(style.fontFamily)

  return (
    <div
      className={cn(
        'relative inline-block select-none',
        // Hover = move/drag affordance. Edit mode switches to text cursor
        // implicitly because the inner <textarea> carries its own cursor.
        isEditing ? 'cursor-text' : 'cursor-grab active:cursor-grabbing',
        selected && 'outline outline-2 outline-emerald-500 outline-offset-4 rounded-sm',
      )}
      onClick={() => setToolbarVisible(true)}
      onDoubleClick={() => setIsEditing(true)}
    >
      <NodeToolbar isVisible={toolbarVisible} position={Position.Top}>
        {/* `nodrag nopan` stops React Flow from hijacking pointer gestures
            inside the toolbar — without this the slider drag would also
            drag the whole node across the canvas. */}
        <div className="nodrag nopan flex items-center gap-2 px-2 py-1.5 rounded-md bg-white shadow-lg border border-gray-200">
          <div className="flex items-center gap-2 pr-1" title="Font size">
            <Type className="w-3.5 h-3.5 text-gray-500" />
            <Slider
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={FONT_SIZE_STEP}
              value={[draftFontSize]}
              onValueChange={handleSizeDrag}
              onValueCommit={handleSizeCommit}
              className="w-28"
            />
            <span className="text-[11px] tabular-nums text-gray-600 w-7 text-right">
              {draftFontSize}
            </span>
          </div>
          <div className="h-5 w-px bg-gray-200" />
          <button
            type="button"
            onClick={toggleWeight}
            className={cn(
              'h-7 w-7 flex items-center justify-center rounded hover:bg-gray-100',
              style.fontWeight >= 600 && 'bg-blue-50 text-blue-700',
            )}
            title="Toggle bold"
          >
            <Bold className="w-3.5 h-3.5" />
          </button>
          <div className="h-5 w-px bg-gray-200" />
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-gray-100"
            title="Edit text"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-red-50 text-red-600"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </NodeToolbar>

      {(() => {
        // Live preview via CSS transform: the text scales visually while the
        // layout box stays at the committed fontSize. Toolbar is anchored to
        // layout size (not transform), so the slider beneath your finger
        // doesn't move. On release, style.fontSize commits and the scale
        // snaps to 1 — single clean transition, no jitter during drag.
        const previewScale = style.fontSize > 0 ? draftFontSize / style.fontSize : 1
        const isPreviewing = Math.abs(previewScale - 1) > 0.001
        const previewTransform = isPreviewing ? {
          transform: `scale(${previewScale})`,
          transformOrigin: 'top left' as const,
        } : {}

        return isEditing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDraft(nodeData.content || '')
                setIsEditing(false)
              }
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                commit()
              }
            }}
            wrap="off"
            cols={Math.max(10, ...draft.split('\n').map(l => l.length)) + 2}
            rows={Math.max(1, draft.split('\n').length)}
            className="bg-transparent outline-none resize-none text-gray-900"
            style={{
              fontSize: `${style.fontSize * nodeScale}px`,
              fontWeight: style.fontWeight,
              fontFamily: resolvedFontFamily,
              lineHeight: 1.15,
              ...previewTransform,
            }}
            autoFocus
          />
        ) : (
          <div
            className="text-gray-900 whitespace-pre leading-[1.15]"
            style={{
              fontSize: `${style.fontSize * nodeScale}px`,
              fontWeight: style.fontWeight,
              fontFamily: resolvedFontFamily,
              ...previewTransform,
            }}
          >
            {nodeData.content || (
              <span className="text-gray-300 italic">Double-click to edit</span>
            )}
          </div>
        )
      })()}
    </div>
  )
}

const areTextNodePropsEqual = (prev: NodeProps, next: NodeProps) =>
  prev.selected === next.selected &&
  prev.dragging === next.dragging &&
  prev.data === next.data

export const TextNode = memo(TextNodeComponent, areTextNodePropsEqual)
