'use client'

import React, { useEffect, useState } from 'react'
import { create } from 'zustand'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Imperative destructive-confirm modal. Replaces `confirmCountdown` for
// actions where:
//   - the user might miss a 3-second auto-proceed,
//   - the action is irreversible (kills a daemon session, drops layout),
//   - "important work" might be lost if the user can't react in time.
//
// Idiomatic call site:
//   const proceed = await confirmDestructive({
//     title: 'Close terminal?',
//     description: 'Whatever is running in this pane will be lost.',
//     confirmLabel: 'Close terminal',
//   })
//   if (!proceed) return
//   await doTheThing()
//
// One ConfirmDialogHost lives globally in providers.tsx and renders the
// modal when an awaiter is in flight. The store holds a single pending
// confirm — if a second call comes in while one is open, it's queued and
// shown after the first resolves (so two rapid X-clicks don't stack).

export type ConfirmOpts = {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  /** When true (default), the confirm button is styled as destructive (red). */
  destructive?: boolean
}

type Pending = {
  opts: ConfirmOpts
  resolve: (proceed: boolean) => void
}

type Store = {
  queue: Pending[]
  push: (p: Pending) => void
  pop: () => void
}

const useConfirmStore = create<Store>(set => ({
  queue: [],
  push: p => set(state => ({ queue: [...state.queue, p] })),
  pop: () => set(state => ({ queue: state.queue.slice(1) })),
}))

export function confirmDestructive(opts: ConfirmOpts): Promise<boolean> {
  return new Promise(resolve => {
    useConfirmStore.getState().push({ opts, resolve })
  })
}

// Rendered once in providers.tsx. Shows the head of the queue; pops on
// answer; Radix takes care of focus trap, esc-to-cancel, overlay click.
export function ConfirmDialogHost() {
  const head = useConfirmStore(s => s.queue[0])
  const pop = useConfirmStore(s => s.pop)
  // Local open state so AlertDialog can play its exit animation before we
  // pop the queue and (potentially) immediately render the next pending
  // entry. Without this the next dialog hijacks the same instance mid-anim.
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (head) setOpen(true)
  }, [head])

  if (!head) return null

  const { opts, resolve } = head
  const finish = (proceed: boolean) => {
    resolve(proceed)
    setOpen(false)
    // Give Radix ~200ms to play the exit animation; matches AlertDialog
    // `data-[state=closed]:duration-200`. After that, pop the queue —
    // the next pending entry (if any) flows through the effect above.
    window.setTimeout(pop, 200)
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) finish(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{opts.title}</AlertDialogTitle>
          {opts.description ? (
            <AlertDialogDescription>{opts.description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => finish(false)}>
            {opts.cancelLabel ?? 'Cancel'}
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              opts.destructive !== false
                ? buttonVariants({ variant: 'destructive' })
                : buttonVariants(),
            )}
            onClick={() => finish(true)}
          >
            {opts.confirmLabel ?? 'Confirm'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
