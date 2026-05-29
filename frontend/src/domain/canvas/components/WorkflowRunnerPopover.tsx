'use client'

/**
 * Tiny picker mounted inside <NodeDialogsHost> when the user clicks
 * "Run Workflow…" on a node. Lists the user's workflows and runs the
 * selected one against the source node + the canvas's current model.
 *
 * No optimistic UI here — backend kicks off the Temporal orchestrator and
 * the resulting nodes stream in over the existing SSE pipe. We just toast
 * on accept/reject and close.
 */

import { useEffect } from 'react'
import { Workflow as WorkflowIcon, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useCanvasStore } from '../store'
import { useWorkflowsStore } from '@/domain/workflow/store'

interface Props {
  nodeId: string
  onClose: () => void
}

export function WorkflowRunnerPopover({ nodeId, onClose }: Props) {
  const workflows = useWorkflowsStore(s => s.workflows)
  const isLoading = useWorkflowsStore(s => s.isLoading)
  const isRunning = useWorkflowsStore(s => s.isRunning)
  const fetch = useWorkflowsStore(s => s.fetch)
  const run = useWorkflowsStore(s => s.run)
  const selectedModel = useCanvasStore(s => s.selectedModel)

  useEffect(() => { if (workflows.length === 0) fetch() }, [fetch, workflows.length])

  const onPick = async (workflowId: string, name: string) => {
    const r = await run(workflowId, { targetNoteId: nodeId, model: selectedModel })
    if (r.success) toast.success(`Running "${name}"…`)
    else toast.error(r.error ?? 'Failed to start workflow')
    onClose()
  }

  return (
    <div className="flex flex-col gap-1 max-h-[260px] overflow-y-auto">
      <div className="text-xs font-semibold text-gray-700 px-1 py-1">Run workflow</div>
      {isLoading && workflows.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-gray-500 py-2 px-1">
          <Loader2 className="w-3 h-3 animate-spin" /> loading…
        </div>
      )}
      {!isLoading && workflows.length === 0 && (
        <div className="text-xs text-gray-500 py-2 px-1">
          No workflows yet — create one from the Workflows page.
        </div>
      )}
      {workflows.map(wf => (
        <button
          key={wf.id}
          type="button"
          disabled={isRunning}
          onClick={() => onPick(wf.id, wf.name)}
          className="flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left text-gray-800 hover:bg-gray-100 disabled:opacity-50"
        >
          <WorkflowIcon className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
          <span className="truncate flex-1">{wf.name}</span>
          <span className="text-[10px] text-gray-400 flex-shrink-0">{wf.levels.length} lvl</span>
        </button>
      ))}
    </div>
  )
}
