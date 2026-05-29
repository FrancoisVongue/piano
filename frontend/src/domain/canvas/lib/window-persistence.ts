/**
 * Per-arrangement window persistence — localStorage-only.
 *
 * Stores the user's open/minimized edit windows for this machine. The payload
 * only references node ids and window geometry; node content remains in the
 * normal canvas state.
 *
 * Key format: `piano:win:<arrangementId>`.
 */

export type SavedWindowMode = 'open' | 'minimized' | 'maximized'

export interface SavedCanvasWindow {
  id: string
  tabNodeIds: string[]
  activeNodeId: string
  position: { x: number; y: number }
  size: { width: number; height: number }
  state: SavedWindowMode
  zIndex: number
  tabLayout: 'horizontal' | 'vertical'
  groupId: string | null
}

export interface SavedCanvasWindows {
  windows: SavedCanvasWindow[]
  activeWindowId: string | null
  groupNames: Record<string, string>
  lastWindowBlueprint: {
    size: { width: number; height: number }
    position: { x: number; y: number }
  } | null
}

const PREFIX = 'piano:win:'
const keyFor = (id: string) => `${PREFIX}${id}`

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const parseWindow = (value: unknown): SavedCanvasWindow | null => {
  if (!value || typeof value !== 'object') return null
  const w = value as Partial<SavedCanvasWindow>
  if (
    typeof w.id !== 'string' ||
    !Array.isArray(w.tabNodeIds) ||
    typeof w.activeNodeId !== 'string' ||
    !w.position ||
    !isNumber(w.position.x) ||
    !isNumber(w.position.y) ||
    !w.size ||
    !isNumber(w.size.width) ||
    !isNumber(w.size.height) ||
    (w.state !== 'open' && w.state !== 'minimized' && w.state !== 'maximized') ||
    !isNumber(w.zIndex) ||
    (w.tabLayout !== 'horizontal' && w.tabLayout !== 'vertical') ||
    (w.groupId !== null && typeof w.groupId !== 'string')
  ) {
    return null
  }
  const tabNodeIds = w.tabNodeIds.filter((id): id is string => typeof id === 'string')
  if (tabNodeIds.length === 0 || !tabNodeIds.includes(w.activeNodeId)) return null
  return {
    id: w.id,
    tabNodeIds,
    activeNodeId: w.activeNodeId,
    position: w.position,
    size: w.size,
    state: w.state,
    zIndex: w.zIndex,
    tabLayout: w.tabLayout,
    groupId: w.groupId,
  }
}

export const readSavedWindows = (arrangementId: string): SavedCanvasWindows | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(keyFor(arrangementId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.windows)) return null
    const groupNames =
      parsed.groupNames && typeof parsed.groupNames === 'object'
        ? Object.fromEntries(Object.entries(parsed.groupNames).filter((entry): entry is [string, string] =>
            typeof entry[0] === 'string' && typeof entry[1] === 'string',
          ))
        : {}
    const blueprint = parsed.lastWindowBlueprint
    const lastWindowBlueprint =
      blueprint &&
      blueprint.size &&
      blueprint.position &&
      isNumber(blueprint.size.width) &&
      isNumber(blueprint.size.height) &&
      isNumber(blueprint.position.x) &&
      isNumber(blueprint.position.y)
        ? {
            size: { width: blueprint.size.width, height: blueprint.size.height },
            position: { x: blueprint.position.x, y: blueprint.position.y },
          }
        : null
    return {
      windows: parsed.windows.map(parseWindow).filter((w): w is SavedCanvasWindow => !!w),
      activeWindowId: typeof parsed.activeWindowId === 'string' ? parsed.activeWindowId : null,
      groupNames,
      lastWindowBlueprint,
    }
  } catch {
    return null
  }
}

export const writeSavedWindows = (arrangementId: string, state: SavedCanvasWindows) => {
  if (typeof window === 'undefined') return
  try {
    if (state.windows.length === 0 && !state.lastWindowBlueprint) {
      window.localStorage.removeItem(keyFor(arrangementId))
      return
    }
    window.localStorage.setItem(keyFor(arrangementId), JSON.stringify(state))
  } catch {
    // QuotaExceeded or storage disabled — best-effort, never throw.
  }
}

export const pruneStaleWindows = (knownIds: Set<string>) => {
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
