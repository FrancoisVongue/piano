'use client'

import React from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import * as VisuallyHidden from '@radix-ui/react-visually-hidden'

// ImagePreviewDialog — lightbox for an inline image preview. Click an image
// thumbnail in FilePreview to open it at 90vw × 90vh; click outside or hit
// Escape to close (the underlying shadcn Dialog handles both).
//
// The image is rendered with `object-contain` so its aspect ratio is
// preserved without cropping; the dialog's padding shows the dark backdrop
// on whichever axis is shorter.
type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string
  alt: string
}

export function ImagePreviewDialog({ open, onOpenChange, src, alt }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Override shadcn DialogContent's default `display: grid` to `flex`.
          The base grid uses `auto` row sizing, so a tall image with
          `h-full` makes its row size to natural height and overflows the
          90vh container downward. Flex with items/justify-center + the
          image's own max-h-full / max-w-full does the canonical lightbox
          layout: contain inside the box, centered, no overflow. */}
      <DialogContent
        className="flex h-[90vh] w-[90vw] max-w-none items-center justify-center gap-0 border-0 bg-black/95 p-0"
        onClick={() => onOpenChange(false)}
      >
        {/* Radix requires a title for a11y; visually hide it — the filename
            already appears in the preview header below the dialog. */}
        <VisuallyHidden.Root>
          <DialogTitle>{alt}</DialogTitle>
        </VisuallyHidden.Root>
        <img
          src={src}
          alt={alt}
          className="max-h-full max-w-full select-none object-contain"
          draggable={false}
        />
      </DialogContent>
    </Dialog>
  )
}
