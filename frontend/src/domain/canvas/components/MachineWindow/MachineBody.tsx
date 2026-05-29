'use client'

import React, { memo, useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { match } from 'venum'
import { useMachineWindowStore } from './store'
import {
  newTab,
  splitFocusedPane,
  splitTabAtEdge,
  closeFocusedPane,
  setFocusedPane,
  setSplitRatio,
  toggleDrawer,
  setDrawerOpen,
  setDrawerPath,
} from './use-cases'
import { cn } from '@/lib/utils'
import { dropOnWindow, type DropZone } from './use-cases/drop-on-window'
import { TabBar } from './TabBar'
import { PaneTree } from './PaneTree'
import { PaneChrome } from './PaneChrome'
import { DropZones } from './DropZones'
import { FilesPanel } from '@/domain/files/components/FilesPanel'

// MachineBody — the workstation surface inside a machine window. Composes
// TabBar + PaneTree + DropZones + (optional) FilesPanel overlay. All
// behaviour delegates to use cases; this component is pure orchestration.

type Props = {
  machineNodeId: string
  parentMachineId: string
  contextContent?: string
  onPaneStatusChange?: (paneId: string, status: 'connecting' | 'connected' | 'disconnected') => void
}

const MachineBodyComponent = ({
  machineNodeId,
  parentMachineId,
  contextContent,
  onPaneStatusChange,
}: Props) => {
  const ensure = useMachineWindowStore(s => s.ensure)
  const layout = useMachineWindowStore(s => s.layouts[machineNodeId])
  const focusedPaneId = useMachineWindowStore(s => s.focused[machineNodeId] ?? null)

  useEffect(() => {
    ensure(machineNodeId, parentMachineId)
  }, [ensure, machineNodeId, parentMachineId])

  // Hotkeys. Prefix is Cmd on macOS, Ctrl+Shift on Windows/Linux (plain Ctrl
  // stays free for terminal control chars; xterm swallows the Ctrl+Shift combos
  // in TerminalPanel so they reach this listener without hitting the shell):
  //   <prefix>+B drawer, <prefix>+T new tab, <prefix>+W close focused pane,
  //   <prefix>+D split focused. Split orientation/depth — macOS: Shift=vertical,
  //   Alt=outer edge (Shift=bottom); Win/Linux: Alt=vertical, outer is drag-only.
  useEffect(() => {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    const onKey = (e: KeyboardEvent) => {
      const prefixed = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey
      if (!prefixed) return
      const key = e.key.toLowerCase()

      if (key === 'b') {
        e.preventDefault()
        toggleDrawer(machineNodeId)
        return
      }

      if (key === 't') {
        e.preventDefault()
        void newTab({ machineNodeId, parentMachineId }).then(r =>
          match(r, { ok: () => undefined, error: ({ message }) => toast.error(message) }),
        )
        return
      }

      if (key === 'd') {
        e.preventDefault()
        if (isMac && e.altKey) {
          void splitTabAtEdge({
            machineNodeId,
            parentMachineId,
            edge: e.shiftKey ? 'bottom' : 'right',
          }).then(r =>
            match(r, { ok: () => undefined, error: ({ message }) => toast.error(message) }),
          )
        } else {
          const direction = (isMac ? e.shiftKey : e.altKey) ? 'v' : 'h'
          void splitFocusedPane({
            machineNodeId,
            parentMachineId,
            direction,
          }).then(r =>
            match(r, {
              ok: () => undefined,
              refused: ({ reason }) => toast.info(reason),
              error: ({ message }) => toast.error(message),
            }),
          )
        }
        return
      }

      if (key === 'w' && (!isMac || !e.shiftKey)) {
        e.preventDefault()
        void closeFocusedPane({ machineNodeId, parentMachineId }).then(r =>
          match(r, {
            ok: () => undefined,
            closedTab: () => undefined,
            refused: ({ reason }) => toast.info(reason),
          }),
        )
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [machineNodeId, parentMachineId])

  const onDropAtZone = useCallback(
    (zone: DropZone, dt: DataTransfer) => {
      match(dropOnWindow({ machineNodeId, zone, dataTransfer: dt }), {
        ok: ({ what }) => toast.success(what === 'imported' ? 'Imported terminal' : 'Moved pane'),
        refused: ({ reason }) => toast.info(reason),
        ignored: () => undefined,
      })
    },
    [machineNodeId],
  )

  if (!layout) return <div className="flex-1 bg-black" />

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TabBar
        machineNodeId={machineNodeId}
        parentMachineId={parentMachineId}
        drawerOpen={layout.filesDrawer.open}
      />
      <div className="relative flex-1 overflow-hidden">
        {/* Every tab stays MOUNTED across switches: terminal WebSockets,
            scrollback, and xterm state all survive. We stack PaneTrees in
            the same absolute slot and only toggle visibility — `display:
            none` would collapse the container to 0×0 and the ResizeObserver
            inside TerminalPanel would fire a resize-to-0 down to the daemon,
            so we use `invisible + pointer-events-none` which keeps the box
            dimensions stable. */}
        {layout.tabs.map(tab => {
          const isActive = tab.id === layout.activeTabId
          return (
            <div
              key={tab.id}
              className={cn(
                'absolute inset-0',
                isActive ? 'visible' : 'invisible pointer-events-none',
              )}
              aria-hidden={!isActive}
            >
              <PaneTree
                layout={tab.layout}
                contextContent={contextContent}
                focusedPaneId={isActive ? focusedPaneId : null}
                onFocusPane={paneId => setFocusedPane(machineNodeId, paneId)}
                onPaneStatusChange={onPaneStatusChange}
                paneChrome={paneId => (
                  <PaneChrome
                    paneId={paneId}
                    parentMachineNodeId={machineNodeId}
                    parentMachineId={parentMachineId}
                  />
                )}
                onSplitResize={(path, ratio) =>
                  setSplitRatio({ machineNodeId, tabId: tab.id, path, ratio })
                }
              />
            </div>
          )
        })}
        <DropZones onDrop={onDropAtZone} />
        {layout.filesDrawer.open && (
          <FilesPanel
            machineId={parentMachineId}
            isFrozen={false}
            onClose={() => setDrawerOpen(machineNodeId, false)}
            initialPath={layout.filesDrawer.path}
            onPathChange={p => setDrawerPath(machineNodeId, p)}
          />
        )}
      </div>
    </div>
  )
}

export const MachineBody = memo(MachineBodyComponent)
