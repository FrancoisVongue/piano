/**
 * Per-arrangement viewport persistence — localStorage-only.
 *
 * Device-local by design: "when I come back to this arrangement on this
 * machine, put me where I left off." No schema change, no multi-device
 * conflict — the simplest thing that works.
 *
 * Key format: `piano:vp:<arrangementId>` (shortened from the original
 * `piano:viewport:*` prefix to save a few bytes per entry).
 *
 * Value: `{ x, y, zoom }` — the three numbers React Flow's setViewport needs.
 */

export interface SavedViewport {
  x: number
  y: number
  zoom: number
}

const PREFIX = 'piano:vp:'
const keyFor = (id: string) => `${PREFIX}${id}`

export const readSavedViewport = (arrangementId: string): SavedViewport | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(keyFor(arrangementId))
    if (!raw) return null
    const p = JSON.parse(raw)
    return typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.zoom === 'number'
      ? { x: p.x, y: p.y, zoom: p.zoom }
      : null
  } catch {
    return null
  }
}

export const writeSavedViewport = (arrangementId: string, vp: SavedViewport) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(keyFor(arrangementId), JSON.stringify(vp))
  } catch {
    // QuotaExceeded or storage disabled — best-effort, never throw.
  }
}

export const clearSavedViewport = (arrangementId: string) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(keyFor(arrangementId))
  } catch {
    // best-effort
  }
}

/**
 * Remove viewport entries for arrangements that no longer exist, and clean
 * up legacy keys from the old `piano:viewport:*` prefix.
 * Call once per session (e.g., after the arrangement list loads) to keep
 * localStorage from growing unbounded.
 *
 * @param knownIds — IDs of arrangements the user still has access to.
 */
export const pruneStaleViewports = (knownIds: Set<string>) => {
  if (typeof window === 'undefined') return
  try {
    const toRemove: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      const id = key.slice(PREFIX.length)
      if (!knownIds.has(id)) toRemove.push(key)
    }
    // Also clean up legacy keys from the old prefix (piano:viewport:*)
    const LEGACY_PREFIX = 'piano:viewport:'
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key?.startsWith(LEGACY_PREFIX)) toRemove.push(key)
    }

    for (const key of toRemove) window.localStorage.removeItem(key)
  } catch {
    // best-effort
  }
}
