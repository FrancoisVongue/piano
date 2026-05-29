const KEY = 'piano:arrangements:last-visited'

type LastVisitedMap = Record<string, number>

const read = (): LastVisitedMap => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}

    const map: LastVisitedMap = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof id === 'string' && typeof value === 'number' && Number.isFinite(value)) {
        map[id] = value
      }
    }
    return map
  } catch {
    return {}
  }
}

const write = (map: LastVisitedMap) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    // best-effort only
  }
}

export const recordVisit = (arrangementId: string) => {
  const map = read()
  map[arrangementId] = Date.now()
  write(map)
}

export const getLastVisitedMap = (): LastVisitedMap => read()

export const pruneStale = (knownIds: Set<string>) => {
  const map = read()
  let changed = false
  for (const id of Object.keys(map)) {
    if (!knownIds.has(id)) {
      delete map[id]
      changed = true
    }
  }
  if (changed) write(map)
}
