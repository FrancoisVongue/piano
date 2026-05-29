'use client'

import React, { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { TagsEditor } from '@/components/TagsEditor'
import { Arrangement } from '@piano/shared'

interface ArrangementTagsDialogProps {
  open: boolean
  arrangement: Arrangement.Model | null
  allTags: string[]
  onClose: () => void
  onSave: (id: string, tags: string[]) => Promise<void> | void
}

/**
 * Modal wrapper around the shared `TagsEditor` for editing an arrangement's tags.
 * Opens from the sidebar's "Edit tags..." menu item.
 */
export function ArrangementTagsDialog({
  open,
  arrangement,
  allTags,
  onClose,
  onSave,
}: ArrangementTagsDialogProps) {
  const [draft, setDraft] = useState<string[]>([])
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (arrangement) setDraft(arrangement.tags ?? [])
  }, [arrangement])

  const handleSave = async () => {
    if (!arrangement) return
    setIsSaving(true)
    try {
      await onSave(arrangement.id, draft)
      onClose()
    } finally {
      setIsSaving(false)
    }
  }

  if (!arrangement) return null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tags — {arrangement.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <TagsEditor
            value={draft}
            onChange={setDraft}
            autoFocus
            placeholder="Type a tag and press Enter…"
            suggestions={allTags}
          />
          <p className="text-xs text-muted-foreground">
            Tags help you filter and group arrangements. Press <kbd className="px-1 py-0.5 rounded bg-gray-100 border">Enter</kbd> or
            <kbd className="px-1 py-0.5 rounded bg-gray-100 border">,</kbd> to add. Click × to remove.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
