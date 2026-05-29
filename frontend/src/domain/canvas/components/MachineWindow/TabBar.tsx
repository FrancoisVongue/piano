'use client'

import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Plus, X, Folder, Columns2, Rows2, PanelRight, PanelBottom } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MachineWindow as MW } from '@piano/shared'
import { match } from 'venum'
import { useMachineWindowStore } from './store'
import {
  newTab,
  closeTab,
  splitFocusedPane,
  splitTabAtEdge,
  toggleDrawer,
  setActiveTab,
  renameTab,
} from './use-cases'
import { toast } from 'sonner'
import { confirmDestructive } from '@/lib/confirmDestructive'

type Props = {
  machineNodeId: string
  parentMachineId: string
  drawerOpen: boolean
}

const TabBarComponent = ({ machineNodeId, parentMachineId, drawerOpen }: Props) => {
  const layout = useMachineWindowStore(s => s.layouts[machineNodeId])

  const onNew = useCallback(async () => {
    match(await newTab({ machineNodeId, parentMachineId }), {
      ok: () => undefined,
      error: ({ message }) => toast.error(message),
    })
  }, [machineNodeId, parentMachineId])

  const onSplit = useCallback(
    async (direction: 'h' | 'v') => {
      match(await splitFocusedPane({ machineNodeId, parentMachineId, direction }), {
        ok: () => undefined,
        refused: ({ reason }) => toast.info(reason),
        error: ({ message }) => toast.error(message),
      })
    },
    [machineNodeId, parentMachineId],
  )

  const onOuter = useCallback(
    async (edge: 'top' | 'right' | 'bottom' | 'left') => {
      match(await splitTabAtEdge({ machineNodeId, parentMachineId, edge }), {
        ok: () => undefined,
        error: ({ message }) => toast.error(message),
      })
    },
    [machineNodeId, parentMachineId],
  )

  if (!layout) return null

  return (
    <div className="flex flex-shrink-0 items-center gap-1 border-b border-gray-200 bg-gray-50 px-2 py-1">
      <div className="flex flex-1 items-center gap-1 overflow-x-auto">
        {layout.tabs.map((tab, i) => (
          <Tab
            key={tab.id}
            tab={tab}
            index={i}
            active={tab.id === layout.activeTabId}
            canClose={layout.tabs.length > 1}
            onSelect={() => setActiveTab(machineNodeId, tab.id)}
            onClose={async () => {
              // Tabs with more than one pane are easy to close by accident
              // when reaching for the next tab. A blocking modal (rather
              // than a soft countdown) — the daemon sessions inside are
              // irreversible and may hold important work.
              const paneCount = MW.allPaneIds({ ...layout, tabs: [tab] }).length
              if (paneCount > 1) {
                const tabName = tab.name || `term ${i + 1}`
                const proceed = await confirmDestructive({
                  title: `Close "${tabName}"?`,
                  description: `${paneCount} terminals will be closed and their running processes terminated.`,
                  confirmLabel: 'Close tab',
                })
                if (!proceed) return
              }
              match(await closeTab({ machineNodeId, parentMachineId, tabId: tab.id }), {
                ok: () => undefined,
                refused: ({ reason }) => toast.info(reason),
              })
            }}
            onRename={name => renameTab(machineNodeId, tab.id, name)}
          />
        ))}
        <button
          type="button"
          onClick={onNew}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-800"
          title="New terminal (Cmd+T)"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mx-1 h-4 w-px flex-shrink-0 bg-gray-300" />
      <button
        type="button"
        onClick={() => onSplit('h')}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-800"
        title="Split focused right (Cmd+D)"
      >
        <Columns2 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onSplit('v')}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-800"
        title="Split focused down (Cmd+Shift+D)"
      >
        <Rows2 className="h-3.5 w-3.5" />
      </button>
      <div className="mx-1 h-4 w-px flex-shrink-0 bg-gray-300" />
      <button
        type="button"
        onClick={() => onOuter('right')}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-800"
        title="Add pane on the right of the whole tab (Cmd+Alt+D)"
      >
        <PanelRight className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onOuter('bottom')}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-800"
        title="Add pane below the whole tab (Cmd+Alt+Shift+D)"
      >
        <PanelBottom className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => toggleDrawer(machineNodeId)}
        className={cn(
          'flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors',
          drawerOpen
            ? 'bg-stone-800 text-white'
            : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900',
        )}
        title="Toggle files (Cmd+B)"
      >
        <Folder className="h-3.5 w-3.5" />
        Files
      </button>
    </div>
  )
}

const Tab = memo(function Tab({
  tab,
  index,
  active,
  canClose,
  onSelect,
  onClose,
  onRename,
}: {
  tab: MW.Tab
  index: number
  active: boolean
  canClose: boolean
  onSelect: () => void
  onClose: () => void
  onRename: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(tab.name ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const startEdit = () => {
    setDraft(tab.name ?? '')
    setEditing(true)
  }
  const commit = () => {
    onRename(draft)
    setEditing(false)
  }
  const cancel = () => setEditing(false)

  return (
    <div
      onClick={() => {
        if (!editing) onSelect()
      }}
      onDoubleClick={e => {
        e.stopPropagation()
        startEdit()
      }}
      className={cn(
        'group flex h-6 cursor-pointer flex-shrink-0 items-center gap-1.5 rounded border px-2 text-xs transition-colors',
        active
          ? 'border-gray-300 bg-white text-gray-900'
          : 'border-transparent text-gray-600 hover:bg-gray-200 hover:text-gray-900',
      )}
      title={editing ? undefined : 'Double-click to rename'}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onClick={e => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') cancel()
          }}
          placeholder={`term ${index + 1}`}
          className="h-4 w-24 border-0 bg-transparent p-0 font-mono text-[11px] text-gray-900 outline-none focus:ring-0"
          maxLength={64}
        />
      ) : (
        <span className="font-mono text-[11px]">
          {tab.name || `term ${index + 1}`}
        </span>
      )}
      {canClose && !editing && (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation()
            onClose()
          }}
          className="opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
          title="Close tab"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
})

export const TabBar = memo(TabBarComponent)
