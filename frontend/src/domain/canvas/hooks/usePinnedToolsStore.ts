import { create } from 'zustand'

/**
 * Global store for which node-card tools are pinned to the quick-access
 * header row. Shared across every NoteCard instance (and every arrangement)
 * so toggling a pin on one node is reflected everywhere immediately.
 *
 * Persisted to localStorage; the previous implementation stored the same key
 * but read it into per-component useState, which meant other already-mounted
 * cards never saw updates until remount.
 */

const STORAGE_KEY = 'piano:pinnedNodeTools'
// IDs must match entries in NODE_ACTIONS (see lib/node-actions.tsx).
// Machine infra actions (forward-ports, create-terminal, open-windsurf) are
// pinned by default so a fresh machine card shows the same inline controls
// users had before the unified-registry refactor. The quickbar already
// filters by action.show(ctx) — note/text nodes never render these.
const DEFAULT_PINNED_TOOLS = [
  'copy-content',
  'paste',
  'forward-ports',
  'create-terminal',
  'open-windsurf',
]

// Migrate legacy IDs to current NODE_ACTIONS ids so users keep their pins
// after the unification. 'copy' was the old NoteCard NodeTool id; it maps
// to 'copy-content' in the unified registry.
const LEGACY_ID_MAP: Record<string, string> = {
  copy: 'copy-content',
}

function migrate(ids: string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    const next = LEGACY_ID_MAP[id] ?? id
    if (!out.includes(next)) out.push(next)
  }
  return out
}

function loadFromStorage(): string[] {
  if (typeof window === 'undefined') return DEFAULT_PINNED_TOOLS
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return DEFAULT_PINNED_TOOLS
    const parsed = JSON.parse(stored)
    if (!Array.isArray(parsed)) return DEFAULT_PINNED_TOOLS
    return migrate(parsed as string[])
  } catch {
    return DEFAULT_PINNED_TOOLS
  }
}

function saveToStorage(ids: string[]) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* ignore quota errors */
  }
}

interface PinnedToolsState {
  pinnedToolIds: string[]
  toggle: (id: string) => void
  set: (ids: string[]) => void
}

export const usePinnedToolsStore = create<PinnedToolsState>((set, get) => ({
  pinnedToolIds: loadFromStorage(),
  toggle: (id) => {
    const current = get().pinnedToolIds
    const next = current.includes(id)
      ? current.filter((v) => v !== id)
      : [...current, id]
    saveToStorage(next)
    set({ pinnedToolIds: next })
  },
  set: (ids) => {
    saveToStorage(ids)
    set({ pinnedToolIds: ids })
  },
}))

// Cross-tab sync: if the user toggles a pin in another tab, reflect it here.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || e.newValue == null) return
    try {
      const parsed = JSON.parse(e.newValue)
      if (Array.isArray(parsed)) {
        usePinnedToolsStore.setState({ pinnedToolIds: parsed })
      }
    } catch {
      /* ignore */
    }
  })
}
