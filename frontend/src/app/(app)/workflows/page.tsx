'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, Save, Trash2, X, Workflow as WorkflowIcon, ChevronUp, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Workflow, Action } from '@piano/shared'
import { newLevelId, useWorkflowsStore } from '@/domain/workflow/store'
import { useActionsStore } from '@/domain/action/store'

// -----------------------------------------------------------------------------
// Workflows page — list + table editor.
//
// A workflow is an ordered list of levels. Each level:
//   - Name             (label coordinate; used by other levels' "Input" picker)
//   - Input level      (drop-down of prior levels, or "target node" for root)
//   - Contexts (≥1)    (texts of USER nodes to plant under each parent)
//   - Action  (×1)     (single Action that runs over each planted USER node)
//
// "Multi-output" within a level isn't a workflow concept — it's the chosen
// Action's outputStyle (SINGLE_CHILD or MULTIPLE_CHILDREN). "Run two
// different actions on the same input" is expressed as two separate levels
// pointing at the same inputLevelId — naming a level IS the API.
// -----------------------------------------------------------------------------

type LocalLevel = Workflow.Level

const blankLevel = (firstActionId: string): LocalLevel => ({
  id: newLevelId(),
  name: 'New level',
  inputLevelId: null,
  contexts: [''],
  actionId: firstActionId,
})

const blankWorkflow = (firstActionId: string): { name: string; levels: LocalLevel[] } => ({
  name: 'Untitled workflow',
  levels: [blankLevel(firstActionId)],
})

