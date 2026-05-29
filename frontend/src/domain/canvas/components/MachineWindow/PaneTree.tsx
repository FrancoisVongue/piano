'use client'

import React, { memo } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { MachineWindow as MW } from '@piano/shared'
import TerminalPanel from '@/domain/terminal/components/TerminalPanel'
import { TERMINAL_CONFIG } from '@/config'
import { cn } from '@/lib/utils'

// PaneTree renders one tab's pane tree. Leaves are TerminalPanel; splits use
// react-resizable-panels for draggable separators. Click any pane to focus
// it — focus state lives in the MachineWindow store and drives split/close
// hotkeys (Cmd+D / Cmd+W).
//
// Design choice: we render a focus ring around the focused leaf. We do not
// auto-focus xterm.js when the user clicks the chrome — clicks on the
// terminal canvas already give it focus, this just tracks "which pane do
// hotkeys target".
//
// Drag-resize persistence: each split's ratio lives in the shared Layout
// schema. PaneTree fires `onSplitResize(path, ratio)` on every onLayout tick
// where the ratio actually changes; the caller writes it back via
// MachineWindow.setSplitRatio, and the canvas sync debounce (2s) collapses
// the drag burst into one patch on release.

type Props = {
  layout: MW.PaneLayout
  contextContent?: string
  focusedPaneId: string | null
  onFocusPane: (paneId: string) => void
  onPaneStatusChange?: (paneId: string, status: 'connecting' | 'connected' | 'disconnected') => void
  // Extra controls (drag / close) that get rendered inside TerminalPanel's
  // existing top-right chrome cluster, so all per-pane affordances live in
  // one visual block instead of multiple floating overlays.
  paneChrome?: (paneId: string) => React.ReactNode
  // Called when a split separator is dragged. `path` is the sequence of
  // 'a'/'b' steps from the tab root that addresses the split.
  onSplitResize?: (path: ('a' | 'b')[], ratio: number) => void
}

type NodeProps = Props & { path: ('a' | 'b')[] }

const PaneTreeComponent = (props: Props) => <PaneNode {...props} path={[]} />

const PaneNode = ({
  layout,
  contextContent,
  focusedPaneId,
  onFocusPane,
  onPaneStatusChange,
  paneChrome,
  onSplitResize,
  path,
}: NodeProps) => {
  if (layout.kind === 'pane') {
    const focused = focusedPaneId === layout.paneId
    return (
      <div
        className={cn(
          'group relative h-full w-full overflow-hidden bg-black',
          focused ? 'ring-2 ring-inset ring-emerald-500/50' : 'ring-1 ring-inset ring-black/20',
        )}
        onMouseDown={() => onFocusPane(layout.paneId)}
      >
        <TerminalPanel
          key={layout.paneId}
          terminalId={layout.paneId}
          // Empty daemonUrl → TerminalPanel uses the backend proxy
          // (/api/terminal/:machineId). The DIRECT_DAEMON_URL env override
          // is only for dev debugging against a direct daemon listener.
          daemonUrl={TERMINAL_CONFIG.DIRECT_DAEMON_URL}
          contextContent={contextContent}
          onStatusChange={status => onPaneStatusChange?.(layout.paneId, status)}
          chromeExtras={paneChrome?.(layout.paneId)}
        />
      </div>
    )
  }

  // Split node: react-resizable-panels v4 uses `orientation` instead of
  // `direction`. Our `dir` is user-facing: 'h' = horizontal split (panes
  // side-by-side), 'v' = vertical split (panes stacked).
  const orientation = layout.dir === 'h' ? 'horizontal' : 'vertical'
  const aPercent = Math.max(5, Math.min(95, layout.ratio * 100))
  const bPercent = 100 - aPercent
  // The first Panel's onResize fires whenever its size changes — drag or
  // mount. Skip ticks that don't actually move the ratio (initial mount
  // emits the current size, and dragging into a min-size wall keeps emitting
  // the clamped value) so we don't dirty the layout for no reason.
  const handlePanelAResize = (size: { asPercentage: number }) => {
    if (!onSplitResize) return
    const nextRatio = size.asPercentage / 100
    if (Math.abs(nextRatio - layout.ratio) < 0.001) return
    onSplitResize(path, nextRatio)
  }
  return (
    <Group orientation={orientation} className="h-full w-full">
      <Panel defaultSize={`${aPercent}%`} minSize="10%" onResize={handlePanelAResize}>
        <PaneNode
          layout={layout.a}
          contextContent={contextContent}
          focusedPaneId={focusedPaneId}
          onFocusPane={onFocusPane}
          onPaneStatusChange={onPaneStatusChange}
          paneChrome={paneChrome}
          onSplitResize={onSplitResize}
          path={[...path, 'a']}
        />
      </Panel>
      <Separator
        className={cn(
          'flex items-center justify-center bg-stone-200 transition-colors hover:bg-stone-400',
          orientation === 'horizontal' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
        )}
      />
      <Panel defaultSize={`${bPercent}%`} minSize="10%">
        <PaneNode
          layout={layout.b}
          contextContent={contextContent}
          focusedPaneId={focusedPaneId}
          onFocusPane={onFocusPane}
          onPaneStatusChange={onPaneStatusChange}
          paneChrome={paneChrome}
          onSplitResize={onSplitResize}
          path={[...path, 'b']}
        />
      </Panel>
    </Group>
  )
}

export const PaneTree = memo(PaneTreeComponent)
