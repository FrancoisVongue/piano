'use client'

import { useState, useEffect } from 'react'
import { Plus, Edit2, Trash2, Save, X, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useActionsStore } from '@/domain/action/store'
import { Action } from '@piano/shared'
import { cn } from '@/lib/utils'

export default function ActionsPage() {
  const actions = useActionsStore(state => state.actions)
  const isLoading = useActionsStore(state => state.isLoading)
  const createAction = useActionsStore(state => state.createAction)
  const updateAction = useActionsStore(state => state.updateAction)
  const deleteAction = useActionsStore(state => state.deleteAction)
  const isCreating = useActionsStore(state => state.isCreating)
  const isUpdating = useActionsStore(state => state.isUpdating)
  const isDeleting = useActionsStore(state => state.isDeleting)
  const fetchActions = useActionsStore(state => state.fetchActions)
  
  const [isCreatingNew, setIsCreatingNew] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  
  // Form state for create
  const [newAction, setNewAction] = useState<Action.DTO.Create>({
    name: '',
    prompt: '',
    useAncestors: true,
    resolveContent: true,
    outputStyle: 'SINGLE_CHILD',
  })
  
  // Form state for edit
  const [editAction, setEditAction] = useState<Action.DTO.Update>({})

  // Fetch actions on mount
  useEffect(() => {
    fetchActions()
  }, [fetchActions])

  const handleCreate = async () => {
    if (!newAction.name.trim() || !newAction.prompt.trim()) return

    const result = await createAction(newAction)
    if (result.success) {
      setNewAction({
        name: '',
        prompt: '',
        useAncestors: true,
        resolveContent: true,
        outputStyle: 'SINGLE_CHILD',
      })
      setIsCreatingNew(false)
    }
  }

  const handleStartEdit = (action: Action.Model) => {
    setEditingId(action.id)
    setEditAction({
      name: action.name,
      prompt: action.prompt,
      useAncestors: action.useAncestors,
      resolveContent: action.resolveContent,
      outputStyle: action.outputStyle,
    })
  }

  const handleSaveEdit = async () => {
    if (!editingId) return

    const result = await updateAction(editingId, editAction)
    if (result.success) {
      setEditingId(null)
      setEditAction({})
    }
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditAction({})
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this action?')) return
    await deleteAction(id)
  }

  if (isLoading) {
    return (
      <main className="flex-1 flex items-center justify-center bg-white">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-sm text-gray-600">Loading actions...</p>
        </div>
      </main>
    )
  }

  return (
    <main className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Header */}
      <div className="p-2 border-b flex items-center justify-between bg-card shrink-0">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4" />
          <span className="text-sm font-semibold">Actions</span>
        </div>
        {!isCreatingNew && (
          <Button onClick={() => setIsCreatingNew(true)} size="sm" className="gap-2">
            <Plus className="w-4 h-4" />
            New Action
          </Button>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6 max-w-5xl w-full mx-auto">
        {/* Create Form */}
        {isCreatingNew && (
          <Card className="p-6 mb-6 border-2 border-black">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Create New Action</h3>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsCreatingNew(false)}
                disabled={isCreating}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label htmlFor="new-name" className="text-sm font-medium">Name</label>
                <Input
                  id="new-name"
                  value={newAction.name}
                  onChange={(e) => setNewAction({ ...newAction, name: e.target.value })}
                  placeholder="e.g., Summarize, Split into Steps, Extract Key Points"
                  className="mt-1"
                  autoFocus
                />
              </div>

              <div>
                <label htmlFor="new-prompt" className="text-sm font-medium">Prompt</label>
                <Textarea
                  id="new-prompt"
                  value={newAction.prompt}
                  onChange={(e) => setNewAction({ ...newAction, prompt: e.target.value })}
                  placeholder="e.g., Summarize the following content in 3-5 bullet points..."
                  className="mt-1 min-h-[120px]"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="new-output-style" className="text-sm font-medium">Output Style</label>
                  <select
                    id="new-output-style"
                    value={newAction.outputStyle}
                    onChange={(e) => setNewAction({ ...newAction, outputStyle: e.target.value as Action.OutputStyle })}
                    className="mt-1 w-full px-3 py-2 border rounded-md text-sm"
                  >
                    <option value="SINGLE_CHILD">Single Child Node</option>
                    <option value="MULTIPLE_CHILDREN">Multiple Child Nodes</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Options</label>
                  <div className="flex items-center gap-4 mt-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newAction.useAncestors}
                        onChange={(e) => setNewAction({ ...newAction, useAncestors: e.target.checked })}
                        className="w-4 h-4"
                      />
                      <span className="text-sm">Use Ancestors</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newAction.resolveContent}
                        onChange={(e) => setNewAction({ ...newAction, resolveContent: e.target.checked })}
                        className="w-4 h-4"
                      />
                      <span className="text-sm">Resolve Content</span>
                    </label>
                  </div>
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-2">
                <Button
                  variant="outline"
                  onClick={() => setIsCreatingNew(false)}
                  disabled={isCreating}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={!newAction.name.trim() || !newAction.prompt.trim() || isCreating}
                >
                  {isCreating ? 'Creating...' : 'Create Action'}
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Actions List */}
        {actions.length === 0 && !isCreatingNew ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Zap className="w-8 h-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No actions yet</h3>
            <p className="text-gray-500 mb-6">Create your first custom action to get started</p>
            <Button onClick={() => setIsCreatingNew(true)} className="gap-2">
              <Plus className="w-4 h-4" />
              Create Action
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {actions.map((action) => (
              <Card
                key={action.id}
                className={cn(
                  "p-6 transition-all",
                  editingId === action.id && "border-2 border-black"
                )}
              >
                {editingId === action.id ? (
                  // Edit Mode
                  <div className="space-y-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-lg font-semibold">Edit Action</h3>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleCancelEdit}
                        disabled={isUpdating}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>

                    <div>
                      <label htmlFor={`edit-name-${action.id}`} className="text-sm font-medium">Name</label>
                      <Input
                        id={`edit-name-${action.id}`}
                        value={editAction.name || ''}
                        onChange={(e) => setEditAction({ ...editAction, name: e.target.value })}
                        className="mt-1"
                      />
                    </div>

                    <div>
                      <label htmlFor={`edit-prompt-${action.id}`} className="text-sm font-medium">Prompt</label>
                      <Textarea
                        id={`edit-prompt-${action.id}`}
                        value={editAction.prompt || ''}
                        onChange={(e) => setEditAction({ ...editAction, prompt: e.target.value })}
                        className="mt-1 min-h-[120px]"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label htmlFor={`edit-output-${action.id}`} className="text-sm font-medium">Output Style</label>
                        <select
                          id={`edit-output-${action.id}`}
                          value={editAction.outputStyle || action.outputStyle}
                          onChange={(e) => setEditAction({ ...editAction, outputStyle: e.target.value as Action.OutputStyle })}
                          className="mt-1 w-full px-3 py-2 border rounded-md text-sm"
                        >
                          <option value="SINGLE_CHILD">Single Child Node</option>
                          <option value="MULTIPLE_CHILDREN">Multiple Child Nodes</option>
                        </select>
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-medium">Options</label>
                        <div className="flex items-center gap-4 mt-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={editAction.useAncestors ?? action.useAncestors}
                              onChange={(e) => setEditAction({ ...editAction, useAncestors: e.target.checked })}
                              className="w-4 h-4"
                            />
                            <span className="text-sm">Use Ancestors</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={editAction.resolveContent ?? action.resolveContent}
                              onChange={(e) => setEditAction({ ...editAction, resolveContent: e.target.checked })}
                              className="w-4 h-4"
                            />
                            <span className="text-sm">Resolve Content</span>
                          </label>
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-2 justify-end pt-2">
                      <Button
                        variant="outline"
                        onClick={handleCancelEdit}
                        disabled={isUpdating}
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={handleSaveEdit}
                        disabled={isUpdating}
                        className="gap-2"
                      >
                        <Save className="w-4 h-4" />
                        {isUpdating ? 'Saving...' : 'Save Changes'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  // View Mode
                  <div>
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <h3 className="text-lg font-semibold mb-1">{action.name}</h3>
                        <p className="text-sm text-gray-600 whitespace-pre-wrap">{action.prompt}</p>
                      </div>
                      <div className="flex gap-2 ml-4">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleStartEdit(action)}
                          disabled={isUpdating || isDeleting}
                          className="h-8 w-8"
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(action.id)}
                          disabled={isUpdating || isDeleting}
                          className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="flex gap-4 text-xs text-gray-500">
                      <span className="px-2 py-1 bg-gray-100 rounded">
                        {action.outputStyle === 'SINGLE_CHILD' && 'Single Child'}
                        {action.outputStyle === 'MULTIPLE_CHILDREN' && 'Multiple Children'}
                      </span>
                      {action.useAncestors && (
                        <span className="px-2 py-1 bg-gray-100 rounded">Uses Ancestors</span>
                      )}
                      {action.resolveContent && (
                        <span className="px-2 py-1 bg-gray-100 rounded">Resolves Content</span>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
