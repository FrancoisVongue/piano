/**
 * Z-index registry for the arrangement canvas.
 *
 * Rule of thumb: if you're about to write a magic z-index literal
 * (`zIndex: 9999`, `z-[99999]`, etc.) in a canvas-adjacent component —
 * add a named layer here instead and reference it from both places.
 *
 * How it works:
 *   STACK is an ordered list from BOTTOM to TOP. Each layer reserves
 *   `LAYER_RESERVED` z values, so individual items inside a layer can
 *   sub-order themselves (e.g. dock thumbnails left-to-right via a
 *   bounded index delta) without bleeding into neighbouring layers.
 *
 *   Adding a new layer = insert a string into STACK at the right spot.
 *   Values re-derive automatically. No number collisions.
 *
 * What's NOT in this file:
 *   - Shadcn UI primitives (Dialog, Popover, Tooltip, Dropdown, Sheet).
 *     They render in their own fixed-position portals at `z-50` and
 *     always sit above canvas content. They don't interact with the
 *     canvas stack, so they aren't part of this registry.
 *   - ReactFlow's internal node stacking. ReactFlow creates its own
 *     stacking context at the root; node-level `zIndex` (e.g. the
 *     graph-depth value in Canvas.tsx) is compared only to sibling
 *     nodes inside that context.
 */

const STACK = [
  // Canvas layer — nested z values inside CanvasWindowLayer's own
  // stacking context. These are compared ONLY to each other, but we
  // keep them in one ordered list so the full canvas stack is visible
  // in one place and relative ordering stays obvious.
  'groupOutlineOpen', // dashed outline around an OPEN group (behind members)
  'windowOpen', // open / maximized canvas windows (+ user-facing bumpZ)
  'placementBubble', // cursor bubble shown in node-placement mode
  'windowDock', // dock thumbnails for minimized windows (+ dock index)
  'windowDockLabel', // centered labels above minimized solo windows
  'groupOutlineDock', // outline + label around a FULLY docked group
  'nodeTooltip', // floating hover tooltip above a node card
  'sidebarFlyout', // sidebar arrangement flyout portal (page-level)
] as const

export type ZLayer = (typeof STACK)[number]

/**
 * Width of each layer in z-space. Layers that sub-order their items
 * (e.g. `windowDock` by dock index, `windowOpen` by bumpZ) must stay
 * within this range so they don't collide with the next layer.
 */
export const LAYER_RESERVED = 1000

export const Z: Record<ZLayer, number> = Object.fromEntries(
  STACK.map((name, i) => [name, (i + 1) * LAYER_RESERVED]),
) as Record<ZLayer, number>
