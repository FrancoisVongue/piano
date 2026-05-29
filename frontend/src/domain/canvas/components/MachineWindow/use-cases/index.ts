// Use cases for the MachineWindow surface.
//
// Each use case is a function that reads as a user story:
//   1. peek state (read-only),
//   2. validate (return refused if invalid),
//   3. call services (daemon API),
//   4. apply pure morphism via store primitive,
//   5. return a venum tagged value with named outcomes.
//
// UI callers always end with `match` — no try/catch, no inline branching on
// result.tag. The store stays a state-only primitive; all orchestration
// lives here.

import { venum } from 'venum'
import { MachineWindow as MW } from '@piano/shared'
import { MachineService } from '@/domain/machine/services'
import { useMachineWindowStore, peekLayout, peekFocused } from '../store'

type Edge = 'top' | 'right' | 'bottom' | 'left'

// ---- common ----

const edgeToSplit = (edge: Edge): { dir: 'h' | 'v'; position: 'before' | 'after' } => ({
  dir: edge === 'left' || edge === 'right' ? 'h' : 'v',
  position: edge === 'right' || edge === 'bottom' ? 'after' : 'before',
})

const isMainPty = (paneId: string, parentMachineId: string) => paneId === parentMachineId

// ============================================================
// TABS
// ============================================================

export const setActiveTab = (machineNodeId: string, tabId: string): void => {
  useMachineWindowStore.getState().applyLayout(machineNodeId, l =>
    l.tabs.some(t => t.id === tabId) ? MW.setActiveTab(l, tabId) : l,
  )
  useMachineWindowStore.getState().applyFocus(machineNodeId, (_, l) => {
    const tab = l?.tabs.find(t => t.id === tabId)
    return tab ? MW.firstLeafOf(tab) : null
  })
}

export const renameTab = (machineNodeId: string, tabId: string, name: string): void =>
  useMachineWindowStore.getState().applyLayout(machineNodeId, l => MW.renameTab(l, tabId, name.trim()))

export type NewTabResult =
  | ReturnType<typeof venum<'ok', { tabId: string; paneId: string }>>
  | ReturnType<typeof venum<'error', { message: string }>>

export async function newTab(input: {
  machineNodeId: string
  parentMachineId: string
}): Promise<NewTabResult> {
  const paneId = MW.newId('pane')
  const spawn = await MachineService.spawnPane(input.parentMachineId, paneId)
  if ('error' in spawn) return venum('error', { message: spawn.error.message })
  const store = useMachineWindowStore.getState()
  let newTabId = ''
  store.applyLayout(input.machineNodeId, l => {
    const next = MW.addTab(l, paneId)
    newTabId = next.activeTabId
    return next
  })
  store.applyFocus(input.machineNodeId, () => paneId)
  return venum('ok', { tabId: newTabId, paneId })
}

export type CloseTabResult =
  | ReturnType<typeof venum<'ok', { tabId: string }>>
  | ReturnType<typeof venum<'refused', { reason: string }>>

export async function closeTab(input: {
  machineNodeId: string
  parentMachineId: string
  tabId: string
}): Promise<CloseTabResult> {
  const layout = peekLayout(input.machineNodeId)
  if (!layout) return venum('refused', { reason: 'No layout' })
  if (layout.tabs.length <= 1) return venum('refused', { reason: 'Last tab cannot be closed' })
  const tab = layout.tabs.find(t => t.id === input.tabId)
  if (!tab) return venum('refused', { reason: 'Tab not found' })
  // Tear down daemon panes that the tab owned (except the parent's own PTY).
  const orphans = MW.allPaneIds({ ...layout, tabs: [tab] }).filter(
    id => !isMainPty(id, input.parentMachineId),
  )
  await Promise.allSettled(orphans.map(id => MachineService.closePane(input.parentMachineId, id)))
  const store = useMachineWindowStore.getState()
  store.applyLayout(input.machineNodeId, l => MW.removeTab(l, input.tabId))
  store.applyFocus(input.machineNodeId, (_, l) => {
    const active = l?.tabs.find(t => t.id === l.activeTabId)
    return active ? MW.firstLeafOf(active) : null
  })
  return venum('ok', { tabId: input.tabId })
}

// ============================================================
// PANES — INNER SPLIT (split the focused leaf)
// ============================================================

export type SplitPaneResult =
  | ReturnType<typeof venum<'ok', { newPaneId: string }>>
  | ReturnType<typeof venum<'refused', { reason: string }>>
  | ReturnType<typeof venum<'error', { message: string }>>

