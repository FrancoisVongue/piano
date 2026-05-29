'use client'

import React, { useCallback, useMemo, useState } from 'react'
import type { Node as ReactFlowNode } from '@xyflow/react'
import { ReactFlowInstance } from '@xyflow/react'
import { Tag, MousePointer2 } from 'lucide-react'
import { areNodesStructurallyEqual, useCanvasStore, useCanvasStoreEq } from '../../store'
import { BulkOperations, CanvasNode } from '../../types'
import { InspectorColumn, InspectorRow } from './InspectorColumn'

interface TagsPanelProps {
  reactFlowInstance: ReactFlowInstance | null
  onAfterFocus?: () => void
}

function nodeDisplayText(node: ReactFlowNode<CanvasNode.UI>): string {
  const label = (node?.data?.label as string | null | undefined)?.trim()
  if (label) return label
  const content = ((node?.data?.content as string | undefined) || '').trim()
  if (!content) return '(Empty node)'
  return content.length > 40 ? `${content.slice(0, 40)}...` : content
}

export function TagsPanel({ reactFlowInstance, onAfterFocus }: TagsPanelProps) {
  const nodes = useCanvasStoreEq(
    state => state.nodes,
    areNodesStructurallyEqual,
  ) as ReactFlowNode<CanvasNode.UI>[]
  const selectByTag = useCanvasStore(state => state.selectByTag)
  // `null` distinguishes "user hasn't hovered yet" from "user is hovering tag X".
  // The previous version defaulted to tagGroups[0] which made the empty-state
  // hint unreachable — now we show the hint on initial open and only switch
  // to a concrete tag when the user actually points at one.
  const [hoveredTag, setHoveredTag] = useState<string | null>(null)

  const tagGroups = useMemo(() => {
    return BulkOperations.getAllTags(nodes)
      .map(tag => ({
        tag,
        nodes: nodes
          .filter(n => ((n.data.tags as string[] | undefined) || []).includes(tag))
          .sort((a, b) => nodeDisplayText(a).localeCompare(nodeDisplayText(b))),
      }))
      .filter(g => g.nodes.length > 0)
      .sort((a, b) => b.nodes.length - a.nodes.length || a.tag.localeCompare(b.tag))
  }, [nodes])

  const activeGroup = hoveredTag ? tagGroups.find(g => g.tag === hoveredTag) ?? null : null

  const focusNode = useCallback(
    (nodeId: string) => {
      if (!reactFlowInstance) return
      const node = useCanvasStore.getState().nodes.find(n => n.id === nodeId)
      if (!node) return
      const scale = (node.data.scale as number) || 1
      const zoom = Math.min(3, Math.max(0.5, 1.2 / (scale * scale)))
      reactFlowInstance.setCenter(node.position.x, node.position.y, { duration: 800, zoom })
      onAfterFocus?.()
    },
    [reactFlowInstance, onAfterFocus],
  )

  const handleSelectAll = useCallback((tag: string) => {
    selectByTag(tag)
    // Don't close — the user just transformed Notes→Selected and probably
    // wants to act on the selection right away.
  }, [selectByTag])

  return (
    <>
      <InspectorColumn
        icon={<Tag className="h-3 w-3" />}
        accent="text-emerald-600"
        title="Tags"
        count={tagGroups.length}
        emptyHint="No tags yet."
        width={170}
      >
        {tagGroups.map(g => (
          <InspectorRow
            key={g.tag}
            active={activeGroup?.tag === g.tag}
            onMouseEnter={() => setHoveredTag(g.tag)}
            onClick={() => handleSelectAll(g.tag)}
            title={`Select ${g.nodes.length} node${g.nodes.length === 1 ? '' : 's'} tagged "${g.tag}"`}
          >
            <Tag className="h-3 w-3 flex-shrink-0 text-emerald-600" />
            <span className="flex-1 truncate text-gray-700">{g.tag}</span>
            <span className="rounded bg-stone-100 px-1 py-0.5 text-[9px] font-medium tabular-nums text-stone-500">
              {g.nodes.length}
            </span>
          </InspectorRow>
        ))}
      </InspectorColumn>

      <InspectorColumn
        icon={activeGroup ? <Tag className="h-3 w-3" /> : <MousePointer2 className="h-3 w-3" />}
        accent={activeGroup ? 'text-emerald-500' : 'text-stone-400'}
        title={activeGroup ? `#${activeGroup.tag}` : 'Hover a tag'}
        count={activeGroup?.nodes.length}
        width={210}
        emptyHint={tagGroups.length === 0 ? '' : ''}
      >
        {!activeGroup ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <MousePointer2 className="h-4 w-4 text-stone-300" />
            <p className="text-[11px] leading-snug text-muted-foreground">
              Hover a tag on the left to preview its nodes, or click it to select them all.
            </p>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => handleSelectAll(activeGroup.tag)}
              className="flex w-full items-center gap-2 border-b border-stone-100 bg-emerald-50/40 px-3 py-1.5 text-left text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
            >
              <Tag className="h-3 w-3" />
              Select all {activeGroup.nodes.length}
            </button>
            {activeGroup.nodes.map(n => (
              <InspectorRow
                key={n.id}
                onClick={() => focusNode(n.id)}
              >
                <span className="flex-1 truncate text-gray-700">{nodeDisplayText(n)}</span>
                <span className="text-[9px] uppercase tracking-wide text-gray-400">
                  {(n.data.type as string) || 'USER'}
                </span>
              </InspectorRow>
            ))}
          </>
        )}
      </InspectorColumn>
    </>
  )
}
