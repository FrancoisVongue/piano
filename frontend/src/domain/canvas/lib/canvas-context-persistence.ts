// Per-arrangement persistence of layer-context state. Key: `piano:lc:<id>`.

export interface SavedCanvasContext {
  activeLayer: string | null
  visibleLayers: string[]
  knownLayers: string[]
  globalVisible: boolean
}

const PREFIX = 'piano:lc:'
const keyFor = (id: string) => `${PREFIX}${id}`

export const readCanvasContext = (arrangementId: string): SavedCanvasContext | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(keyFor(arrangementId))
    if (!raw) return null
    const p = JSON.parse(raw)
    const onlyStrings = (xs: unknown): string[] =>
      Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string') : []
    return {
      activeLayer: typeof p?.activeLayer === 'string' ? p.activeLayer : null,
      visibleLayers: onlyStrings(p?.visibleLayers),
      knownLayers: onlyStrings(p?.knownLayers),
      // Default true so older entries (written before this field existed)
      // don't silently hide every global note.
      globalVisible: typeof p?.globalVisible === 'boolean' ? p.globalVisible : true,
    }
  } catch {
    return null
  }
}

export const writeCanvasContext = (arrangementId: string, ctx: SavedCanvasContext) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(keyFor(arrangementId), JSON.stringify(ctx))
  } catch {
    // QuotaExceeded etc — best-effort.
  }
}

export const clearCanvasContext = (arrangementId: string) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(keyFor(arrangementId))
  } catch {}
}