export async function splitFocusedPane(input: {
  machineNodeId: string
  parentMachineId: string
  direction: 'h' | 'v'
}): Promise<SplitPaneResult> {
  const layout = peekLayout(input.machineNodeId)
  const focused = peekFocused(input.machineNodeId)
  if (!layout || !focused) return venum('refused', { reason: 'No focused pane' })
  const tabId = MW.findTabContaining(layout, focused)
  if (!tabId) return venum('refused', { reason: 'Focused pane not in any tab' })
  const newPaneId = MW.newId('pane')
  const spawn = await MachineService.spawnPane(input.parentMachineId, newPaneId)
  if ('error' in spawn) return venum('error', { message: spawn.error.message })
  const store = useMachineWindowStore.getState()
  store.applyLayout(input.machineNodeId, l => MW.splitPane(l, tabId, focused, input.direction, newPaneId))
  store.applyFocus(input.machineNodeId, () => newPaneId)
  return venum('ok', { newPaneId })
}

// ============================================================
// PANES — OUTER SPLIT (wrap the whole tab)
// ============================================================

export type SplitTabResult =
  | ReturnType<typeof venum<'ok', { newPaneId: string }>>
  | ReturnType<typeof venum<'error', { message: string }>>

export async function splitTabAtEdge(input: {
  machineNodeId: string
  parentMachineId: string
  edge: Edge
}): Promise<SplitTabResult> {
  const layout = peekLayout(input.machineNodeId)
  if (!layout) return venum('error', { message: 'No layout' })
  const tabId = layout.activeTabId
  const newPaneId = MW.newId('pane')
  const spawn = await MachineService.spawnPane(input.parentMachineId, newPaneId)
  if ('error' in spawn) return venum('error', { message: spawn.error.message })
  const { dir, position } = edgeToSplit(input.edge)
  const store = useMachineWindowStore.getState()
  store.applyLayout(input.machineNodeId, l => MW.splitTab(l, tabId, dir, newPaneId, position))
  store.applyFocus(input.machineNodeId, () => newPaneId)
  return venum('ok', { newPaneId })
}

// ============================================================
// PANES — CLOSE
// ============================================================

export type ClosePaneResult =
  | ReturnType<typeof venum<'ok', { paneId: string }>>
  | ReturnType<typeof venum<'refused', { reason: string }>>
  | ReturnType<typeof venum<'closedTab', { tabId: string }>>

export async function closePane(input: {
  machineNodeId: string
  parentMachineId: string
  paneId: string
}): Promise<ClosePaneResult> {
  if (isMainPty(input.paneId, input.parentMachineId)) {
    return venum('refused', { reason: 'Cannot close the machine\'s main terminal' })
  }
  const layout = peekLayout(input.machineNodeId)
  if (!layout) return venum('refused', { reason: 'No layout' })
  const tabId = MW.findTabContaining(layout, input.paneId)
  if (!tabId) return venum('refused', { reason: 'Pane not found' })
  const tab = layout.tabs.find(t => t.id === tabId)!
  // Last leaf in the tab → close the tab instead. closeTab handles guards.
  if (MW.allPaneIds({ ...layout, tabs: [tab] }).length <= 1) {
    const r = await closeTab({
      machineNodeId: input.machineNodeId,
      parentMachineId: input.parentMachineId,
      tabId,
    })
    if (r.tag === 'refused') return r
    return venum('closedTab', { tabId })
  }
  // Collapse the split + kill the daemon session.
  void MachineService.closePane(input.parentMachineId, input.paneId).catch(() => undefined)
  const store = useMachineWindowStore.getState()
  let nextFocus: string | null = null
  store.applyLayout(input.machineNodeId, l => {
    const r = MW.closePane(l, tabId, input.paneId)
    nextFocus = r.nextFocusedPaneId
    return r.layout
  })
  if (nextFocus) store.applyFocus(input.machineNodeId, () => nextFocus)
  return venum('ok', { paneId: input.paneId })
}

export const closeFocusedPane = (input: { machineNodeId: string; parentMachineId: string }) => {
  const focused = peekFocused(input.machineNodeId)
  if (!focused) return Promise.resolve<ClosePaneResult>(venum('refused', { reason: 'No focused pane' }))
  return closePane({ ...input, paneId: focused })
}

export const setFocusedPane = (machineNodeId: string, paneId: string): void =>
  useMachineWindowStore.getState().applyFocus(machineNodeId, () => paneId)

// Write a split's drag ratio back to the layout so it survives reload.
// `path` walks the tab's pane tree by 'a' (first child) / 'b' (second child).
// PaneTree emits this on every onLayout tick during a drag; the canvas sync
// debounce (2s) collapses the storm into a single patch on release.
export const setSplitRatio = (input: {
  machineNodeId: string
  tabId: string
  path: ('a' | 'b')[]
  ratio: number
}): void =>
  useMachineWindowStore.getState().applyLayout(input.machineNodeId, l =>
    MW.setSplitRatio(l, input.tabId, input.path, input.ratio),
  )

// ============================================================
// PANES — MOVE / IMPORT (no daemon spawn; same paneId travels)
// ============================================================

export type MoveResult =
  | ReturnType<typeof venum<'ok'>>
  | ReturnType<typeof venum<'refused', { reason: string }>>

