'use client'

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { subscribeWithSelector } from 'zustand/middleware'
import { MachineWindow as MW } from '@piano/shared'

// STATE PRIMITIVE — nothing else.
//
// A store holds state and exposes setters; it never talks to services or
// contains business logic. Everything richer (spawn pane, outer-split,
// demote terminal, drop dispatch) lives in use-cases/ and composes services
// with these primitives.
//
// Three concerns, two pieces of state, three primitives:
//   layouts[machineNodeId]   — persisted in arrangement
//   focused[machineNodeId]   — ephemeral, drives hotkey targeting
//   applyLayout / applyFocus / ensure-hydrate-clear

type State = {
  layouts: Record<string, MW.Layout>
  focused: Record<string, string>

  /** Ensure a layout exists for `machineNodeId`; seed from `machineId` if not. */
  ensure: (machineNodeId: string, machineId: string) => MW.Layout

  /** Replace the layout (used by the persistence hydrator after canvas load). */
  hydrate: (machineNodeId: string, layout: MW.Layout) => void

  /** Forget everything for `machineNodeId` (e.g. when the MACHINE node is deleted). */
  clear: (machineNodeId: string) => void

  /** Apply a pure morphism to the layout. The morphism returns a fresh
   *  Layout; we swap it in. Use-cases call this after their service work. */
  applyLayout: (machineNodeId: string, morphism: (layout: MW.Layout) => MW.Layout) => void

  /** Apply a pure morphism to the focused-pane id. The morphism gets the
   *  current focus and the current layout (handy for "focus the first leaf
   *  of the active tab" computations). */
  applyFocus: (
    machineNodeId: string,
    morphism: (focusedPaneId: string | null, layout: MW.Layout | undefined) => string | null,
  ) => void
}

export const useMachineWindowStore = create<State>()(
  subscribeWithSelector(
    immer(set => ({
      layouts: {},
      focused: {},

      ensure: (machineNodeId, machineId) => {
        const existing = useMachineWindowStore.getState().layouts[machineNodeId]
        if (existing) return existing
        const fresh = MW.fromMachineId(machineId)
        set(state => {
          state.layouts[machineNodeId] = fresh
          state.focused[machineNodeId] = machineId
        })
        return fresh
      },

      hydrate: (machineNodeId, layout) => {
        set(state => {
          state.layouts[machineNodeId] = layout
          const activeTab = layout.tabs.find(t => t.id === layout.activeTabId) ?? layout.tabs[0]
          const first = activeTab ? MW.firstLeafOf(activeTab) : null
          if (first) state.focused[machineNodeId] = first
        })
      },

      clear: machineNodeId => {
        set(state => {
          delete state.layouts[machineNodeId]
          delete state.focused[machineNodeId]
        })
      },

      applyLayout: (machineNodeId, morphism) => {
        set(state => {
          const current = state.layouts[machineNodeId]
          if (!current) return
          // immer's draft is a proxy — we replace the slot with the morphism
          // output. Because immer detects the slot reassignment, downstream
          // subscribers see a fresh top-level layout reference (which is
          // exactly what usePersistMachineLayouts uses as the change signal).
          state.layouts[machineNodeId] = morphism(current) as MW.Layout
        })
      },

      applyFocus: (machineNodeId, morphism) => {
        set(state => {
          const next = morphism(state.focused[machineNodeId] ?? null, state.layouts[machineNodeId])
          if (next == null) delete state.focused[machineNodeId]
          else state.focused[machineNodeId] = next
        })
      },
    })),
  ),
)

// Synchronous peekers — use-cases call these to read current state without
// subscribing. They're not part of the store interface because they read
// the snapshot directly; no immer / proxy concerns.
export const peekLayout = (machineNodeId: string): MW.Layout | undefined =>
  useMachineWindowStore.getState().layouts[machineNodeId]

export const peekFocused = (machineNodeId: string): string | null =>
  useMachineWindowStore.getState().focused[machineNodeId] ?? null
