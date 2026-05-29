'use client'

import { memo, useState } from 'react'
import { Layers as LayersIcon, Maximize2 } from 'lucide-react'
import { useCanvasStore } from '../store'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const SCALE_PRESETS = [0.25, 0.5, 1.0, 2.0, 5.0]
const SCALE_MIN = 0.1
const SCALE_MAX = 10.0

const formatScale = (s: number) =>
  s >= 1 ? `${s.toFixed(s < 10 ? 2 : 0).replace(/\.0+$/, '')}×` : `${Math.round(s * 100)}%`

function CanvasContextStatusComponent() {
  const canvasZoom = useCanvasStore(s => s.canvasZoom)
  const imperativeZoomTo = useCanvasStore(s => s.imperativeZoomTo)
  const activeLayer = useCanvasStore(s => s.activeLayer)
  const setActiveLayer = useCanvasStore(s => s.setActiveLayer)
  const registerLayer = useCanvasStore(s => s.registerLayer)

  const [layerDraft, setLayerDraft] = useState('')

  // Skip the write if RF hasn't registered the imperative handle yet —
  // setting canvasZoom directly would diverge from the actual viewport.
  const applyZoom = (z: number) => imperativeZoomTo?.(z)

  return (
    <div className="flex items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            title="Viewport zoom. New nodes get scale 1/zoom so they spawn at constant screen size."
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span className="font-mono">{formatScale(canvasZoom)}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="end">
          <div className="text-xs font-medium text-gray-700 mb-2">Viewport zoom</div>
          <div className="flex items-center gap-2 mb-3">
            <Slider
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={0.05}
              value={[canvasZoom]}
              onValueChange={(v) => applyZoom(v[0] ?? 1.0)}
            />
            <span className="font-mono text-xs w-12 text-right">{formatScale(canvasZoom)}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {SCALE_PRESETS.map(p => (
              <button
                key={p}
                type="button"
                onClick={() => applyZoom(p)}
                className={cn(
                  'rounded border px-2 py-0.5 text-[11px] hover:bg-gray-50',
                  Math.abs(canvasZoom - p) < 0.001
                    ? 'border-emerald-400 bg-emerald-50 text-emerald-900'
                    : 'border-gray-200 text-gray-600',
                )}
              >
                {formatScale(p)}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-7 gap-1.5 px-2 text-xs',
              activeLayer && 'border-emerald-400 bg-emerald-50 text-emerald-900',
            )}
            title="Active layer (where new nodes land)"
          >
            <LayersIcon className="h-3.5 w-3.5" />
            <span>{activeLayer ?? 'global'}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="end">
          <div className="text-xs font-medium text-gray-700 mb-2">Active layer</div>
          <p className="text-[11px] text-gray-500 mb-2">
            New nodes inherit this layer. Use the bottom strip to switch.
          </p>
          <Input
            value={layerDraft}
            onChange={(e) => setLayerDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const name = layerDraft.trim()
                if (name) registerLayer(name)
                setLayerDraft('')
              }
            }}
            placeholder="new layer name…"
            className="h-7 text-xs"
          />
          {activeLayer && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-7 w-full text-xs text-gray-600"
              onClick={() => setActiveLayer(null)}
            >
              Deactivate (new nodes go global)
            </Button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

export const CanvasContextStatus = memo(CanvasContextStatusComponent)
