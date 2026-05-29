/**
 * LOD shared constants and runtime zoom reference.
 *
 * `LOD_THRESHOLD` is the effective scale (canvasZoom × nodeScale) below
 * which a node renders its low-detail variant. One constant, one source.
 *
 * `currentZoomRef` is a tiny mutable cell that ZoomTracker writes each
 * RAF tick. Any code that needs the current zoom for a *one-shot* read
 * (e.g. a node deciding its own LOD bucket on resize while pan/zoom
 * hasn't fired) reads `currentZoomRef.current` instead of
 * `getComputedStyle()` — the latter flushes layout, this is a JS
 * property read. Don't subscribe to it — by design it has no notify
 * mechanism; for reactive zoom, use the DOM `data-low-detail` attribute
 * that ZoomTracker also maintains.
 */
export const LOD_THRESHOLD = 0.45

export const currentZoomRef = { current: 1 }

type LodEntry = {
  el: HTMLElement
  threshold: number
  low: boolean
}

const entriesByElement = new Map<HTMLElement, LodEntry>()
let sortedEntries: LodEntry[] = []
let sortedDirty = false

function thresholdForScale(scale: number): number {
  const normalized = Number.isFinite(scale) && scale > 0 ? scale : 1
  return LOD_THRESHOLD / normalized
}

function markSortedDirty(): void {
  sortedDirty = true
}

function ensureSorted(): LodEntry[] {
  if (!sortedDirty) return sortedEntries
  sortedEntries = Array.from(entriesByElement.values()).sort((a, b) => a.threshold - b.threshold)
  sortedDirty = false
  return sortedEntries
}

function upperBound(entries: LodEntry[], value: number): number {
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (entries[mid].threshold <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function applyLowDetail(entry: LodEntry, low: boolean): void {
  if (entry.low === low && entry.el.hasAttribute('data-low-detail') === low) return
  entry.low = low
  entry.el.toggleAttribute('data-low-detail', low)
}

export function registerLodNode(el: HTMLElement, scale: number): () => void {
  const threshold = thresholdForScale(scale)
  const low = currentZoomRef.current < threshold
  const entry: LodEntry = { el, threshold, low }

  entriesByElement.set(el, entry)
  markSortedDirty()
  el.toggleAttribute('data-low-detail', low)

  return () => {
    if (entriesByElement.get(el) !== entry) return
    entriesByElement.delete(el)
    markSortedDirty()
  }
}

export function syncLodForZoom(zoom: number): void {
  const previousZoom = currentZoomRef.current
  currentZoomRef.current = zoom

  if (zoom === previousZoom || entriesByElement.size === 0) return

  const entries = ensureSorted()
  if (zoom < previousZoom) {
    // Newly low-detail: threshold is now above zoom, but was not above
    // the previous zoom.
    const start = upperBound(entries, zoom)
    const end = upperBound(entries, previousZoom)
    for (let i = start; i < end; i++) applyLowDetail(entries[i], true)
    return
  }

  // Newly full-detail: threshold is no longer above zoom.
  const start = upperBound(entries, previousZoom)
  const end = upperBound(entries, zoom)
  for (let i = start; i < end; i++) applyLowDetail(entries[i], false)
}
