'use client'

import { useState, useEffect } from 'react'
import { Plus, Edit2, Trash2, Save, X, Combine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useUnifiersStore } from '@/domain/unifier/store'
import { Unifier } from '@piano/shared'
import { cn } from '@/lib/utils'

export default function UnifiersPage() {
  const unifiers = useUnifiersStore(state => state.unifiers)
  const isLoading = useUnifiersStore(state => state.isLoading)
  const createUnifier = useUnifiersStore(state => state.createUnifier)
  const updateUnifier = useUnifiersStore(state => state.updateUnifier)
  const deleteUnifier = useUnifiersStore(state => state.deleteUnifier)
  const isCreating = useUnifiersStore(state => state.isCreating)
  const isUpdating = useUnifiersStore(state => state.isUpdating)
  const isDeleting = useUnifiersStore(state => state.isDeleting)
  const fetchUnifiers = useUnifiersStore(state => state.fetchUnifiers)

  const [isCreatingNew, setIsCreatingNew] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Form state for create
  const [newUnifier, setNewUnifier] = useState<Unifier.DTO.Create>({
    name: '',
    prompt: '',
    outputStyle: 'SINGLE_NODE',
  })

  // Form state for edit
  const [editUnifier, setEditUnifier] = useState<Unifier.DTO.Update>({})

  // Fetch unifiers on mount
  useEffect(() => {
    fetchUnifiers()
  }, [fetchUnifiers])

  const handleCreate = async () => {
    if (!newUnifier.name.trim() || !newUnifier.prompt.trim()) return

    const result = await createUnifier(newUnifier)
    if (result.success) {
      setNewUnifier({
        name: '',
        prompt: '',
        outputStyle: 'SINGLE_NODE',
      })
      setIsCreatingNew(false)
    }
  }

  const handleStartEdit = (unifier: Unifier.Model) => {
    setEditingId(unifier.id)
    setEditUnifier({
      name: unifier.name,
      prompt: unifier.prompt,
      outputStyle: unifier.outputStyle,
    })
  }

  const handleSaveEdit = async () => {
    if (!editingId) return

    const result = await updateUnifier(editingId, editUnifier)
    if (result.success) {
      setEditingId(null)
      setEditUnifier({})
    }
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditUnifier({})
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this unifier?')) return
    await deleteUnifier(id)
  }

  if (isLoading) {
    return (
      <main className="flex-1 flex items-center justify-center bg-white">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-sm text-gray-600">Loading unifiers...</p>
        </div>
      </main>
    )
  }

  return (
    <main className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Header */}
      <div className="p-2 border-b flex items-center justify-between bg-card shrink-0">
        <div className="flex items-center gap-2">
          <Combine className="w-4 h-4" />
          <span className="text-sm font-semibold">Unifiers</span>
        </div>
        {!isCreatingNew && (
          <Button onClick={() => setIsCreatingNew(true)} size="sm" className="gap-2">
            <Plus className="w-4 h-4" />
            New Unifier
          </Button>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6 max-w-5xl w-full mx-auto">
        {/* Create Form */}
        {isCreatingNew && (
          <Card className="p-6 mb-6 border-2 border-black">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Create New Unifier</h3>
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
                  value={newUnifier.name}
                  onChange={(e) => setNewUnifier({ ...newUnifier, name: e.target.value })}
                  placeholder="e.g., Summarize All, Find Intersection, Group by Topic"
                  className="mt-1"
                  autoFocus
                />
              </div>

              <div>
                <label htmlFor="new-prompt" className="text-sm font-medium">Prompt</label>
                <Textarea
                  id="new-prompt"
                  value={newUnifier.prompt}
                  onChange={(e) => setNewUnifier({ ...newUnifier, prompt: e.target.value })}
                  placeholder="e.g., Synthesize the following notes into a single comprehensive summary..."
                  className="mt-1 min-h-[120px]"
                />
                <p className="text-xs text-gray-500 mt-1">
                  When executing, you can add additional context specific to the selected notes.
                </p>
              </div>

              <div>
                <label htmlFor="new-output-style" className="text-sm font-medium">Output Style</label>
                <select
                  id="new-output-style"
                  value={newUnifier.outputStyle}
                  onChange={(e) => setNewUnifier({ ...newUnifier, outputStyle: e.target.value as Unifier.OutputStyle })}
                  className="mt-1 w-full px-3 py-2 border rounded-md text-sm"
                >
                  <option value="SINGLE_NODE">Single Node (Summarize, Synthesize)</option>
                  <option value="MULTIPLE_NODES">Multiple Nodes (Group, Categorize)</option>
                </select>
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
                  disabled={!newUnifier.name.trim() || !newUnifier.prompt.trim() || isCreating}
                >
                  {isCreating ? 'Creating...' : 'Create Unifier'}
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Unifiers List */}
        {unifiers.length === 0 && !isCreatingNew ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Combine className="w-8 h-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No unifiers yet</h3>
            <p className="text-gray-500 mb-6">Create your first unifier to synthesize multiple notes</p>
            <Button onClick={() => setIsCreatingNew(true)} className="gap-2">
              <Plus className="w-4 h-4" />
              Create Unifier
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {unifiers.map((unifier) => (
              <Card
                key={unifier.id}
                className={cn(
                  "p-6 transition-all",
                  editingId === unifier.id && "border-2 border-black"
                )}
              >
                {editingId === unifier.id ? (
                  // Edit Mode
                  <div className="space-y-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-lg font-semibold">Edit Unifier</h3>
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
                      <label htmlFor={`edit-name-${unifier.id}`} className="text-sm font-medium">Name</label>
                      <Input
                        id={`edit-name-${unifier.id}`}
                        value={editUnifier.name || ''}
                        onChange={(e) => setEditUnifier({ ...editUnifier, name: e.target.value })}
                        className="mt-1"
                      />
                    </div>

                    <div>
                      <label htmlFor={`edit-prompt-${unifier.id}`} className="text-sm font-medium">Prompt</label>
                      <Textarea
                        id={`edit-prompt-${unifier.id}`}
                        value={editUnifier.prompt || ''}
                        onChange={(e) => setEditUnifier({ ...editUnifier, prompt: e.target.value })}
                        className="mt-1 min-h-[120px]"
                      />
                    </div>

                    <div>
                      <label htmlFor={`edit-output-${unifier.id}`} className="text-sm font-medium">Output Style</label>
                      <select
                        id={`edit-output-${unifier.id}`}
                        value={editUnifier.outputStyle || unifier.outputStyle}
                        onChange={(e) => setEditUnifier({ ...editUnifier, outputStyle: e.target.value as Unifier.OutputStyle })}
                        className="mt-1 w-full px-3 py-2 border rounded-md text-sm"
                      >
                        <option value="SINGLE_NODE">Single Node (Summarize, Synthesize)</option>
                        <option value="MULTIPLE_NODES">Multiple Nodes (Group, Categorize)</option>
                      </select>
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
                        <h3 className="text-lg font-semibold mb-1">{unifier.name}</h3>
                        <p className="text-sm text-gray-600 whitespace-pre-wrap">{unifier.prompt}</p>
                      </div>
                      <div className="flex gap-2 ml-4">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleStartEdit(unifier)}
                          disabled={isUpdating || isDeleting}
                          className="h-8 w-8"
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(unifier.id)}
                          disabled={isUpdating || isDeleting}
                          className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="flex gap-4 text-xs text-gray-500">
                      <span className="px-2 py-1 bg-gray-100 rounded">
                        {unifier.outputStyle === 'SINGLE_NODE' && 'Single Node'}
                        {unifier.outputStyle === 'MULTIPLE_NODES' && 'Multiple Nodes'}
                      </span>
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
