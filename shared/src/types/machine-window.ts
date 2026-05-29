import { z } from 'zod'

// MachineWindow holds the in-window layout for a MACHINE node — tabs,
// each tab a tree of panes (terminals), and the files-drawer state.
// Phase 1: tabs only, no splits — every tab's `layout` is a `pane` leaf.
// Phase 2 will exercise the split shape (already typed below to avoid
// schema churn later).
export namespace MachineWindow {
  // A pane references a daemon machine id — the PTY session lives there,
  // we just remember which session is in which slot.
  export type PaneLayout =
    | { kind: 'pane'; paneId: string }
    | {
        kind: 'split'
        dir: 'h' | 'v'
        // Ratio of the FIRST child's size: 0..1.
        ratio: number
        a: PaneLayout
        b: PaneLayout
      }

  export type Tab = {
    id: string
    name?: string
    layout: PaneLayout
  }

  export type FilesDrawer = {
    open: boolean
    path: string
  }

  export type Layout = {
    tabs: Tab[]
    activeTabId: string
    filesDrawer: FilesDrawer
  }

  // ============================================================
  // FACTORIES
  // ============================================================

  export const newId = (prefix: 'tab' | 'pane'): string =>
    `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  // Empty layout: one tab containing one pane that points at the machine
  // itself (the parent machine's own PTY, which already exists).
  export const fromMachineId = (machineId: string): Layout => {
    const tabId = newId('tab')
    return {
      tabs: [
        {
          id: tabId,
          layout: { kind: 'pane', paneId: machineId },
        },
      ],
      activeTabId: tabId,
      filesDrawer: { open: false, path: '' },
    }
  }

  // ============================================================
  // MORPHISMS
  // ============================================================

  export const addTab = (layout: Layout, paneId: string, name?: string): Layout => {
    const tab: Tab = {
      id: newId('tab'),
      name,
      layout: { kind: 'pane', paneId },
    }
    return {
      ...layout,
      tabs: [...layout.tabs, tab],
      activeTabId: tab.id,
    }
  }

  export const removeTab = (layout: Layout, tabId: string): Layout => {
    const remaining = layout.tabs.filter(t => t.id !== tabId)
    if (remaining.length === 0) return layout // last tab, refuse to remove
    const stillActive = remaining.some(t => t.id === layout.activeTabId)
    const fallback = remaining[remaining.length - 1]
    return {
      ...layout,
      tabs: remaining,
      activeTabId: stillActive ? layout.activeTabId : (fallback?.id ?? layout.activeTabId),
    }
  }

  export const setActiveTab = (layout: Layout, tabId: string): Layout =>
    layout.tabs.some(t => t.id === tabId) ? { ...layout, activeTabId: tabId } : layout

  export const renameTab = (layout: Layout, tabId: string, name: string): Layout => ({
    ...layout,
    tabs: layout.tabs.map(t => (t.id === tabId ? { ...t, name } : t)),
  })

  export const setDrawer = (layout: Layout, patch: Partial<FilesDrawer>): Layout => ({
    ...layout,
    filesDrawer: { ...layout.filesDrawer, ...patch },
  })

  // ---------- Pane-level morphisms (within a single tab's tree) ----------

  // Walk a pane tree, replacing the leaf with paneId via `replace`.
  // Returns the (possibly unchanged) tree.
  const replaceLeaf = (
    p: PaneLayout,
    paneId: string,
    replace: (leaf: { kind: 'pane'; paneId: string }) => PaneLayout,
  ): PaneLayout => {
    if (p.kind === 'pane') return p.paneId === paneId ? replace(p) : p
    return { ...p, a: replaceLeaf(p.a, paneId, replace), b: replaceLeaf(p.b, paneId, replace) }
  }

  // Walk a pane tree, removing a leaf with paneId. When a split's child is
  // removed, the split collapses to its surviving child. Returns null if the
  // entire tree was a single leaf with this paneId.
  const removeLeaf = (p: PaneLayout, paneId: string): PaneLayout | null => {
    if (p.kind === 'pane') return p.paneId === paneId ? null : p
    const a = removeLeaf(p.a, paneId)
    const b = removeLeaf(p.b, paneId)
    if (a == null && b == null) return null
    if (a == null) return b
    if (b == null) return a
    return { ...p, a, b }
  }

  // List every leaf in tree order — used to pick a fallback focus target
  // after closing the focused pane.
  const leavesOf = (p: PaneLayout): string[] => {
    if (p.kind === 'pane') return [p.paneId]
    return [...leavesOf(p.a), ...leavesOf(p.b)]
  }

  // Wrap an entire tab's layout in an outer split. Use this when the user
  // wants a new pane on an OUTER edge (e.g. "add a terminal that spans the
  // whole bottom even though the tab already has a left/right split").
  // splitPane handles the inner case; splitTab handles the outer case.
  //
  // position='after' = new pane on the RIGHT (h) or BOTTOM (v).
  // position='before' = new pane on the LEFT (h) or TOP (v).
  // ratio applies to the FIRST child as usual.
  export const splitTab = (
    layout: Layout,
    tabId: string,
    dir: 'h' | 'v',
    newPaneId: string,
    position: 'before' | 'after' = 'after',
    ratio = 0.5,
  ): Layout => ({
    ...layout,
    tabs: layout.tabs.map(tab => {
      if (tab.id !== tabId) return tab
      const newLeaf: PaneLayout = { kind: 'pane', paneId: newPaneId }
      const wrapped: PaneLayout =
        position === 'after'
          ? { kind: 'split', dir, ratio, a: tab.layout, b: newLeaf }
          : { kind: 'split', dir, ratio, a: newLeaf, b: tab.layout }
      return { ...tab, layout: wrapped }
    }),
  })

  // Split the leaf with `paneId` into a new split node. The original pane
  // becomes child A; `newPaneId` becomes child B. Direction: 'h' = side by
  // side, 'v' = stacked. Ratio defaults to 0.5 (even split).
  export const splitPane = (
    layout: Layout,
    tabId: string,
    paneId: string,
    dir: 'h' | 'v',
    newPaneId: string,
    ratio = 0.5,
  ): Layout => ({
    ...layout,
    tabs: layout.tabs.map(tab => {
      if (tab.id !== tabId) return tab
      return {
        ...tab,
        layout: replaceLeaf(tab.layout, paneId, leaf => ({
          kind: 'split',
          dir,
          ratio,
          a: leaf,
          b: { kind: 'pane', paneId: newPaneId },
        })),
      }
    }),
  })

  // Close a pane within a tab. If it's the last pane in the tab, the tab
  // is left with that pane (caller should call removeTab to drop the tab).
  // Returns the next layout AND the next focus suggestion (some sibling
  // leaf, or null if the tab is now effectively empty).
  export const closePane = (
    layout: Layout,
    tabId: string,
    paneId: string,
  ): { layout: Layout; nextFocusedPaneId: string | null } => {
    let nextFocus: string | null = null
    const tabs = layout.tabs.map(tab => {
      if (tab.id !== tabId) return tab
      const removed = removeLeaf(tab.layout, paneId)
      if (removed == null) return tab // refuse: can't empty a tab via closePane
      const survivors = leavesOf(removed)
      nextFocus = survivors[0] ?? null
      return { ...tab, layout: removed }
    })
    return { layout: { ...layout, tabs }, nextFocusedPaneId: nextFocus }
  }

  // Find the tab id that contains a given paneId — used by the UI when the
  // user splits via a hotkey and we need to know which tab to mutate.
  export const findTabContaining = (layout: Layout, paneId: string): string | null => {
    for (const tab of layout.tabs) {
      if (leavesOf(tab.layout).includes(paneId)) return tab.id
    }
    return null
  }

  // First leaf of a tab (e.g. for choosing which pane is focused by default).
  export const firstLeafOf = (tab: Tab): string | null => leavesOf(tab.layout)[0] ?? null

  // True when the named pane is the only leaf in its tab. Move operations
  // use this to refuse "outer split against self" (which would duplicate
  // the paneId in both children of the new split).
  export const isOnlyLeafInTab = (layout: Layout, paneId: string): boolean => {
    const tabId = findTabContaining(layout, paneId)
    if (!tabId) return false
    const tab = layout.tabs.find(t => t.id === tabId)
    if (!tab) return false
    return allPaneIds({ ...layout, tabs: [tab] }).length === 1
  }

  // Detach a leaf from the layout for MOVE operations. Unlike closePane
  // (which is the interactive "close pane" button and refuses to empty a
  // tab so the user always has something to look at), detachLeaf is
  // explicitly the morphism for "I'm taking this pane elsewhere":
  //   - leaf in a split → split collapses around the sibling.
  //   - only leaf in tab → the whole tab is dropped.
  //   - only leaf in only tab → can't detach (removeTab refuses last tab);
  //     callers should treat this as a no-op and refuse the move.
  export const detachLeaf = (layout: Layout, paneId: string): Layout => {
    const tabId = findTabContaining(layout, paneId)
    if (!tabId) return layout
    const tab = layout.tabs.find(t => t.id === tabId)
    if (!tab) return layout
    if (allPaneIds({ ...layout, tabs: [tab] }).length === 1) {
      return removeTab(layout, tabId)
    }
    return closePane(layout, tabId, paneId).layout
  }

  // Update a split's ratio at `path` (a sequence of 'a'/'b' steps from the
  // tab's root). No-op when the path is empty, doesn't terminate at a split,
  // or runs off the tree. Ratio is clamped to [0.05, 0.95] to match the
  // PaneTree minSize so we never persist a value the UI would reject.
  export const setSplitRatio = (
    layout: Layout,
    tabId: string,
    path: ('a' | 'b')[],
    ratio: number,
  ): Layout => {
    if (path.length === 0) return layout
    const clamped = Math.max(0.05, Math.min(0.95, ratio))
    const walk = (p: PaneLayout, depth: number): PaneLayout => {
      if (p.kind !== 'split') return p
      if (depth === path.length - 1) return { ...p, ratio: clamped }
      const step = path[depth]
      if (step !== 'a' && step !== 'b') return p
      return { ...p, [step]: walk(p[step], depth + 1) }
    }
    return {
      ...layout,
      tabs: layout.tabs.map(tab =>
        tab.id === tabId ? { ...tab, layout: walk(tab.layout, 0) } : tab,
      ),
    }
  }

  // Collect every paneId across every tab — used when closing the window
  // to know which daemon panes to clean up.
  export const allPaneIds = (layout: Layout): string[] => {
    const out: string[] = []
    const walk = (p: PaneLayout): void => {
      if (p.kind === 'pane') out.push(p.paneId)
      else {
        walk(p.a)
        walk(p.b)
      }
    }
    layout.tabs.forEach(t => walk(t.layout))
    return out
  }

  // ============================================================
  // VALIDATION (boundary)
  // ============================================================

  // Recursive zod is awkward; we describe it lazily.
  const PaneLayoutSchema: z.ZodType<PaneLayout> = z.lazy(() =>
    z.union([
      z.object({ kind: z.literal('pane'), paneId: z.string().min(1) }),
      z.object({
        kind: z.literal('split'),
        dir: z.enum(['h', 'v']),
        ratio: z.number().min(0).max(1),
        a: PaneLayoutSchema,
        b: PaneLayoutSchema,
      }),
    ]),
  )

  export const LayoutSchema = z.object({
    tabs: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().max(128).optional(),
        layout: PaneLayoutSchema,
      }),
    ).min(1),
    activeTabId: z.string().min(1),
    filesDrawer: z.object({
      open: z.boolean(),
      path: z.string().max(4096),
    }),
  })

  export const validate = {
    layout: (input: unknown): Layout => LayoutSchema.parse(input),
  }
}
