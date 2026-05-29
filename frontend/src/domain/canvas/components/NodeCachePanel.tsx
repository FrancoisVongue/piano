'use client'

import React, { useEffect, useRef } from 'react'
import { Database, Trash2, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Note, LLM } from '@piano/shared'
import { useNoteCacheActions } from '../hooks/useNoteCacheActions'

// -----------------------------------------------------------------------------
// NodeCachePanel — side panel opened from the 3-dot menu's "Cache branch"
// tool. Pattern matches the Context Path panel (ancestorDialog): positioned
// absolutely under the header, dark/light themed, closes on outside click.
//
// Contents stay the same as the old submenu: TTL picker, enable/disable,
// clear. Just re-skinned for a flat panel instead of a nested submenu.
// -----------------------------------------------------------------------------

interface Props {
  noteId: string
  currentModelId: LLM.ModelId
  cacheConfig: unknown
  isAssistantNode: boolean
  onClose: () => void
  /** When provided, caller positions the panel (e.g. via fixed portal).
   * Default keeps the legacy absolute-in-parent positioning. */
  className?: string
  /** Caller may skip the self-managed outside-click close (useful when
   * the host already handles it uniformly for all dialogs). */
  manageOutsideClick?: boolean
}

export function NodeCachePanel({
  noteId,
  currentModelId,
  cacheConfig,
  isAssistantNode,
  onClose,
  className,
  manageOutsideClick = true,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const model = LLM.getModelById(currentModelId)
  const entry = Note.CacheConfig.get(cacheConfig, currentModelId)
  const actions = useNoteCacheActions(noteId, currentModelId)

  // Close on outside click — same behaviour as the other header panels.
  useEffect(() => {
    if (!manageOutsideClick) return
    const onMouseDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => document.removeEventListener('mousedown', onMouseDown, true)
  }, [onClose, manageOutsideClick])

  if (!model) return null

  return (
    <div
      ref={panelRef}
      className={cn(
        className ?? 'absolute right-0 top-full mt-1 z-30',
        'p-3 rounded-lg shadow-lg border min-w-64',
        isAssistantNode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200',
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <div className={cn(
          'text-xs font-semibold flex items-center gap-1.5',
          isAssistantNode ? 'text-gray-200' : 'text-gray-700',
        )}>
          <Database className="h-3.5 w-3.5" />
          Cache branch
        </div>
        <span className={cn(
          'text-[10px]',
          isAssistantNode ? 'text-gray-400' : 'text-gray-500',
        )}>
          {model.name}
        </span>
      </div>

      {!model.cache.controllable ? (
        <div className={cn(
          'text-xs py-1',
          isAssistantNode ? 'text-gray-400' : 'text-gray-500',
        )}>
          Auto-cached by provider — no TTL control.
        </div>
      ) : (
        <CacheBody
          entry={entry}
          model={model}
          isAssistantNode={isAssistantNode}
          busy={actions.busy}
          onPick={(ttl) => actions.set(ttl).then(r => r.ok && onClose())}
          onToggle={(enabled) => actions.toggle(enabled)}
          onClear={() => actions.clear().then(r => r.ok && onClose())}
        />
      )}
    </div>
  )
}

const CacheBody = ({
  entry,
  model,
  isAssistantNode,
  busy,
  onPick,
  onToggle,
  onClear,
}: {
  entry: Note.CacheConfig.Entry | undefined
  model: LLM.Model
  isAssistantNode: boolean
  busy: boolean
  onPick: (ttl: string) => void
  onToggle: (enabled: boolean) => void
  onClear: () => void
}) => {
  const hasAnchor = !!entry
  const isActive = !!entry?.enabled

  return (
    <>
      <div className="flex flex-col gap-1">
        {model.cache.controllable && model.cache.ttlOptions.map(opt => {
          const selected = entry?.ttl === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => onPick(opt.value)}
              disabled={busy}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded text-xs transition-colors',
                'flex items-center justify-between gap-2 disabled:opacity-50',
                selected && isActive
                  ? (isAssistantNode ? 'bg-emerald-900/50 text-emerald-200' : 'bg-emerald-50 text-emerald-700')
                  : (isAssistantNode ? 'text-gray-200 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'),
              )}
            >
              <span>{opt.label}</span>
              {selected && isActive && <Check className="h-3 w-3" />}
            </button>
          )
        })}
      </div>

      {hasAnchor && (
        <div className={cn(
          'flex gap-2 mt-2 pt-2 border-t',
          isAssistantNode ? 'border-gray-700' : 'border-gray-200',
        )}>
          <button
            onClick={() => onToggle(!isActive)}
            disabled={busy}
            className={cn(
              'flex-1 px-2 py-1.5 rounded text-xs disabled:opacity-50',
              isAssistantNode
                ? 'text-gray-200 hover:bg-gray-700 border border-gray-600'
                : 'text-gray-700 hover:bg-gray-100 border border-gray-200',
            )}
          >
            {isActive ? 'Disable' : 'Enable'}
          </button>
          <button
            onClick={onClear}
            disabled={busy}
            title="Clear cache"
            className={cn(
              'px-2 py-1.5 rounded text-xs disabled:opacity-50',
              isAssistantNode
                ? 'text-red-400 hover:bg-red-950/50 border border-gray-600'
                : 'text-red-600 hover:bg-red-50 border border-gray-200',
            )}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </>
  )
}
