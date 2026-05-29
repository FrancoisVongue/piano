'use client'

import React, { memo, useMemo, useState } from 'react'
import { type NodeProps } from '@xyflow/react'
import { Terminal as TerminalIcon, MoreVertical, Move } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useReactiveNode } from '../store-valtio'
import { CanvasNode } from '../types'
import { CanvasDragPayload } from '../drag/payloads'
import { NodeActionsMenu, useNodeActionCtx } from '../lib/node-actions'
import { NodeShell } from './NodeShell'

// Status-driven visual state — derived from the parent machine's status.
// Adding a new infra status? One row here.
const STATUS_STYLES = {
  running: { icon: 'text-emerald-100', lowIcon: 'text-emerald-700', dot: 'bg-emerald-300' },
  frozen:  { icon: 'text-sky-100',     lowIcon: 'text-sky-700',     dot: 'bg-sky-300'     },
  idle:    { icon: 'text-stone-300',   lowIcon: 'text-stone-600',   dot: 'bg-stone-400'   },
} as const
type StatusKey = keyof typeof STATUS_STYLES

const TerminalNodeComponent = ({ data, selected }: NodeProps) => {
  const noteData = data as CanvasNode.TerminalData
  const content = noteData.content || ''
  // Per-id Valtio subscription on the parent: re-runs only when that
  // specific node's tracked fields change, not on drag ticks of other nodes.
  const parentNode = useReactiveNode(noteData.parentMachineNodeId)
  const machineName = parentNode?.data.label || 'Machine'
  const machineStatus = parentNode?.data.status

  const [copiedContent, setCopiedContent] = useState(false)

  const statusKey: StatusKey = machineStatus === 'RUNNING' ? 'running' : machineStatus === 'FROZEN' ? 'frozen' : 'idle'
  const st = STATUS_STYLES[statusKey]

  const outputLines = useMemo(() => content.split('\n').filter(Boolean).slice(-6), [content])

  const nodeActionCtx = useNodeActionCtx(
    noteData,
    { onCopiedContent: () => { setCopiedContent(true); window.setTimeout(() => setCopiedContent(false), 2000) } },
    { copiedContent },
  )

  return (
    <NodeShell
      nodeData={noteData}
      selected={selected}
      rounded="rounded-none"
      lowDetailIcon={<TerminalIcon className={cn('h-10 w-10', st.lowIcon)} />}
    >
      <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#24342d]">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(202,255,222,0.14),transparent_38%),repeating-linear-gradient(0deg,transparent_0px,transparent_2px,rgba(220,252,231,0.055)_2px,rgba(220,252,231,0.055)_3px)]"
          aria-hidden="true"
        />

        <div className="relative flex items-center gap-2 bg-[#1e2c26]/86 backdrop-blur-[2px] px-3 py-2 border-b border-emerald-100/10 flex-shrink-0">
          <div className={cn('w-2 h-2 rounded-full flex-shrink-0', st.dot)} />
          <TerminalIcon className={cn('w-3.5 h-3.5 flex-shrink-0', st.icon)} />
          <span className="flex-1 flex items-center gap-1.5 min-w-0 font-mono text-[10px] uppercase tracking-[0.12em] text-emerald-100/65">
            <span className="flex-shrink-0 text-emerald-50">Terminal</span>
            <span className="text-emerald-100/25">·</span>
            <span className="truncate text-emerald-100/55 normal-case tracking-normal">on {machineName}</span>
          </span>
          <button
            type="button"
            draggable
            onDragStart={(e) =>
              CanvasDragPayload.serialize(e.dataTransfer, {
                kind: 'canvas-terminal',
                sourceNoteId: noteData.id,
                paneId: noteData.machineId || noteData.id,
                parentMachineNodeId: noteData.parentMachineNodeId ?? null,
              })
            }
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="flex h-5 w-5 cursor-grab items-center justify-center text-emerald-100/55 hover:text-emerald-50 flex-shrink-0 active:cursor-grabbing"
            title="Drag into a machine window to embed as a pane"
          >
            <Move className="h-3.5 w-3.5" />
          </button>
          <NodeActionsMenu
            ctx={nodeActionCtx}
            trigger={
              <button
                type="button"
                aria-label="Node actions"
                className="h-5 w-5 flex items-center justify-center text-emerald-100/55 hover:text-emerald-50 flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            }
          />
        </div>

        <div className="relative flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 flex flex-col p-2 overflow-hidden">
            {outputLines.length > 0 ? (
              <div className="flex-1 overflow-hidden flex flex-col justify-end px-1">
                {outputLines.map((line, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px] font-mono truncate leading-snug">
                    <span className="text-emerald-100/70 flex-shrink-0">$</span>
                    <span className="text-emerald-50 truncate">{line}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="font-mono font-black flex items-center gap-2 text-3xl tracking-tighter">
                  <span className="text-emerald-100 drop-shadow-[0_0_6px_rgba(187,247,208,0.38)]">$</span>
                  <span className="h-6 w-2 bg-emerald-100" />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </NodeShell>
  )
}

const areTerminalNodePropsEqual = (prev: NodeProps, next: NodeProps) =>
  prev.selected === next.selected &&
  prev.dragging === next.dragging &&
  prev.data === next.data

export const TerminalNode = memo(TerminalNodeComponent, areTerminalNodePropsEqual)
