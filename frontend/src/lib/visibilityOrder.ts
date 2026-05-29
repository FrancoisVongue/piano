interface WithId {
  id: string
}

/**
 * Slice a flat list into visible (ordered by `visibleIds`) and hidden items.
 * `visibleIds === undefined` means "no override yet" — every item shows up
 * in its natural order. The list is the authoritative source of BOTH
 * visibility AND order: missing id ⇒ hidden, position ⇒ rank.
 *
 * Pure & framework-free — used by both React components (popover lists) and
 * canvas hooks (hotkey index → visibleItems[i]). One algorithm, one place.
 */
export function partitionByVisibility<T extends WithId>(
  allItems: T[],
  visibleIds: string[] | undefined,
): { visible: T[]; hidden: T[] } {
  const ids = visibleIds ?? allItems.map(i => i.id)
  const orderMap = new Map(ids.map((id, i) => [id, i]))
  const visible = allItems
    .filter(i => orderMap.has(i.id))
    .sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0))
  const visibleSet = new Set(visible.map(i => i.id))
  const hidden = allItems.filter(i => !visibleSet.has(i.id))
  return { visible, hidden }
}
