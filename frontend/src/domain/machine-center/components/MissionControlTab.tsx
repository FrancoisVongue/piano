'use client'

import { useEffect, useRef, useState } from 'react'
import { useMachineCenterStore } from '../store'
import { Spinner } from '@/components/ui/spinner'
import { ChevronDown, ExternalLink, Plug, Trash2, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import TerminalPanel from '@/domain/terminal/components/TerminalPanel'
import { cn } from '@/lib/utils'
import type { MachineMetrics } from '../services'
import { ActivityBadge } from './ActivityBadge'
import { NodeActionsMenu, NodeActionsQuickBar, useNodeActionCtx } from '@/domain/canvas/lib/node-actions'
import type { CanvasNode } from '@/domain/canvas/types'

const statusDot = (status: string | null) => {
  if (status === 'FROZEN') return 'bg-blue-400'
  if (status === 'RUNNING') return 'bg-green-400 animate-pulse'
  return 'bg-gray-400'
}

const statusLabel = (status: string | null) => {
  if (status === 'FROZEN') return 'Frozen'
  if (status === 'RUNNING') return 'Running'
  return 'Active'
}

// --- formatters ------------------------------------------------------------

const EM_DASH = '—'

const formatBytes = (n: number | undefined | null): string => {
  if (!n || n <= 0) return EM_DASH
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

const formatUptime = (seconds: number | undefined | null): string => {
  if (!seconds || seconds <= 0) return EM_DASH
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${seconds}s`
}

// Frozen rows keep disk size but show em-dash for the live numbers.
const uptimeCell = (metrics: MachineMetrics | null, isFrozen: boolean) =>
  isFrozen ? EM_DASH : formatUptime(metrics?.uptimeSeconds)
const memoryCell = (metrics: MachineMetrics | null, isFrozen: boolean) =>
  isFrozen ? EM_DASH : formatBytes(metrics?.memUsageBytes)
const diskCell = (metrics: MachineMetrics | null) => formatBytes(metrics?.diskUsageBytes)

// --- machine row -----------------------------------------------------------

type MachineRowNote = {
  id: string
  type: string
  machineId: string | null
  status: string | null
  label: string | null
  metrics: MachineMetrics | null
}

/**
 * One machine row. Extracted from MissionControlTab so we can call
 * `useNodeActionCtx` per row — the hook needs to run in a component, and
 * each row has its own machineId/status to feed into the registry.
 *
 * The ctx is built from a synthetic CanvasNode.UI using only the fields
 * the registry actually reads (id/type/status/label/machineId). Actions
 * that inspect other fields (cacheConfig, ancestorOverride, …) apply to
 * kind='note' anyway so they're already filtered out for machines.
 */
function MachineRow({
  note,
  arrangementId,
  isSelected,
  onSelect,
  onDelete,
}: {
  note: MachineRowNote
  arrangementId: string
  isSelected: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const displayLabel = note.label || (note.machineId || '').slice(0, 12) || 'Unnamed'
  const isFrozen = note.status === 'FROZEN'
  const metrics = note.metrics
  const ports = metrics?.listeningPorts ?? []

  // Synthetic node — registry only reads these fields for machine kind.
  // `id` doubles as machineId because for machines the canvas uses the
  // daemon id as nodeId anyway (see createMachine).
  const syntheticNode = {
    id: note.machineId!,
    type: note.type,
    status: note.status,
    label: displayLabel,
    machineId: note.machineId,
    arrangementId,
  } as unknown as CanvasNode.UI

  const ctx = useNodeActionCtx(syntheticNode, {}, { surfaceType: 'mission-control' })

  return (
    <div
      className={cn(
        'flex items-center gap-3 py-1.5 px-2 rounded transition-colors text-sm group/row cursor-pointer',
        isSelected ? 'bg-accent' : 'hover:bg-muted/30'
      )}
      onClick={onSelect}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(note.status)}`} />
      <span className="font-medium truncate min-w-0">{displayLabel}</span>

      <div className="w-40 shrink-0 overflow-hidden">
        {!isFrozen && ports.length > 0 && (
          <div className="flex gap-1 overflow-x-auto whitespace-nowrap pr-1">
            {ports.map((p) => (
              <span
                key={p}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
              >
                :{p}
              </span>
            ))}
          </div>
        )}
      </div>

      <ActivityBadge activity={metrics?.activity} group={metrics?.activityGroup} frozen={isFrozen} />

      <span className="flex-1 min-w-0" />

      {/* Metrics columns — compact, right-aligned, tabular. */}
      <span className="text-xs text-muted-foreground font-mono w-14 text-right shrink-0 tabular-nums" title="Uptime">
        {uptimeCell(metrics, isFrozen)}
      </span>
      <span className="text-xs text-muted-foreground font-mono w-16 text-right shrink-0 tabular-nums" title="Memory">
        {memoryCell(metrics, isFrozen)}
      </span>
      <span className="text-xs text-muted-foreground font-mono w-16 text-right shrink-0 tabular-nums" title="Disk">
        {diskCell(metrics)}
      </span>

      <span className="text-xs text-muted-foreground capitalize shrink-0 w-14 text-right">
        {note.type === 'TERMINAL' ? 'Terminal' : statusLabel(note.status)}
      </span>

      {/* Registry-driven inline actions + full 3-dot menu. Same source
          as canvas — pin a shortcut once and it shows up everywhere
          the node surfaces (card, edit panel, this row). Delete stays
          MC-specific below because it deletes from the arrangement,
          not from the canvas store. */}
      <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-0.5">
        <NodeActionsQuickBar ctx={ctx} />
        <NodeActionsMenu ctx={ctx} />
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="opacity-0 group-hover/row:opacity-100 text-muted-foreground hover:text-destructive p-1 transition-opacity"
        title="Delete machine"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// --- component ------------------------------------------------------------

type Selected = {
  machineId: string
  label: string
  isFrozen: boolean
}

const POLL_MS = 30_000

export function MissionControlTab() {
  const arrangements = useMachineCenterStore(s => s.arrangementsWithMachines)
  const isLoading = useMachineCenterStore(s => s.isLoadingMachines)
  const fetchMachines = useMachineCenterStore(s => s.fetchMachines)
  const deleteAllMachines = useMachineCenterStore(s => s.deleteAllMachinesInArrangement)
  const deleteSingleMachine = useMachineCenterStore(s => s.deleteMachineFromArrangement)
  // Port-forward state is global — Canvas also reads/writes this slice so
  // both UIs stay in lockstep with the daemon's single-active constraint.
  // activateForward is invoked per row by the registry's forward-ports
  // action; we only need the selector + deactivate here for the sticky
  // widget and bulk cleanup paths.
  const activeForward = useMachineCenterStore(s => s.activeForward)
  const deactivateForward = useMachineCenterStore(s => s.deactivateForward)
  const router = useRouter()

  const [selected, setSelected] = useState<Selected | null>(null)
  const [panelHeight, setPanelHeight] = useState(400)
  const isDragging = useRef(false)

  // Initial fetch + 30s polling so uptime/memory/disk stay reasonably fresh.
  useEffect(() => {
    fetchMachines()
    const id = setInterval(fetchMachines, POLL_MS)
    return () => clearInterval(id)
  }, [fetchMachines])

  // Bottom terminal panel resize handler.
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const next = window.innerHeight - e.clientY
      const max = window.innerHeight - 150
      setPanelHeight(Math.max(200, Math.min(max, next)))
    }
    const onMouseUp = () => {
      isDragging.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ns-resize'
  }

  // Thin wrapper — the store owns the toggle logic, toasts, and state.
  // handleForward is no longer needed here: each MachineRow invokes the
  // registry's forward-ports action directly via NodeActionsQuickBar.
  const handleStopForward = () => deactivateForward()

  // Spinner only on the very first load — 30s polling refreshes shouldn't blank the UI.
  if (isLoading && arrangements.length === 0) {
    return <div className="flex justify-center py-12"><Spinner /></div>
  }

  const withMachines = arrangements.filter(a => a.notes.length > 0)

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto px-8 pt-4 pb-4">
        <div className="max-w-5xl mx-auto">

          {/* Active forwarding widget. Sticky so it stays visible while scrolling. */}
          {activeForward && (
            <div className="sticky top-0 z-10 mb-4 border rounded-lg bg-card shadow-sm px-4 py-2 flex items-center gap-3">
              <Plug className="w-4 h-4 text-green-500" />
              <span className="text-sm font-medium">
                {activeForward.ports.length > 0 ? 'Active forwarding:' : 'Watching:'}
              </span>
              <span className="text-sm truncate flex-1">{activeForward.label || activeForward.machineId.slice(0, 12)}</span>
              <div className="flex gap-1">
                {activeForward.ports.length === 0 ? (
                  <span className="text-xs text-muted-foreground italic">waiting for ports…</span>
                ) : activeForward.ports.map(p => (
                  <a
                    key={p}
                    href={`http://localhost:${p}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-mono px-2 py-0.5 rounded bg-green-500/10 text-green-600 hover:bg-green-500/20 transition-colors"
                  >
                    localhost:{p}
                  </a>
                ))}
              </div>
              <button
                onClick={handleStopForward}
                className="text-muted-foreground hover:text-destructive p-1"
                title="Stop forwarding"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

        {withMachines.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No machines running. Create a machine on any canvas to see it here.
          </p>
        ) : (
          <div className="space-y-4">
            {withMachines.map(arrangement => (
              <details key={arrangement.id} open className="group border rounded-lg">
                <summary className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors rounded-lg">
                  <ChevronDown className="w-4 h-4 text-muted-foreground group-open:rotate-0 -rotate-90 transition-transform" />
                  <span className="text-sm font-medium flex-1">{arrangement.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {arrangement.notes.length} machine{arrangement.notes.length !== 1 ? 's' : ''}
                  </span>

                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      if (confirm(`Delete ALL ${arrangement.notes.length} machines in "${arrangement.title}"? This stops running containers and cannot be undone.`)) {
                        deleteAllMachines(arrangement.id)
                        if (selected && arrangement.notes.some(n => n.machineId === selected.machineId)) {
                          setSelected(null)
                        }
                        if (activeForward && arrangement.notes.some(n => n.machineId === activeForward.machineId)) {
                          deactivateForward()
                        }
                      }
                    }}
                    className="text-xs text-muted-foreground hover:text-destructive px-2 py-1 rounded hover:bg-destructive/10 transition-colors"
                    title="Delete all machines in this project"
                  >
                    Delete all
                  </button>

                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      router.push(`/arrangements?id=${arrangement.id}`)
                    }}
                    className="text-muted-foreground hover:text-foreground p-1"
                    title="Go to Canvas"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                </summary>

                <div className="px-4 pb-3 space-y-1">
                  {arrangement.notes.map((note) => {
                    if (!note.machineId) return null
                    const isSelected = selected?.machineId === note.machineId
                    const isForwarded = activeForward?.machineId === note.machineId
                    const displayLabel = note.label || note.machineId.slice(0, 12) || 'Unnamed'
                    const isFrozen = note.status === 'FROZEN'
                    return (
                      <MachineRow
                        key={note.id}
                        note={note}
                        arrangementId={arrangement.id}
                        isSelected={isSelected}
                        onSelect={() => {
                          if (isFrozen) return
                          setSelected({ machineId: note.machineId!, label: displayLabel, isFrozen })
                        }}
                        onDelete={() => {
                          if (confirm(`Delete "${displayLabel}"?`)) {
                            deleteSingleMachine(arrangement.id, note.id)
                            if (isSelected) setSelected(null)
                            // If this row happens to be the one forwarding,
                            // the parent's activeForward subscription sees
                            // it's now gone and we clear the slice to keep
                            // the daemon's single-active state honest.
                            if (isForwarded) deactivateForward()
                          }
                        }}
                      />
                    )
                  })}
                </div>
              </details>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* Bottom terminal panel (resizable, full-width). */}
      {selected && (
        <div
          className="border-t bg-background flex flex-col shrink-0"
          style={{ height: panelHeight }}
        >
          <div
            onMouseDown={startResize}
            className="h-3 cursor-ns-resize bg-muted/50 hover:bg-primary/20 border-y flex items-center justify-center group shrink-0"
            title="Drag to resize"
          >
            <div className="w-10 h-0.5 rounded-full bg-muted-foreground/40 group-hover:bg-muted-foreground/70 transition-colors" />
          </div>

          <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{selected.label}</span>
              <span className="text-xs text-muted-foreground font-mono">
                {selected.machineId.slice(0, 24)}
              </span>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-muted-foreground hover:text-foreground p-1"
              title="Close terminal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 min-h-0">
            <TerminalPanel terminalId={selected.machineId} />
          </div>
        </div>
      )}
    </div>
  )
}
