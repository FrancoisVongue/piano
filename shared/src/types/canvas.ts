/**
 * Canvas-related constants and types
 */

export namespace Canvas {
  /**
   * Standard dimensions for canvas nodes
   * All nodes should use these consistent sizes for a uniform appearance
   */
  export const NODE_DIMENSIONS = {
    /** Standard width for regular notes */
    WIDTH: 300,
    /** Standard height for regular notes */
    HEIGHT: 200,
    /** Minimum width for group nodes (can be resized larger) */
    GROUP_MIN_WIDTH: 400,
    /** Minimum height for group nodes (can be resized larger) */
    GROUP_MIN_HEIGHT: 300,
  } as const

  /**
   * Default spacing between nodes for auto-layout
   */
  export const NODE_SPACING = {
    /** Horizontal spacing between nodes in left-right layout */
    HORIZONTAL: 80,
    /** Vertical spacing between nodes in top-bottom layout */
    VERTICAL: 160,
    /** Horizontal spacing between sibling child nodes (split actions, Cartesian products) */
    CHILD_SIBLING: 350,
    /** Vertical stagger of a Terminal attached to a Machine. Sits slightly below
     *  its parent's row so it's visually distinct from a sibling Machine, which
     *  shares the parent's Y and is offset by CHILD_SIBLING on X. */
    TERMINAL_BELOW_MACHINE: 80,
  } as const

  /**
   * Viewport defaults
   */
  export const VIEWPORT = {
    /** Default center position when no viewport available */
    DEFAULT_X: 300,
    DEFAULT_Y: 200,
  } as const
}
