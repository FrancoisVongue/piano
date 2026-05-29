'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { FolderOpen, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Canvas as CanvasComponent } from '@/domain/canvas/components/Canvas'
import { LayerBar } from '@/domain/canvas/components/LayerBar'
import { CanvasContextStatus } from '@/domain/canvas/components/CanvasContextStatus'
import { useArrangements } from '@/domain/arrangement/hooks/useArrangements'
import { useMachineActivityFeed } from '@/domain/machine-center/useMachineActivityFeed'

export default function ArrangementsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const arrangementId = searchParams.get('id')
  const { arrangements, createArrangement, isCreating } = useArrangements()
  // Keep machine activity fresh so MachineNode headers + pane chrome stay live.
  useMachineActivityFeed()

  const handleCreateFirst = async () => {
    const result = await createArrangement('Untitled project')
    if (result.success) router.push(`/arrangements?id=${result.data.id}`)
  }

  if (arrangements.length === 0) {
    return (
      <main className="flex flex-1 flex-col overflow-hidden bg-[#f6f1e8]">
        <div className="flex shrink-0 items-center gap-2 border-b bg-card p-2">
          <span className="text-sm text-muted-foreground">Projects</span>
        </div>
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="max-w-sm text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-stone-200 bg-white shadow-sm">
              <FolderOpen className="h-6 w-6 text-stone-500" />
            </div>
            <h1 className="text-lg font-semibold text-stone-900">No projects yet</h1>
            <p className="mt-2 text-sm leading-6 text-stone-500">
              Create your first canvas to start arranging notes, machines, and workflows.
            </p>
            <Button
              onClick={handleCreateFirst}
              disabled={isCreating}
              className="mt-5 gap-2"
            >
              <Plus className="h-4 w-4" />
              {isCreating ? 'Creating...' : 'New project'}
            </Button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      <div className="p-2 border-b flex items-center gap-2 bg-card shrink-0">
        <span className="text-sm text-muted-foreground">Projects</span>
        <div className="ml-auto">
          <CanvasContextStatus />
        </div>
      </div>
      <div className="flex-1 overflow-hidden relative z-0">
        <CanvasComponent arrangementId={arrangementId} />
      </div>
      {/* Bottom strip: layers replace the old sub-arrangement tabs. */}
      <LayerBar disabled={!arrangementId} />
    </main>
  )
}
