'use client'

import { memo, useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { Plus, Eye, EyeOff, Layers as LayersIcon, X } from 'lucide-react'
import { Note } from '@piano/shared'
import { areNodesStructurallyEqual, useCanvasStore, useCanvasStoreEq } from '../store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface LayerBarProps {
  disabled?: boolean
}

function LayerBarComponent({ disabled }: LayerBarProps) {
  const nodes = useCanvasStoreEq(s => s.nodes, areNodesStructurallyEqual)
  const activeLayer = useCanvasStore(s => s.activeLayer)
  const visibleLayers = useCanvasStore(s => s.visibleLayers)
  const knownLayers = useCanvasStore(s => s.knownLayers)
  const globalVisible = useCanvasStore(s => s.globalVisible)
  const setActiveLayer = useCanvasStore(s => s.setActiveLayer)
  const toggleVisibleLayer = useCanvasStore(s => s.toggleVisibleLayer)
  const toggleGlobalVisible = useCanvasStore(s => s.toggleGlobalVisible)
  const registerLayer = useCanvasStore(s => s.registerLayer)

  // Both sources merged: imports/sync deliver layers via notes; the store
  // tracks intent for layers the user typed but didn't yet populate.
  const allLayers = useMemo(() => {
    const merged = new Set<string>(Note.Layers.collectKnown(nodes.map(n => n.data as any)))
    for (const l of knownLayers) merged.add(l)
    return [...merged].sort()
  }, [nodes, knownLayers])

  const globalCount = useMemo(
    () => nodes.filter(n => Note.Layers.isGlobal(n.data as any)).length,
    [nodes],
  )

  const layerCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of nodes) {
      const ls = ((n.data as any).layers as string[] | undefined) ?? []
      for (const l of ls) counts.set(l, (counts.get(l) ?? 0) + 1)
    }
    return counts
  }, [nodes])

  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  const commitNew = useCallback(() => {
    const name = draft.trim()
    setDraft('')
    setCreating(false)
    if (name) registerLayer(name)
  }, [draft, registerLayer])

  const globalIsActive = activeLayer === null
  const globalIsHidden = !globalVisible

  return (
    <div
      className={cn(
        'flex items-center gap-1 px-3 py-1 bg-white/95 border-t border-gray-200 overflow-x-auto select-none',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      <div className="flex items-center gap-1 mr-2 text-xs text-gray-500">
        <LayersIcon className="h-3.5 w-3.5" />
        <span>Layers</span>
      </div>

      <div
        className={cn(
          'group flex items-center gap-1 px-2 py-1 rounded text-xs whitespace-nowrap border cursor-pointer transition-colors',
          globalIsActive
            ? 'bg-emerald-50 border-emerald-400 text-emerald-900 font-semibold'
            : globalIsHidden
              ? 'bg-gray-50 border-dashed border-gray-300 text-gray-400 hover:text-gray-600'
              : 'bg-gray-50 border-dashed border-gray-300 text-gray-500 hover:bg-gray-100',
        )}
        onClick={() => { if (!globalIsActive) setActiveLayer(null) }}
        title={
          globalIsActive
            ? 'Global is active — click a layer chip to activate that instead'
            : 'Activate global (new nodes show on every layer)'
        }
      >
        <span>global</span>
        <span className="text-[10px] opacity-70">{globalCount}</span>
        {!globalIsActive && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleGlobalVisible() }}
            className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-black/5"
            aria-label={globalVisible ? 'Hide global' : 'Show global'}
          >
            {globalVisible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          </button>
        )}
      </div>

      {allLayers.map(layer => {
        const isActive = activeLayer === layer
        const isVisible = visibleLayers.has(layer)
        const count = layerCounts.get(layer) ?? 0
        return (
          <div
            key={layer}
            className={cn(
              'group flex items-center gap-1 px-2 py-1 rounded text-xs whitespace-nowrap border cursor-pointer transition-colors',
              isActive
                ? 'bg-emerald-50 border-emerald-400 text-emerald-900 font-semibold'
                : isVisible
                  ? 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                  : 'bg-gray-50 border-gray-200 text-gray-400 hover:text-gray-600',
            )}
            onClick={() => { if (!isActive) setActiveLayer(layer) }}
            title={
              isActive
                ? `${layer} — active. Click “global” to deactivate.`
                : `Activate ${layer}`
            }
          >
            <span>{layer}</span>
            <span className="text-[10px] opacity-70">{count}</span>
            {!isActive && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleVisibleLayer(layer) }}
                className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-black/5"
                aria-label={isVisible ? `Hide ${layer}` : `Show ${layer}`}
              >
                {isVisible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              </button>
            )}
          </div>
        )
      })}

      {creating ? (
        <div className="flex items-center gap-1 ml-1">
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNew()
              else if (e.key === 'Escape') { setDraft(''); setCreating(false) }
            }}
            onBlur={commitNew}
            placeholder="layer name"
            className="h-6 w-32 px-2 text-xs"
          />
          <button
            type="button"
            onClick={() => { setDraft(''); setCreating(false) }}
            className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-gray-100"
            aria-label="Cancel new layer"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-gray-600"
          onClick={() => setCreating(true)}
        >
          <Plus className="mr-1 h-3 w-3" />
          New layer
        </Button>
      )}
    </div>
  )
}

export const LayerBar = memo(LayerBarComponent)