/** Strip a pane from its current spot in the layout and re-attach it on
 *  the active tab's outer edge. Same paneId throughout — daemon session
 *  keeps running. Refuses when the pane is already the only leaf in its
 *  tab (splitting a tab against itself would duplicate the paneId). */
export const movePaneWithinToEdge = (input: {
  machineNodeId: string
  paneId: string
  edge: Edge
}): MoveResult => {
  const layout = peekLayout(input.machineNodeId)
  if (!layout) return venum('refused', { reason: 'No layout' })
  if (!MW.findTabContaining(layout, input.paneId)) {
    return venum('refused', { reason: 'Pane not found in this window' })
  }
  if (MW.isOnlyLeafInTab(layout, input.paneId)) {
    return venum('refused', { reason: 'Pane already fills the tab' })
  }
  const store = useMachineWindowStore.getState()
  store.applyLayout(input.machineNodeId, l => {
    const detached = MW.detachLeaf(l, input.paneId)
    const { dir, position } = edgeToSplit(input.edge)
    return MW.splitTab(detached, detached.activeTabId, dir, input.paneId, position)
  })
  store.applyFocus(input.machineNodeId, () => input.paneId)
  return venum('ok')
}

/** Strip a pane from its current spot and put it in a brand-new tab.
 *  Refuses when the pane already occupies a tab alone (moving would
 *  just rename the tab — confusing, no real change). */
export const movePaneWithinToTab = (input: {
  machineNodeId: string
  paneId: string
}): MoveResult => {
  const layout = peekLayout(input.machineNodeId)
  if (!layout) return venum('refused', { reason: 'No layout' })
  if (!MW.findTabContaining(layout, input.paneId)) {
    return venum('refused', { reason: 'Pane not found in this window' })
  }
  if (MW.isOnlyLeafInTab(layout, input.paneId)) {
    return venum('refused', { reason: 'Pane is already alone in its tab' })
  }
  const store = useMachineWindowStore.getState()
  store.applyLayout(input.machineNodeId, l => MW.addTab(MW.detachLeaf(l, input.paneId), input.paneId))
  store.applyFocus(input.machineNodeId, () => input.paneId)
  return venum('ok')
}

/** Insert an existing daemon pane as a new tab. No daemon work. */
export const importPaneAsTab = (input: {
  machineNodeId: string
  paneId: string
  name?: string
}): void => {
  const store = useMachineWindowStore.getState()
  store.applyLayout(input.machineNodeId, l => MW.addTab(l, input.paneId, input.name))
  store.applyFocus(input.machineNodeId, () => input.paneId)
}

/** Insert an existing daemon pane on the active tab's outer edge. */
export const importPaneAtEdge = (input: {
  machineNodeId: string
  paneId: string
  edge: Edge
}): void => {
  const store = useMachineWindowStore.getState()
  store.applyLayout(input.machineNodeId, l => {
    const { dir, position } = edgeToSplit(input.edge)
    return MW.splitTab(l, l.activeTabId, dir, input.paneId, position)
  })
  store.applyFocus(input.machineNodeId, () => input.paneId)
}

/** Remove a pane from the layout WITHOUT killing the daemon session.
 *  Used by promote-pane (canvas TERMINAL born from the pane keeps the
 *  same paneId). Goes through detachLeaf so single-leaf tabs are dropped
 *  cleanly — otherwise the pane would phantom-stay in the window after
 *  promotion. */
export const removePaneFromLayout = (machineNodeId: string, paneId: string): void => {
  useMachineWindowStore.getState().applyLayout(machineNodeId, l => MW.detachLeaf(l, paneId))
}

// ============================================================
// DRAWER
// ============================================================

export const toggleDrawer = (machineNodeId: string): void =>
  useMachineWindowStore.getState().applyLayout(machineNodeId, l =>
    MW.setDrawer(l, { open: !l.filesDrawer.open }),
  )

export const setDrawerOpen = (machineNodeId: string, open: boolean): void =>
  useMachineWindowStore.getState().applyLayout(machineNodeId, l => MW.setDrawer(l, { open }))

export const setDrawerPath = (machineNodeId: string, path: string): void =>
  useMachineWindowStore.getState().applyLayout(machineNodeId, l => MW.setDrawer(l, { path }))

// ============================================================
// LIFECYCLE — clean up orphan daemon panes when the MACHINE node dies
// ============================================================

export const cleanupOrphanPanes = (machineNodeId: string, parentMachineId: string): void => {
  const layout = peekLayout(machineNodeId)
  if (!layout) return
  const orphans = MW.allPaneIds(layout).filter(id => !isMainPty(id, parentMachineId))
  for (const id of orphans) {
    void MachineService.closePane(parentMachineId, id).catch(() => undefined)
  }
  useMachineWindowStore.getState().clear(machineNodeId)
}
