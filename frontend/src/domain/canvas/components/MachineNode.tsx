'use client'

import React, { memo, useEffect, useMemo, useState } from 'react'
import { type NodeProps } from '@xyflow/react'
import { Server, MoreVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '../store'
import { useReactiveNode } from '../store-valtio'
import { useMachineCenterStore, selectMachineMetrics } from '@/domain/machine-center/store'
import { ActivityBanner } from '@/domain/machine-center/components/ActivityBadge'
import { CanvasNode } from '../types'
import { NodeActionsMenu, NodeActionsQuickBar, useNodeActionCtx } from '../lib/node-actions'
import { NodeShell } from './NodeShell'
import { useShallow } from 'zustand/react/shallow'

// All visual state for running/frozen/idle in one place.
// Adding a new machine status? One row here, nothing else to touch.
const STATUS_STYLES = {
  running: { label: 'Running', icon: 'text-emerald-700', dot: 'bg-emerald-500' },
  frozen:  { label: 'Frozen',  icon: 'text-sky-700',     dot: 'bg-sky-500'     },
  idle:    { label: 'Idle',    icon: 'text-stone-500',   dot: 'bg-stone-400'   },
} as const
type StatusKey = keyof typeof STATUS_STYLES
const EMPTY_PORTS: number[] = []

function useBranchingMs(nodeId: string): number | null {
  const startedAt = useCanvasStore(state => state.branchingNodes.get(nodeId) ?? null)
  const [elapsed, setElapsed] = useState<number | null>(null)

  useEffect(() => {
    if (!startedAt) {
      setElapsed(null)
      return
    }
    setElapsed(0)
    const id = window.setInterval(() => setElapsed(Date.now() - startedAt), 250)
    return () => window.clearInterval(id)
  }, [startedAt])

  return elapsed
}

const MachineNodeComponent = ({ data, selected }: NodeProps) => {
  const noteData = data as CanvasNode.MachineData
  const fallbackLabel = noteData.label || 'Machine'
  const content = noteData.content || ''
  const branchingMs = useBranchingMs(noteData.id)
  const isBranching = branchingMs !== null

  const [isFreezeNaming, setIsFreezeNaming] = useState(false)
  const [freezeName, setFreezeName] = useState(fallbackLabel)
  const [copiedContent, setCopiedContent] = useState(false)

  const updateNodeLabel = useCanvasStore(state => state.updateNodeLabel)
  const freezeMachine = useCanvasStore(state => state.freezeMachine)

  const status = noteData.status as string | undefined
  const statusKey: StatusKey = status === 'RUNNING' ? 'running' : status === 'FROZEN' ? 'frozen' : 'idle'
  const st = STATUS_STYLES[statusKey]

  const machineId = noteData.machineId || noteData.id
  const activePorts = useMachineCenterStore(
    useShallow(s => {
      const activeForward = s.activeForward
      return activeForward?.machineId === machineId ? activeForward.ports : EMPTY_PORTS
    }),
  )

  // Rolled-up activity for this container (primary PTY + shared panes), fed by
  // useMachineActivityFeed on the canvas page. Header badge = loudest terminal.
  const machineMetrics = useMachineCenterStore(selectMachineMetrics(machineId))

  // Per-id Valtio subscription on the parent: re-runs only when that
  // specific node's tracked fields change.
  const parentNode = useReactiveNode(noteData.parentMachineNodeId)
  const parentLabel = noteData.parentMachineNodeId
    ? (parentNode?.data.label || 'Machine')
    : null

  const outputLines = useMemo(() => content.split('\n').filter(Boolean).slice(-6), [content])

  const nodeActionCtx = useNodeActionCtx(
    noteData,
    {
      onStartFreezeNaming: () => { setIsFreezeNaming(true); setFreezeName(fallbackLabel) },
      onCopiedContent: () => { setCopiedContent(true); window.setTimeout(() => setCopiedContent(false), 2000) },
    },
    { copiedContent },
  )

  return (
    <NodeShell
      nodeData={noteData}
      selected={selected}
      rounded="rounded-sm"
      lowDetailIcon={<Server className={cn('h-10 w-10', st.icon)} />}
    >
      <div className="absolute inset-0 flex flex-col overflow-hidden rounded-[1px] bg-[#e8ecea]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.82),transparent_46%),linear-gradient(180deg,rgba(255,255,255,0.46),rgba(207,216,212,0.28))]" aria-hidden="true" />

        <div className="relative flex items-center gap-2 bg-[#f7f6f1]/85 backdrop-blur-[2px] px-3 py-2 border-b border-stone-300/80 flex-shrink-0">
          <div className={cn('w-2 h-2 rounded-full flex-shrink-0', st.dot)} />
          <Server className={cn('w-3.5 h-3.5 flex-shrink-0', st.icon)} />
          <span className="flex-1 flex items-center gap-1.5 min-w-0 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-500">
            <span className="flex-shrink-0 text-stone-800">{st.label}</span>
            <span className="text-stone-300">·</span>
            <span className="truncate text-stone-500">{String(machineId).slice(0, 8)}</span>
          </span>
          {/* QuickBar + Menu as two siblings on ONE flex row (no flex-wrap
              at this level — wrapping is QuickBar's own job). Menu is
              pinned top-right, QuickBar's wrapped rows extend downward
              from its own left side. `self-start` keeps the whole block
              anchored at the top of the header. 60% = of the card width. */}
          <div className="flex items-start min-w-0 max-w-[60%] justify-end self-start gap-1">
          <NodeActionsQuickBar ctx={nodeActionCtx} />
          <NodeActionsMenu
            ctx={nodeActionCtx}
            trigger={
              <button
                type="button"
                aria-label="Node actions"
                className="h-5 w-5 flex items-center justify-center text-stone-500 hover:text-stone-900 flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            }
          />
          </div>
        </div>

        <div className="relative flex-1 flex flex-col overflow-hidden">
          {isBranching ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500/40" />
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-stone-500">Branching</span>
              <span className="font-mono text-xs tabular-nums text-stone-800">
                {branchingMs < 1000 ? `${branchingMs}ms` : `${(branchingMs / 1000).toFixed(1)}s`}
              </span>
            </div>
          ) : isFreezeNaming ? (
            <div className="flex flex-col gap-1.5 p-3">
              <span className="text-[10px] uppercase tracking-wider text-stone-700 font-medium">Name package</span>
              <input
                autoFocus
                value={freezeName}
                onChange={(e) => setFreezeName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    const name = freezeName.trim() || fallbackLabel
                    updateNodeLabel(noteData.id, name)
                    // Pass the name explicitly — sync is debounced and
                    // the backend would otherwise read a stale label.
                    freezeMachine(noteData.id, name)
                    setIsFreezeNaming(false)
                  }
                  if (e.key === 'Escape') setIsFreezeNaming(false)
                }}
                onBlur={() => setIsFreezeNaming(false)}
                className="text-xs bg-white/80 text-stone-900 border border-stone-300 rounded px-2 py-1 outline-none focus:border-emerald-500"
                placeholder="e.g. Base with Node + Git"
              />
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden gap-1 p-2">
              {parentLabel && (
                <span className="px-1 text-[10px] text-stone-500 truncate flex-shrink-0">↑ {parentLabel}</span>
              )}

              {outputLines.length > 0 ? (
                <div className="flex-1 overflow-hidden flex flex-col justify-end px-1">
                  {outputLines.map((line, i) => (
                    <div key={i} className="truncate font-mono text-[10px] leading-snug text-stone-700">{line}</div>
                  ))}
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  {statusKey === 'frozen' ? (
                    <span className="text-[10px] uppercase tracking-wider text-sky-700">snapshot saved</span>
                  ) : (
                    // Empty close-up of a machine (Task 14): show the kind
                    // ("machine" = Server icon) BIG and status-tinted.
                    // Replaces the old "$|" terminal-cursor that confused
                    // users into thinking the node was a terminal.
                    <Server
                      className={cn(
                        'h-16 w-16',
                        STATUS_STYLES[statusKey].icon,
                      )}
                    />
                  )}
                </div>
              )}

              {activePorts.length > 0 && (
                <div className="flex flex-wrap gap-1 flex-shrink-0 border-t border-stone-300/70 pt-1">
                  {activePorts.map((port: number) => (
                    <span key={port} className="rounded border border-emerald-600/25 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-800">
                      :{port}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Activity, centered over the body where the terminal text is —
              the loudest terminal of this container. Calm (idle/done) renders
              nothing so the output preview stays visible. */}
          {!isBranching && !isFreezeNaming && statusKey !== 'frozen' && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-2">
              <ActivityBanner activity={machineMetrics?.activity} group={machineMetrics?.activityGroup} />
            </div>
          )}
        </div>
      </div>
    </NodeShell>
  )
}

const areMachineNodePropsEqual = (prev: NodeProps, next: NodeProps) =>
  prev.selected === next.selected &&
  prev.dragging === next.dragging &&
  prev.data === next.data

export const MachineNode = memo(MachineNodeComponent, areMachineNodePropsEqual)
