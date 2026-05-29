/**
 * Per-arrangement collapse persistence — localStorage-only.
 *
 * Mirrors viewport-persistence: device-local, no schema change. When you
 * collapse a subtree on this machine, that decision survives a reload.
 *
 * What gets stored:
 *   - `hidden`: ids the user has hidden (the actual visibility flags the
 *     canvas reads).
 *   - `states`: per-node button cycle position ('recursive' | 'single'),
 *     so the collapse button shows the right glyph after reload.
 *
 * Key format: `piano:cx:<arrangementId>` — `cx` for "collapse".
 */

export interface SavedCollapse {
  hidden: string[]
  states: Array<[string, 'recursive' | 'single']>
}

const PREFIX = 'piano:cx:'
const keyFor = (id: string) => `${PREFIX}${id}`

export const readSavedCollapse = (arrangementId: string): SavedCollapse | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(keyFor(arrangementId))
    if (!raw) return null
    const p = JSON.parse(raw)
    if (!p || !Array.isArray(p.hidden) || !Array.isArray(p.states)) return null
    return {
      hidden: p.hidden.filter((x: unknown) => typeof x === 'string'),
      states: p.states.filter((e: unknown) =>
        Array.isArray(e) &&
        typeof e[0] === 'string' &&
        (e[1] === 'recursive' || e[1] === 'single'),
      ),
    }
  } catch {
    return null
  }
}

export const writeSavedCollapse = (arrangementId: string, c: SavedCollapse) => {
  if (typeof window === 'undefined') return
  try {
    // Empty state → remove the key so localStorage doesn't accumulate
    // dead entries for arrangements the user has fully expanded.
    if (c.hidden.length === 0 && c.states.length === 0) {
      window.localStorage.removeItem(keyFor(arrangementId))
      return
    }
    window.localStorage.setItem(keyFor(arrangementId), JSON.stringify(c))
  } catch {
    // QuotaExceeded or storage disabled — best-effort, never throw.
  }
}

export const clearSavedCollapse = (arrangementId: string) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(keyFor(arrangementId))
  } catch {
    // best-effort
  }
}

/**
 * Drop entries for arrangements the user no longer has access to. Called
 * once per session after the arrangement list loads (same lifecycle hook
 * as pruneStaleViewports).
 */
export const pruneStaleCollapse = (knownIds: Set<string>) => {
  if (typeof window === 'undefined') return
  try {
    const toRemove: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      const id = key.slice(PREFIX.length)
      if (!knownIds.has(id)) toRemove.push(key)
    }
    for (const key of toRemove) window.localStorage.removeItem(key)
  } catch {
    // best-effort
  }
}
