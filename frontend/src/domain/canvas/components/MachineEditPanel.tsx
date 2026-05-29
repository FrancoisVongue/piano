'use client'

import React, { memo, useState, useCallback, useEffect } from 'react'
import { X, Snowflake, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCanvasStore } from '../store'
import { useSelectedReactiveNode } from '../store-valtio'
import { cn } from '@/lib/utils'
import TerminalPanel from '@/domain/terminal/components/TerminalPanel'
import { MachineBody } from './MachineWindow/MachineBody'
import { NodeActionsMenu, NodeActionsQuickBar, useNodeActionCtx } from '../lib/node-actions'
import { buildNodeContext } from '../lib/buildNodeContext'
import { CanvasNode } from '../types'

interface MachineEditPanelProps {
  nodeId?: string | null
  embedded?: boolean
  onClose?: () => void
}

const MachineEditPanelComponent = ({ nodeId: nodeIdOverride, embedded = false, onClose }: MachineEditPanelProps) => {
  const clearSelectedNode = useCanvasStore(state => state.clearSelectedNode)
  const branchMachine = useCanvasStore(state => state.branchMachine)
  const setNodeStatus = useCanvasStore(state => state.setNodeStatus)

  // Per-id Valtio subscription — re-renders only when this node's tracked
  // fields change, not on drag ticks of other nodes.
  const selectedNode = useSelectedReactiveNode(nodeIdOverride) ?? null

  const DEFAULT_WIDTH = 600
  const [panelWidth, setPanelWidth] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('piano-machine-panel-width')
      return saved ? parseInt(saved, 10) : DEFAULT_WIDTH
    }
    return DEFAULT_WIDTH
  })
  const [isResizing, setIsResizing] = useState(false)
  const [copiedContent, setCopiedContent] = useState(false)
  const [showBranchNameInput, setShowBranchNameInput] = useState(false)
  const [branchName, setBranchName] = useState('')
  // Inline label edit is gone — rename goes through NodeDialogsHost.

  // Unified node actions — same registry drives the card 3-dot menu and
  // this panel's header dropdown (see ../lib/node-actions.tsx). Label
  // editing now opens via the global <NodeDialogsHost>; no surface
  // callback is needed for it anymore.
  const nodeActionCtx = useNodeActionCtx(
    selectedNode?.data as CanvasNode.UI | undefined,
    {
      onCopiedContent: () => {
        setCopiedContent(true)
        window.setTimeout(() => setCopiedContent(false), 2000)
      },
    },
    { copiedContent },
  )

  const closePanel = useCallback(() => {
    if (onClose) {
      onClose()
      return
    }
    clearSelectedNode()
  }, [clearSelectedNode, onClose])

  useEffect(() => {
    localStorage.setItem('piano-machine-panel-width', panelWidth.toString())
  }, [panelWidth])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!isResizing) return
    const minWidth = 380
    const maxWidth = Math.min(1200, window.innerWidth * 0.8)
    const newWidth = Math.max(minWidth, Math.min(maxWidth, window.innerWidth - e.clientX))
    setPanelWidth(newWidth)
  }, [isResizing])

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false)
  }, [])

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleResizeMove)
      document.addEventListener('mouseup', handleResizeEnd)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    } else {
      document.removeEventListener('mousemove', handleResizeMove)
      document.removeEventListener('mouseup', handleResizeEnd)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    return () => {
      document.removeEventListener('mousemove', handleResizeMove)
      document.removeEventListener('mouseup', handleResizeEnd)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [handleResizeEnd, handleResizeMove, isResizing])

  if (!selectedNode) return null

  const nodeData = selectedNode.data as CanvasNode.UI
  if (!CanvasNode.isInfra(nodeData)) return null

  const isMachine = CanvasNode.isMachine(nodeData)
  const isTerminal = CanvasNode.isTerminal(nodeData)
  const machineId = nodeData.machineId || selectedNode.id
  const label = nodeData.label || (isMachine ? 'Machine' : 'Terminal')
  const isFrozen = nodeData.status === 'FROZEN'
  const isRunning = nodeData.status === 'RUNNING'
  const isProvisioning = nodeData.status === 'PROVISIONING'
  const nodeId = selectedNode.id

  const { nodes, edges } = useCanvasStore.getState()
  const contextContent = buildNodeContext(nodeId, nodes, edges)

  const lineage: string[] = [label]
  let currentParentId: string | null | undefined = nodeData.parentMachineNodeId
  while (currentParentId) {
    const ancestor = nodes.find(n => n.id === currentParentId)
    if (!ancestor) break
    const ancestorData = ancestor.data as CanvasNode.UI
    lineage.unshift(ancestorData.label || 'Machine')
    currentParentId = CanvasNode.isInfra(ancestorData) ? ancestorData.parentMachineNodeId : null
  }

  const parentData = nodeData.parentMachineNodeId
    ? (nodes.find(n => n.id === nodeData.parentMachineNodeId)?.data as CanvasNode.UI | undefined)
    : undefined
  const parentLabel = parentData ? (parentData.label || 'Machine') : undefined
  const parentMachineName = isTerminal && parentData ? (parentData.label || 'Machine') : undefined

  // Label save/cancel handlers are gone — NodeDialogsHost owns this UI.

  const statusDotColor = isFrozen
    ? 'bg-blue-500'
    : isRunning
    ? 'bg-emerald-500'
    : 'bg-gray-400'

  const statusText = isFrozen ? 'frozen' : isRunning ? 'running' : 'idle'

  return (
    <div
      className={cn(
        'bg-white flex flex-col h-full relative overflow-hidden',
        embedded ? 'w-full rounded-[inherit] border-0' : 'border-l border-gray-200',
      )}
      style={embedded ? undefined : { width: `${panelWidth}px` }}
    >
      {!embedded ? (
        <div
          className={cn(
            'absolute left-0 top-0 bottom-0 z-10 w-2 cursor-col-resize group transition-colors',
            'hover:bg-gray-200 border-r border-transparent hover:border-gray-300',
            isResizing && 'bg-blue-200 border-blue-400',
          )}
          onMouseDown={handleResizeStart}
          title="Drag to resize panel"
        >
          <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col gap-1">
            {[0, 1, 2].map(index => (
              <div
                key={index}
                className={cn(
                  'h-0.5 w-0.5 rounded-full bg-gray-400 transition-colors',
                  'group-hover:bg-gray-600',
                  isResizing && 'bg-blue-600',
                )}
              />
            ))}
          </div>
        </div>
      ) : null}

      {isResizing ? (
        <div className="fixed inset-0 z-50 cursor-col-resize" style={{ pointerEvents: 'none' }} />
      ) : null}

      <div className="flex-shrink-0 flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className={cn('w-2 h-2 rounded-full flex-shrink-0', statusDotColor)} />

          <div className="flex min-w-0 flex-col">
            {lineage.length > 1 ? (
              <span className="truncate text-[10px] text-gray-400">
                {lineage.slice(0, -1).join(' > ')}
              </span>
            ) : null}

            <span className="truncate text-sm font-medium text-gray-900">{label}</span>
          </div>

          <span className="flex-shrink-0 text-xs uppercase tracking-wide text-gray-500">
            {statusText}
          </span>

          {isTerminal && parentMachineName ? (
            <span className="truncate text-xs text-gray-400 flex-shrink-0">
              on {parentMachineName}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Pinned-inline infra actions + full 3-dot menu are both
              driven by the shared registry. Nothing hand-rolled here:
              identical surface to the card and to MissionControlTab,
              so one change propagates everywhere. Users choose which
              infra buttons to keep inline via the pin sidecar. */}
          <NodeActionsQuickBar ctx={nodeActionCtx} />
          <NodeActionsMenu ctx={nodeActionCtx} />

          <Button
            variant="ghost"
            size="sm"
            onClick={closePanel}
            className="h-8 w-8 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {isFrozen ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-8 text-center">
          <div className="text-blue-400/60">
            <Snowflake className="w-10 h-10" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-700">Machine is frozen</p>
            {parentLabel ? (
              <p className="mt-1 text-xs text-gray-500">
                Branched from <span className="font-medium text-gray-700">{parentLabel}</span>
              </p>
            ) : null}
            <p className="mt-2 text-xs text-gray-400">
              Branch to create a new machine that starts from this frozen state.
            </p>
          </div>
          {showBranchNameInput ? (
            <div className="flex w-full max-w-xs flex-col gap-2">
              <input
                autoFocus
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setShowBranchNameInput(false)
                    void branchMachine(nodeId, branchName.trim() || undefined)
                    setBranchName('')
                  }
                  if (e.key === 'Escape') {
                    setShowBranchNameInput(false)
                    setBranchName('')
                  }
                }}
                placeholder="Branch name (optional)"
                className="h-8 rounded-md border border-gray-300 px-2 text-sm outline-none focus:border-blue-500"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setShowBranchNameInput(false)
                    void branchMachine(nodeId, branchName.trim() || undefined)
                    setBranchName('')
                  }}
                >
                  <GitBranch className="w-3.5 h-3.5 mr-1.5" />
                  Branch
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowBranchNameInput(false)
                    setBranchName('')
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowBranchNameInput(true)}>
              <GitBranch className="w-4 h-4 mr-2" />
              Branch from here
            </Button>
          )}
        </div>
      ) : isProvisioning ? (
        // Daemon-side machine is still being created. authorizeTerminal
        // would succeed (Note row exists) but openTerminalSession would
        // fail because the PTY isn't there yet. Wait for the patch handler
        // to flip status → RUNNING via SSE, then mount the terminal.
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-gray-900 text-gray-300">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-500 border-t-white" />
          <p className="text-sm">Provisioning machine…</p>
        </div>
      ) : isMachine ? (
        // MACHINE nodes get the multiplex workstation: tabs, splits, files
        // drawer, drag-out. TERMINAL nodes (legacy share-flow canvas notes)
        // fall through to a single-pane render below.
        <MachineBody
          machineNodeId={selectedNode.id}
          parentMachineId={machineId}
          contextContent={contextContent}
          onPaneStatusChange={(_paneId, status) => {
            if (status !== 'connected') return
            const currentNodes = useCanvasStore.getState().nodes
            const node = currentNodes.find(n => {
              const d = n.data as CanvasNode.UI
              return CanvasNode.isInfra(d) && d.machineId === machineId
            })
            const data = node ? (node.data as CanvasNode.UI) : null
            if (node && data && data.status !== 'RUNNING') {
              setNodeStatus(node.id, 'RUNNING')
            }
          }}
        />
      ) : (
        <div className="flex-1 overflow-hidden rounded-b-none">
          <TerminalPanel
            key={machineId}
            terminalId={machineId}
            contextContent={contextContent}
            onStatusChange={(status) => {
              if (status === 'connected') {
                const currentNodes = useCanvasStore.getState().nodes
                const node = currentNodes.find(n => {
                  const d = n.data as CanvasNode.UI
                  return CanvasNode.isInfra(d) && d.machineId === machineId
                })
                const nodeData = node ? (node.data as CanvasNode.UI) : null
                if (node && nodeData && nodeData.status !== 'RUNNING') {
                  setNodeStatus(node.id, 'RUNNING')
                }
              }
            }}
          />
        </div>
      )}
    </div>
  )
}

export const MachineEditPanel = memo(MachineEditPanelComponent)
