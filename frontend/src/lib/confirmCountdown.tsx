'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Soft-confirm pattern: show a toast with a countdown progress bar and a
 * Cancel button; if the user does nothing, the action proceeds when the
 * timer hits zero. Lighter weight than a modal dialog — the user keeps
 * control over the canvas while deciding.
 *
 * Use this in place of `window.confirm` / a Dialog when:
 *   - the action is expensive but reversible-ish (AI fan-out across N nodes)
 *   - blocking the user with a modal is overkill but you still want a
 *     "wait, no!" window before committing
 *
 * Idiomatic call site:
 *   const message = `Run X on ${n} nodes`
 *   const proceed = await confirmCountdown({ message })
 *   if (!proceed) return
 *   await doTheThing()
 *
 * Resolves `true` on timeout (proceed) or `false` on Cancel / unmount.
 * Safe to await many times in parallel — each call gets its own toast.
 */
export async function confirmCountdown(opts: {
  message: string
  /** Default 3000ms — long enough to react, short enough not to feel like a modal. */
  delayMs?: number
}): Promise<boolean> {
  const { message, delayMs = 3000 } = opts
  return new Promise<boolean>((resolve) => {
    let resolved = false
    const finish = (proceed: boolean) => {
      if (resolved) return
      resolved = true
      toast.dismiss(id)
      resolve(proceed)
    }

    const id = toast.custom(
      () => (
        <CountdownToast
          message={message}
          delayMs={delayMs}
          onCancel={() => finish(false)}
          onTimeout={() => finish(true)}
        />
      ),
      // Sonner needs a duration; we always dismiss manually first via finish().
      // The +1000 buffer is a safety net so sonner never reaps the toast
      // while our timer is still pending.
      { duration: delayMs + 1000 },
    )
  })
}

interface CountdownToastProps {
  message: string
  delayMs: number
  onCancel: () => void
  onTimeout: () => void
}

function CountdownToast({ message, delayMs, onCancel, onTimeout }: CountdownToastProps) {
  const startedAt = useRef(Date.now())
  const [remaining, setRemaining] = useState(delayMs)
  // Latest callbacks in a ref so the rAF loop never closes over a stale
  // `onTimeout`. Keeps the effect dep list at [delayMs] — single subscription.
  const cbs = useRef({ onCancel, onTimeout })
  cbs.current = { onCancel, onTimeout }

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const left = Math.max(0, delayMs - (Date.now() - startedAt.current))
      setRemaining(left)
      if (left <= 0) {
        cbs.current.onTimeout()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      // If we unmount before the timer finishes (route change, manual
      // toast.dismiss elsewhere, etc.), default to "cancel" so callers
      // never silently fire after the user moved on. Idempotent — the
      // outer Promise's `resolved` flag dedupes.
      cbs.current.onCancel()
    }
  }, [delayMs])

  const pct = (remaining / delayMs) * 100

  return (
    <div className="relative w-[360px] overflow-hidden rounded-lg border border-amber-200 bg-white shadow-lg">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 text-sm text-gray-800">{message}</div>
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          className="h-7 gap-1 text-xs"
        >
          <X className="h-3 w-3" />
          Cancel ({Math.ceil(remaining / 1000)}s)
        </Button>
      </div>
      <div
        className="absolute bottom-0 left-0 h-0.5 bg-amber-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
