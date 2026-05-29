import { create } from 'zustand'

/**
 * Workspaces = viewport bookmarks per arrangement.
 *
 * Per-device by design: a "zoom 0.5 looks great" workspace on a 27" monitor
 * is wrong for a 13" laptop, so we deliberately don't sync these via the DB.
 * Backed by localStorage; cross-tab sync mirrors usePinnedToolsStore so a
 * second open tab reflects changes immediately.
 *
 * Up to 9 slots per arrangement, each optionally named.
 */

const STORAGE_KEY = 'piano:workspaces:v1'

export const SLOT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const
export type SlotKey = (typeof SLOT_KEYS)[number]

export interface Workspace {
  name?: string
  viewport: { x: number; y: number; zoom: number }
}

type ArrangementSlots = Partial<Record<SlotKey, Workspace>>
type StoredShape = Record<string, ArrangementSlots>

function loadFromStorage(): StoredShape {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as StoredShape) : {}
  } catch {
    return {}
  }
}

function saveToStorage(state: StoredShape) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* quota errors ignored — workspaces are nice-to-have */
  }
}

interface WorkspacesState {
  byArrangement: StoredShape
  save: (arrangementId: string, slot: SlotKey, viewport: Workspace['viewport']) => void
  rename: (arrangementId: string, slot: SlotKey, name: string) => void
  reset: (arrangementId: string, slot: SlotKey) => void
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  byArrangement: loadFromStorage(),

  save: (arrangementId, slot, viewport) => {
    const cur = get().byArrangement
    const existing = cur[arrangementId]?.[slot]
    const next: StoredShape = {
      ...cur,
      [arrangementId]: {
        ...(cur[arrangementId] ?? {}),
        // Preserve any user-given name when overwriting the viewport.
        [slot]: { name: existing?.name, viewport },
      },
    }
    saveToStorage(next)
    set({ byArrangement: next })
  },

  rename: (arrangementId, slot, name) => {
    const cur = get().byArrangement
    const existing = cur[arrangementId]?.[slot]
    if (!existing) return
    const trimmed = name.trim()
    const next: StoredShape = {
      ...cur,
      [arrangementId]: {
        ...(cur[arrangementId] ?? {}),
        [slot]: { ...existing, name: trimmed.length > 0 ? trimmed : undefined },
      },
    }
    saveToStorage(next)
    set({ byArrangement: next })
  },

  reset: (arrangementId, slot) => {
    const cur = get().byArrangement
    const arrSlots = cur[arrangementId]
    if (!arrSlots || !arrSlots[slot]) return
    const { [slot]: _, ...rest } = arrSlots
    const nextArrSlots = rest as ArrangementSlots
    const next: StoredShape =
      Object.keys(nextArrSlots).length === 0
        ? Object.fromEntries(Object.entries(cur).filter(([k]) => k !== arrangementId))
        : { ...cur, [arrangementId]: nextArrSlots }
    saveToStorage(next)
    set({ byArrangement: next })
  },
}))

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || e.newValue == null) return
    try {
      const parsed = JSON.parse(e.newValue)
      if (parsed && typeof parsed === 'object') {
        useWorkspacesStore.setState({ byArrangement: parsed as StoredShape })
      }
    } catch {
      /* ignore */
    }
  })
}