export default function WorkflowsPage() {
  const workflows = useWorkflowsStore(s => s.workflows)
  const isLoading = useWorkflowsStore(s => s.isLoading)
  const fetchWorkflows = useWorkflowsStore(s => s.fetch)
  const createWorkflow = useWorkflowsStore(s => s.create)
  const updateWorkflow = useWorkflowsStore(s => s.update)
  const deleteWorkflow = useWorkflowsStore(s => s.remove)
  const isCreating = useWorkflowsStore(s => s.isCreating)
  const isUpdating = useWorkflowsStore(s => s.isUpdating)

  const actions = useActionsStore(s => s.actions)
  const fetchActions = useActionsStore(s => s.fetchActions)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftLevels, setDraftLevels] = useState<LocalLevel[]>([])
  const [isCreatingNew, setIsCreatingNew] = useState(false)

  useEffect(() => { fetchWorkflows() }, [fetchWorkflows])
  useEffect(() => { if (actions.length === 0) fetchActions() }, [fetchActions, actions.length])

  const actionsById = useMemo(() => new Map(actions.map(a => [a.id, a])), [actions])

  const startNew = () => {
    if (actions.length === 0) return
    const blank = blankWorkflow(actions[0]!.id)
    setEditingId(null)
    setIsCreatingNew(true)
    setDraftName(blank.name)
    setDraftLevels(blank.levels)
  }

  const startEdit = (wf: Workflow.Model) => {
    setEditingId(wf.id)
    setIsCreatingNew(false)
    setDraftName(wf.name)
    setDraftLevels(wf.levels.length > 0 ? wf.levels : [blankLevel(actions[0]?.id ?? '')])
  }

  const cancelDraft = () => {
    setEditingId(null)
    setIsCreatingNew(false)
    setDraftName('')
    setDraftLevels([])
  }

  const saveDraft = async () => {
    const dto = { name: draftName.trim() || 'Untitled workflow', levels: draftLevels }
    if (editingId) {
      const r = await updateWorkflow(editingId, dto)
      if (r.success) cancelDraft()
    } else {
      const r = await createWorkflow(dto)
      if (r.success) cancelDraft()
    }
  }

  if (isLoading && workflows.length === 0) {
    return (
      <main className="flex-1 flex items-center justify-center bg-white">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-sm text-gray-600">Loading workflows…</p>
        </div>
      </main>
    )
  }

  const showEditor = isCreatingNew || editingId !== null

  return (
    <main className="flex-1 flex flex-col overflow-hidden bg-white">
      <div className="p-2 border-b flex items-center justify-between bg-card shrink-0">
        <div className="flex items-center gap-2">
          <WorkflowIcon className="w-4 h-4" />
          <span className="text-sm font-semibold">Workflows</span>
        </div>
        {!showEditor && (
          <Button
            onClick={startNew}
            size="sm"
            className="gap-2"
            disabled={actions.length === 0}
            title={actions.length === 0 ? 'Create at least one Action first' : undefined}
          >
            <Plus className="w-4 h-4" /> New Workflow
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6 max-w-5xl w-full mx-auto">
        {showEditor && (
          <WorkflowEditor
            name={draftName}
            levels={draftLevels}
            actions={actions}
            isSaving={isCreating || isUpdating}
            onChangeName={setDraftName}
            onChangeLevels={setDraftLevels}
            onCancel={cancelDraft}
            onSave={saveDraft}
            isNew={isCreatingNew}
          />
        )}

        {!showEditor && workflows.length === 0 && (
          <div className="text-center py-20">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <WorkflowIcon className="w-8 h-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No workflows yet</h3>
            <p className="text-gray-500 mb-6">
              Build one — a table of named levels. Each level plants USER notes
              and runs a chosen Action over them. Run it on a node and the
              tree grows wide.
            </p>
            <Button
              onClick={startNew}
              className="gap-2"
              disabled={actions.length === 0}
              title={actions.length === 0 ? 'Create at least one Action first' : undefined}
            >
              <Plus className="w-4 h-4" /> Create Your First Workflow
            </Button>
            {actions.length === 0 && (
              <p className="text-xs text-gray-400 mt-3">
                You need at least one Action before you can build a workflow.
              </p>
            )}
          </div>
        )}

        {!showEditor && workflows.length > 0 && (
          <div className="space-y-3">
            {workflows.map(wf => (
              <Card
                key={wf.id}
                className="p-5 transition-all hover:border-black cursor-pointer"
                onClick={() => startEdit(wf)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold mb-1 truncate">{wf.name}</h3>
                    <div className="flex flex-wrap gap-1 text-xs text-gray-500">
                      {wf.levels.map((l, i) => {
                        const act = actionsById.get(l.actionId)
                        return (
                          <span key={l.id} className="px-2 py-0.5 bg-gray-100 rounded">
                            {i + 1}. {l.name} · {l.contexts.length}× → {act?.name ?? 'unknown'}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (!confirm(`Delete workflow "${wf.name}"?`)) return
                      await deleteWorkflow(wf.id)
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

// -----------------------------------------------------------------------------
// Editor.
// -----------------------------------------------------------------------------

interface EditorProps {
  name: string
  levels: LocalLevel[]
  actions: Action.Model[]
  isNew: boolean
  isSaving: boolean
  onChangeName: (s: string) => void
  onChangeLevels: (l: LocalLevel[]) => void
  onCancel: () => void
  onSave: () => void
}

function WorkflowEditor(props: EditorProps) {
  const { name, levels, actions, isNew, isSaving, onChangeName, onChangeLevels, onCancel, onSave } = props

  // A level's inputLevelId must be null (= target node) or point to a level
  // positioned earlier in the array. Reorder + remove preserve this; we
  // repair after each mutation so the UI never holds a forward reference.
  const repairForwardRefs = (next: LocalLevel[]): LocalLevel[] =>
    next.map((l, i) => {
      if (l.inputLevelId === null) return l
      const refIdx = next.findIndex(x => x.id === l.inputLevelId)
      return refIdx >= 0 && refIdx < i ? l : { ...l, inputLevelId: null }
    })

  const isValid = useMemo(() => {
    if (!name.trim()) return false
    if (levels.length === 0) return false
    const actionIds = new Set(actions.map(a => a.id))
    return levels.every((l, i) => {
      if (l.name.trim().length === 0) return false
      if (l.contexts.length === 0) return false
      if (!l.contexts.every(c => c.trim().length > 0)) return false
      if (l.actionId.length === 0 || !actionIds.has(l.actionId)) return false
      // inputLevelId must be null OR reference a strictly-earlier level.
      if (l.inputLevelId !== null) {
        const refIdx = levels.findIndex(x => x.id === l.inputLevelId)
        if (refIdx < 0 || refIdx >= i) return false
      }
      return true
    })
  }, [name, levels, actions])

  const updateLevel = (idx: number, patch: Partial<LocalLevel>) => {
    onChangeLevels(levels.map((l, i) => i === idx ? { ...l, ...patch } : l))
  }
  const addLevel = () => {
    const last = levels[levels.length - 1]
    onChangeLevels([
      ...levels,
      {
        ...blankLevel(actions[0]?.id ?? ''),
        inputLevelId: last?.id ?? null,
        name: `Level ${levels.length + 1}`,
      },
    ])
  }
  const removeLevel = (idx: number) => {
    const removed = levels[idx]
    onChangeLevels(levels
      .filter((_, i) => i !== idx)
      .map(l => l.inputLevelId === removed?.id ? { ...l, inputLevelId: null } : l))
  }
  const moveLevel = (idx: number, dir: -1 | 1) => {
    const next = [...levels]
    const target = idx + dir
    if (target < 0 || target >= next.length) return
    const tmp = next[idx]!
    next[idx] = next[target]!
    next[target] = tmp
    onChangeLevels(repairForwardRefs(next))
  }

  return (
    <Card className="p-6 mb-6 border-2 border-black">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">{isNew ? 'Create Workflow' : 'Edit Workflow'}</h3>
        <Button variant="ghost" size="icon" onClick={onCancel} disabled={isSaving}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="mb-5">
        <label className="text-sm font-medium">Name</label>
        <Input
          value={name}
          onChange={(e) => onChangeName(e.target.value)}
          placeholder="e.g., Outline → Develop → Critique"
          className="mt-1"
        />
      </div>

      <div className="mb-3 text-sm font-semibold text-gray-700">Levels</div>
      <div className="space-y-3">
        {levels.map((lvl, idx) => (
          <LevelRow
            key={lvl.id}
            index={idx}
            level={lvl}
            actions={actions}
            priorLevels={levels.slice(0, idx)}
            canMoveUp={idx > 0}
            canMoveDown={idx < levels.length - 1}
            canRemove={levels.length > 1}
            onChange={(patch) => updateLevel(idx, patch)}
            onMove={(dir) => moveLevel(idx, dir)}
            onRemove={() => removeLevel(idx)}
          />
        ))}
      </div>

      <Button variant="outline" size="sm" className="mt-4 gap-2" onClick={addLevel}>
        <Plus className="w-4 h-4" /> Add Level
      </Button>

      <div className="flex gap-2 justify-end pt-6">
        <Button variant="outline" onClick={onCancel} disabled={isSaving}>Cancel</Button>
        <Button onClick={onSave} disabled={!isValid || isSaving} className="gap-2">
          <Save className="w-4 h-4" /> {isSaving ? 'Saving…' : isNew ? 'Create' : 'Save'}
        </Button>
      </div>
    </Card>
  )
}

interface LevelRowProps {
  index: number
  level: LocalLevel
  actions: Action.Model[]
  priorLevels: LocalLevel[]
  canMoveUp: boolean
  canMoveDown: boolean
  canRemove: boolean
  onChange: (patch: Partial<LocalLevel>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}

function LevelRow(p: LevelRowProps) {
  const { index, level, actions, priorLevels, canMoveUp, canMoveDown, canRemove, onChange, onMove, onRemove } = p

  const updateContextAt = (i: number, val: string) => {
    onChange({ contexts: level.contexts.map((c, k) => k === i ? val : c) })
  }
  const addContext = () => {
    onChange({ contexts: [...level.contexts, ''] })
  }
  const removeContext = (i: number) => {
    if (level.contexts.length <= 1) return
    onChange({ contexts: level.contexts.filter((_, k) => k !== i) })
  }

  return (
    <div className="border rounded-md p-3 bg-gray-50">
      <div className="grid grid-cols-12 gap-2 items-start mb-2">
        <div className="col-span-1 flex flex-col items-center text-xs text-gray-500 pt-2">
          <span className="font-semibold mb-1">{index + 1}</span>
          <button
            type="button"
            className={cn('p-0.5 rounded hover:bg-gray-200 disabled:opacity-30', !canMoveUp && 'cursor-default')}
            onClick={() => onMove(-1)}
            disabled={!canMoveUp}
            aria-label="Move up"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className={cn('p-0.5 rounded hover:bg-gray-200 disabled:opacity-30', !canMoveDown && 'cursor-default')}
            onClick={() => onMove(1)}
            disabled={!canMoveDown}
            aria-label="Move down"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="col-span-4">
          <label className="text-xs font-medium text-gray-600">Name</label>
          <Input
            value={level.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g., Chapters"
            className="mt-0.5 h-8 text-sm"
          />
        </div>

        <div className="col-span-3">
          <label className="text-xs font-medium text-gray-600">Input</label>
          <select
            value={level.inputLevelId ?? ''}
            onChange={(e) => onChange({ inputLevelId: e.target.value || null })}
            className="mt-0.5 h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-sm"
          >
            <option value="">target node</option>
            {priorLevels.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="col-span-3">
          <label className="text-xs font-medium text-gray-600">Action</label>
          <select
            value={level.actionId}
            onChange={(e) => onChange({ actionId: e.target.value })}
            className="mt-0.5 h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-sm"
          >
            {actions.length === 0 && <option value="">— no actions —</option>}
            {actions.map(a => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.outputStyle === 'MULTIPLE_CHILDREN' ? 'multi' : 'single'})
              </option>
            ))}
          </select>
        </div>

        <div className="col-span-1 flex justify-end pt-5">
          {canRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="p-1 rounded text-red-600 hover:bg-red-50"
              aria-label="Remove level"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="ml-[8.33%] space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">
          Contexts — USER nodes planted under each parent
        </div>
        {level.contexts.map((c, i) => (
          <div key={i} className="flex gap-2 items-start">
            <span className="text-[10px] uppercase tracking-wide text-gray-400 pt-2 w-6 text-right">
              {level.contexts.length > 1 ? `#${i + 1}` : ''}
            </span>
            <Textarea
              value={c}
              onChange={(e) => updateContextAt(i, e.target.value)}
              placeholder={i === 0 ? 'Question / instruction to plant as a USER node' : 'Another USER node — runs alongside'}
              className="text-sm min-h-[60px]"
            />
            {level.contexts.length > 1 && (
              <button
                type="button"
                onClick={() => removeContext(i)}
                className="p-1 rounded text-gray-500 hover:bg-gray-200"
                aria-label="Remove context"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={addContext}
          className="text-xs text-blue-600 hover:text-blue-700 inline-flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> add another context
        </button>
      </div>
    </div>
  )
}
