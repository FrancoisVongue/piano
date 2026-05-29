'use client'

import React, { useCallback, useMemo } from 'react'
import { Play, Snowflake, TerminalSquare } from 'lucide-react'
import { ReactFlowInstance } from '@xyflow/react'
import { areNodesStructurallyEqual, useCanvasStore, useCanvasStoreEq } from '../../store'
import { InspectorColumn, InspectorRow } from './InspectorColumn'

interface MachinesPanelProps {
  reactFlowInstance: ReactFlowInstance | null
  onAfterFocus?: () => void
}

type Entry = {
  id: string
  label: string
}

export function MachinesPanel({ reactFlowInstance, onAfterFocus }: MachinesPanelProps) {
  const nodes = useCanvasStoreEq(state => state.nodes, areNodesStructurallyEqual)

  const { running, frozen, terminals } = useMemo(() => {
    const running: Entry[] = []
    const frozen: Entry[] = []
    const terminals: Entry[] = []

    for (const n of nodes) {
      const data = n.data as any
      const label =
        (data.label as string | null) ||
        (data.machineId ? String(data.machineId).slice(0, 12) : 'Unnamed')
      const entry: Entry = {
        id: n.id,
        label,
      }
      if (n.type === 'terminal' || data.type === 'TERMINAL') {
        terminals.push(entry)
      } else if (n.type === 'machine' || data.type === 'MACHINE') {
        if (data.status === 'FROZEN') frozen.push(entry)
        else running.push(entry)
      }
    }
    return { running, frozen, terminals }
  }, [nodes])

  const focus = useCallback(
    (entry: Entry) => {
      if (!reactFlowInstance) return
      const node = useCanvasStore.getState().nodes.find(n => n.id === entry.id)
      if (!node) return
      const scale = (node.data.scale as number) || 1
      const zoom = Math.min(3, Math.max(0.5, 1.2 / (scale * scale)))
      reactFlowInstance.setCenter(node.position.x, node.position.y, { duration: 500, zoom })
      onAfterFocus?.()
    },
    [reactFlowInstance, onAfterFocus],
  )

  return (
    <>
      <Column icon={<Play className="h-3 w-3" />} accent="text-green-600" title="Running" items={running} onFocus={focus} />
      <Column icon={<Snowflake className="h-3 w-3" />} accent="text-blue-600" title="Frozen" items={frozen} onFocus={focus} />
      <Column icon={<TerminalSquare className="h-3 w-3" />} accent="text-cyan-500" title="Terminals" items={terminals} onFocus={focus} />
    </>
  )
}

function Column({
  icon,
  accent,
  title,
  items,
  onFocus,
}: {
  icon: React.ReactNode
  accent: string
  title: string
  items: Entry[]
  onFocus: (entry: Entry) => void
}) {
  return (
    <InspectorColumn
      icon={icon}
      accent={accent}
      title={title}
      count={items.length}
      emptyHint="—"
      width={170}
    >
      {items.map(entry => (
        <InspectorRow key={entry.id} onClick={() => onFocus(entry)} title={entry.label}>
          <span className="min-w-0 flex-1 truncate text-gray-700">{entry.label}</span>
        </InspectorRow>
      ))}
    </InspectorColumn>
  )
}
