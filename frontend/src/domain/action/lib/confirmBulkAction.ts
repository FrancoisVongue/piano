import { confirmCountdown } from '@/lib/confirmCountdown'

// Threshold above which fanning an action across selected nodes asks for
// a 3s "wait, no!" window. Lives next to the helper so every call site
// agrees on the same UX rule — bumping it changes both the hotkey path
// and the dropdown path in one edit.
export const BULK_CONFIRM_THRESHOLD = 3

interface Args {
  actionName: string
  count: number
}

/**
 * Soft-confirm before running an action across many nodes. Auto-skips
 * the toast when count is below threshold (returns true immediately) so
 * single-node runs feel instant. Returns true on proceed, false on cancel.
 */
export async function confirmBulkAction({ actionName, count }: Args): Promise<boolean> {
  if (count < BULK_CONFIRM_THRESHOLD) return true
  const message = `Running ${actionName} on ${count} nodes`
  return confirmCountdown({ message })
}
