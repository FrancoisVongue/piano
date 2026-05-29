'use client'

import { useRef, useState, useMemo } from 'react'
import { Plus, Trash2, Pencil, Check, X, FileText, Clock, Pin, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useArrangements } from '../hooks/useArrangements'
import { useAuth } from '@/domain/auth/hooks/useAuth'
import { cn } from '@/lib/utils'
import { Arrangement } from '@piano/shared'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'

interface SidebarProps {
  arrangements: Arrangement.Model[]
  selectedId: string | null
  onSelectArrangement: (id: string) => void
}

export function Sidebar({ arrangements, selectedId, onSelectArrangement }: SidebarProps) {
  const { createArrangement, updateArrangement, deleteArrangement, importArrangement, isCreating, isUpdating, isDeleting, isImporting } = useArrangements()
  const { user, signOut } = useAuth()

  const [isCreatingNew, setIsCreatingNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  // Hidden file input drives the "Import" button without rendering a full dialog
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Reset so selecting the same file twice still triggers onChange
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const raw = JSON.parse(text)
      const result = await importArrangement(raw as Arrangement.ExportDoc.Document)
      if (result.success) {
        toast.success(`Imported "${result.data.title}"`)
        onSelectArrangement(result.data.id)
      } else {
        toast.error(`Import failed: ${result.error}`)
      }
    } catch (err) {
      toast.error(`Invalid JSON: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const handleCreate = async () => {
    if (!newTitle.trim() || isCreating) return

    const result = await createArrangement(newTitle.trim())
    if (result.success) {
      setNewTitle('')
      setIsCreatingNew(false)
    }
  }

  const handleCancelCreate = () => {
    setIsCreatingNew(false)
    setNewTitle('')
  }

  const handleStartEdit = (arrangement: Arrangement.Model) => {
    setEditingId(arrangement.id)
    setEditValue(arrangement.title)
  }

  const handleSaveEdit = async (id: string) => {
    if (!editValue.trim() || isUpdating) return
    
    const result = await updateArrangement(id, { title: editValue.trim() })
    if (result.success) {
      setEditingId(null)
      setEditValue('')
    }
  }

  const handleTogglePin = async (id: string, currentPinned: boolean) => {
    if (isUpdating) return
    const result = await updateArrangement(id, { pinned: !currentPinned })
    if (!result.success) {
      console.error('Failed to toggle pin:', result.error)
    }
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditValue('')
  }

  const handleDelete = async (id: string) => {
    if (isDeleting) return
    
    // Confirm deletion
    if (!confirm('Are you sure you want to delete this project?')) return
    
    await deleteArrangement(id)
  }

  const formatLastUpdated = (date: Date) => {
    try {
      return formatDistanceToNow(new Date(date), { addSuffix: true })
    } catch {
      return 'recently'
    }
  }

  const getNoteCount = (arrangement: any) => {
    return arrangement._count?.notes || 0
  }

  // Sort and filter arrangements: pinned first, then by updatedAt, then filter by search
  const sortedArrangements = useMemo(() => {
    return [...arrangements]
      .filter(a => a.title.toLowerCase().includes(searchQuery.toLowerCase()))
      .sort((a, b) => {
        // Pinned items first
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        // Then by most recently updated
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      })
  }, [arrangements, searchQuery])

  // Group pinned and unpinned for separator
  const pinnedArrangements = sortedArrangements.filter(a => a.pinned)
  const unpinnedArrangements = sortedArrangements.filter(a => !a.pinned)

  return (
    <div className="w-72 bg-gradient-to-b from-gray-50 to-white border-r border-gray-200 flex flex-col shadow-sm">
      {/* Header */}
      <div className="p-6 border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Piano</h1>
            <p className="text-xs text-gray-500 mt-0.5">Your AI canvas</p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={handleImportClick}
              disabled={isImporting}
              title="Import arrangement from JSON"
              className="shadow-sm"
            >
              <Upload className="w-4 h-4" />
            </Button>
            <Button
              size="sm"
              onClick={() => setIsCreatingNew(true)}
              disabled={isCreatingNew}
              className="shadow-sm"
            >
              <Plus className="w-4 h-4 mr-1" />
              New
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleFileSelected}
          />
        </div>

        {/* Create new arrangement form */}
        {isCreatingNew && (
          <div className="space-y-2 mt-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
            <Input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Project title..."
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') handleCancelCreate()
              }}
              className="bg-white"
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleCreate}
                disabled={!newTitle.trim() || isCreating}
                className="flex-1"
              >
                {isCreating ? 'Creating...' : 'Create'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancelCreate}
                disabled={isCreating}
                className="flex-1 bg-white"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Search section */}
      <div className="px-3 py-3 border-b border-gray-100">
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search arrangements..."
          className="text-sm"
        />
      </div>

      {/* Arrangements list */}
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {arrangements.length === 0 ? (
          <div className="text-center py-12 px-4">
            <FileText className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500 mb-1">No arrangements yet</p>
            <p className="text-xs text-gray-400">Click &ldquo;New&rdquo; to create one</p>
          </div>
        ) : (
          <div className="space-y-2">
            {pinnedArrangements.map((arrangement) => {
              const isSelected = selectedId === arrangement.id
              const isEditing = editingId === arrangement.id
              const noteCount = getNoteCount(arrangement)

              return (
                <div
                  key={arrangement.id}
                  className={cn(
                    "group rounded-lg border transition-all duration-200",
                    isSelected
                      ? "bg-white shadow-md border-blue-200 ring-2 ring-blue-100"
                      : "bg-white/60 border-gray-200 hover:bg-white hover:shadow-sm hover:border-gray-300"
                  )}
                >
                  {isEditing ? (
                    // Edit mode
                    <div className="p-3 space-y-2">
                      <Input
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveEdit(arrangement.id)
                          if (e.key === 'Escape') handleCancelEdit()
                        }}
                        className="text-sm"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleSaveEdit(arrangement.id)}
                          disabled={!editValue.trim() || isUpdating}
                          className="flex-1 h-7 text-xs"
                        >
                          <Check className="w-3 h-3 mr-1" />
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleCancelEdit}
                          disabled={isUpdating}
                          className="flex-1 h-7 text-xs"
                        >
                          <X className="w-3 h-3 mr-1" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    // Display mode
                    <div
                      onClick={() => onSelectArrangement(arrangement.id)}
                      className="p-3 cursor-pointer"
                    >
                      {/* Title and actions */}
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <h3 className={cn(
                          "text-sm font-semibold truncate flex-1",
                          isSelected ? "text-gray-900" : "text-gray-700"
                        )}>
                          {arrangement.title}
                        </h3>
                        <div className={cn(
                          "flex items-center gap-1 transition-opacity",
                          isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                        )}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 hover:bg-blue-50"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleTogglePin(arrangement.id, arrangement.pinned)
                            }}
                            title={arrangement.pinned ? 'Unpin' : 'Pin'}
                          >
                            <Pin className={cn(
                              "w-3.5 h-3.5",
                              arrangement.pinned ? "fill-current text-blue-600" : "text-gray-600"
                            )} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 hover:bg-gray-100"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleStartEdit(arrangement)
                            }}
                            title="Rename"
                          >
                            <Pencil className="w-3.5 h-3.5 text-gray-600" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 hover:bg-red-50"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDelete(arrangement.id)
                            }}
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-red-600" />
                          </Button>
                        </div>
                      </div>

                      {/* Metadata */}
                      <div className="flex items-center gap-3 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <FileText className="w-3 h-3" />
                          {noteCount} {noteCount === 1 ? 'note' : 'notes'}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatLastUpdated(arrangement.updatedAt)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            
            {/* Separator between pinned and unpinned */}
            {pinnedArrangements.length > 0 && unpinnedArrangements.length > 0 && (
              <div className="py-2">
                <div className="border-t border-gray-200" />
              </div>
            )}
            
            {unpinnedArrangements.map((arrangement) => {
              const isSelected = selectedId === arrangement.id
              const isEditing = editingId === arrangement.id
              const noteCount = getNoteCount(arrangement)

              return (
                <div
                  key={arrangement.id}
                  className={cn(
                    "group rounded-lg border transition-all duration-200",
                    isSelected
                      ? "bg-white shadow-md border-blue-200 ring-2 ring-blue-100"
                      : "bg-white/60 border-gray-200 hover:bg-white hover:shadow-sm hover:border-gray-300"
                  )}
                >
                  {isEditing ? (
                    // Edit mode
                    <div className="p-3 space-y-2">
                      <Input
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveEdit(arrangement.id)
                          if (e.key === 'Escape') handleCancelEdit()
                        }}
                        className="text-sm"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleSaveEdit(arrangement.id)}
                          disabled={!editValue.trim() || isUpdating}
                          className="flex-1 h-7 text-xs"
                        >
                          <Check className="w-3 h-3 mr-1" />
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleCancelEdit}
                          disabled={isUpdating}
                          className="flex-1 h-7 text-xs"
                        >
                          <X className="w-3 h-3 mr-1" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    // Display mode
                    <div
                      onClick={() => onSelectArrangement(arrangement.id)}
                      className="p-3 cursor-pointer"
                    >
                      {/* Title and actions */}
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <h3 className={cn(
                          "text-sm font-semibold truncate flex-1",
                          isSelected ? "text-gray-900" : "text-gray-700"
                        )}>
                          {arrangement.title}
                        </h3>
                        <div className={cn(
                          "flex items-center gap-1 transition-opacity",
                          isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                        )}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 hover:bg-blue-50"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleTogglePin(arrangement.id, arrangement.pinned)
                            }}
                            title={arrangement.pinned ? 'Unpin' : 'Pin'}
                          >
                            <Pin className={cn(
                              "w-3.5 h-3.5",
                              arrangement.pinned ? "fill-current text-blue-600" : "text-gray-600"
                            )} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 hover:bg-gray-100"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleStartEdit(arrangement)
                            }}
                            title="Rename"
                          >
                            <Pencil className="w-3.5 h-3.5 text-gray-600" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 hover:bg-red-50"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDelete(arrangement.id)
                            }}
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-red-600" />
                          </Button>
                        </div>
                      </div>

                      {/* Metadata */}
                      <div className="flex items-center gap-3 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <FileText className="w-3 h-3" />
                          {noteCount} {noteCount === 1 ? 'note' : 'notes'}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatLastUpdated(arrangement.updatedAt)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* User section */}
      <div className="p-4 border-t border-gray-200 bg-white">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center shadow-sm">
            <span className="text-sm font-bold text-white">
              {user?.email?.charAt(0)?.toUpperCase() || 'U'}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">
              {user?.name || 'User'}
            </p>
            <p className="text-xs text-gray-500 truncate">
              {user?.email || ''}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={signOut}
            className="text-xs"
          >
            Sign Out
          </Button>
        </div>
      </div>
    </div>
  )
}
